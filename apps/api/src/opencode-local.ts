import { createHash } from 'node:crypto';
import type { LanguageModel, ModelMessage } from 'ai';
import { savedOpenCodeAccountKey } from './zen.js';
import { openCodeCatalog, resolveAuth, resolveModel } from './opencode-catalog.js';

const providers = new Map<string, { expires: number; language: Promise<LanguageModel> }>();
const MAX_PROVIDERS = 64;
const runtimeSessions = new Map<string, string>();
const MAX_RUNTIME_SESSIONS = 256;
const TRANSIENT_RUNTIME_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RUNTIME_WAKE_TIMEOUT_MS = 150_000;
const DEFAULT_RUNTIME_WAKE_POLL_MS = 2_000;
const RUNTIME_PREWARM_TTL_MS = 5 * 60_000;
let runtimePrewarmAt = 0;
let runtimePrewarmPromise: Promise<boolean> | null = null;

export function resetOpenCodeRuntimeSessionsForTests(): void {
  runtimeSessions.clear();
  runtimePrewarmAt = 0;
  runtimePrewarmPromise = null;
}

async function initialize(npm: string, baseURL: string, apiKey: string, id: string): Promise<LanguageModel> {
  const options = { name: 'opencode', baseURL, apiKey };
  switch (npm) {
    case '@ai-sdk/openai':
      return (await import('@ai-sdk/openai')).createOpenAI(options).languageModel(id);
    case '@ai-sdk/anthropic':
      return (await import('@ai-sdk/anthropic')).createAnthropic(options).languageModel(id);
    case '@ai-sdk/google':
      return (await import('@ai-sdk/google')).createGoogleGenerativeAI(options).languageModel(id);
    case '@ai-sdk/openai-compatible':
      return (await import('@ai-sdk/openai-compatible')).createOpenAICompatible({ ...options, includeUsage: true }).languageModel(id);
    default:
      throw new Error(`The selected model requires provider package ${npm}, which is not installed in Orlynx.`);
  }
}

export async function verifyProviderRuntime(): Promise<void> {
  // Literal imports are resolved through real API production dependencies. This
  // runs against compiled JS in CI and Render, not just against TypeScript.
  await Promise.all([
    import('ai'), import('@ai-sdk/openai'), import('@ai-sdk/openai-compatible'),
    import('@ai-sdk/anthropic'), import('@ai-sdk/google'),
  ]);
}

export async function warmOpenCodeProviderLayer(): Promise<void> {
  openCodeCatalog();
  await verifyProviderRuntime();
}

export class ProviderRequestError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly publicAccess = false) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

function safeProviderError(error: unknown, publicAccess: boolean): ProviderRequestError {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number(error.statusCode) : undefined;
  const validStatus = status && Number.isFinite(status) ? status : undefined;
  // Provider errors may embed request bodies or headers; never send those into
  // the event ledger/browser/logs. Retain only the numeric upstream status.
  const message = validStatus === 429 ? 'The selected model is temporarily rate limited (HTTP 429).'
    : validStatus === 401 && !publicAccess ? 'OpenCode rejected the saved credential (HTTP 401). Reconnect OpenCode.'
    : validStatus === 401 || validStatus === 403 ? `OpenCode rejected ${publicAccess ? 'public access' : 'this request'} (HTTP ${validStatus}).`
    : validStatus === 404 ? 'The selected model is temporarily unavailable (HTTP 404).'
    : validStatus ? `The model provider returned HTTP ${validStatus}.`
    : 'The connection to the model failed or timed out. Try again.';
  return new ProviderRequestError(message, validStatus, publicAccess);
}

function runtimeConfig(): { baseURL: string; authorization: string } {
  const baseURL = String(process.env.ORLYNX_OPENCODE_RUNTIME_URL || '').replace(/\/$/, '');
  const username = String(process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME || 'orlynx');
  const password = String(process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD || '');
  if (!baseURL || !password) {
    throw new ProviderRequestError('The OpenCode free-model runtime is not configured.', 503, true);
  }
  return {
    baseURL,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

function runtimeEventData(frame: string): any | undefined {
  const payload = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!payload || payload === '[DONE]') return undefined;
  try { return JSON.parse(payload); } catch { return undefined; }
}

async function runtimeFetch(
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 90_000,
): Promise<Response> {
  const { baseURL, authorization } = runtimeConfig();
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  return fetch(`${baseURL}${pathname}`, {
    ...init,
    signal,
    headers: {
      Authorization: authorization,
      'x-opencode-directory': '/tmp',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

export function warmOpenCodeRuntime(): Promise<boolean> {
  const now = Date.now();
  if (runtimePrewarmPromise) return runtimePrewarmPromise;
  if (now - runtimePrewarmAt < RUNTIME_PREWARM_TTL_MS) return Promise.resolve(true);

  runtimePrewarmPromise = (async () => {
    try {
      const response = await runtimeFetch('/global/health', {
        headers: { Accept: 'application/json' },
      }, 20_000);
      if (response.ok) {
        runtimePrewarmAt = Date.now();
        return true;
      }
      // Even a transient edge response is useful because the request starts
      // Render's cold-start path. The normal chat path will poll until ready.
      return false;
    } catch {
      // Prewarming is best-effort and must never break catalog/overview calls.
      return false;
    } finally {
      runtimePrewarmPromise = null;
    }
  })();
  return runtimePrewarmPromise;
}

function runtimeError(status: number, prefix = 'OpenCode runtime'): ProviderRequestError {
  const message = status === 401
    ? `${prefix} authentication failed (HTTP 401).`
    : status === 403
      ? `${prefix} rejected the request (HTTP 403).`
      : `${prefix} returned HTTP ${status}.`;
  return new ProviderRequestError(message, status, true);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForRuntimeReady(
  signal: AbortSignal,
  onStatus?: (message: string) => void,
  onTiming?: (stage: string, ms: number) => void,
): Promise<void> {
  const started = performance.now();
  const configuredTimeout = Number(process.env.ORLYNX_OPENCODE_RUNTIME_WAKE_TIMEOUT_MS || DEFAULT_RUNTIME_WAKE_TIMEOUT_MS);
  const configuredPoll = Number(process.env.ORLYNX_OPENCODE_RUNTIME_WAKE_POLL_MS || DEFAULT_RUNTIME_WAKE_POLL_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(5_000, configuredTimeout) : DEFAULT_RUNTIME_WAKE_TIMEOUT_MS;
  const pollMs = Number.isFinite(configuredPoll) ? Math.max(0, configuredPoll) : DEFAULT_RUNTIME_WAKE_POLL_MS;
  let announced = false;
  let lastStatus: number | undefined;

  while (performance.now() - started < timeoutMs) {
    signal.throwIfAborted();
    try {
      const response = await runtimeFetch('/global/health', {
        headers: { Accept: 'application/json' },
        signal,
      }, Math.min(12_000, timeoutMs));
      if (response.ok) {
        onTiming?.('runtimeReadyMs', performance.now() - started);
        return;
      }
      lastStatus = response.status;
      if (!TRANSIENT_RUNTIME_STATUSES.has(response.status)) throw runtimeError(response.status);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ProviderRequestError && error.statusCode && !TRANSIENT_RUNTIME_STATUSES.has(error.statusCode)) {
        throw error;
      }
    }

    if (!announced) {
      announced = true;
      onStatus?.('Starting AI runtime…');
    }
    await wait(pollMs, signal);
  }

  throw new ProviderRequestError(
    lastStatus
      ? `OpenCode runtime remained unavailable (HTTP ${lastStatus}).`
      : 'OpenCode runtime did not become ready in time.',
    lastStatus || 503,
    true,
  );
}

async function runtimeJson<T>(pathname: string, init: RequestInit = {}, timeoutMs = 90_000): Promise<T> {
  const response = await runtimeFetch(pathname, init, timeoutMs);
  if (!response.ok) {
    // Do not forward remote response bodies: they may contain provider,
    // request, or authentication diagnostics that belong only in the runtime.
    throw runtimeError(response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function getOrCreateRuntimeSession(runtimeKey: string, signal: AbortSignal): Promise<{ id: string; fresh: boolean }> {
  const cached = runtimeSessions.get(runtimeKey);
  if (cached) {
    try {
      await runtimeJson<any>(`/session/${encodeURIComponent(cached)}`, { signal }, 10_000);
      return { id: cached, fresh: false };
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.statusCode !== 404) throw error;
      runtimeSessions.delete(runtimeKey);
    }
  }

  const title = `Orlynx ${runtimeKey}`;
  const query = new URLSearchParams({ search: title, limit: '20' });
  const sessions = await runtimeJson<any[]>(`/session?${query.toString()}`, { signal }, 10_000).catch(() => []);
  // Only sessions created by the clean session-based adapter are safe to
  // recover. Older title-only sessions may contain the legacy flattened
  // "Conversation so far" prompt and must not be reused.
  const existing = sessions.find((session) =>
    session?.metadata?.orlynxConversationId === runtimeKey
  );
  const sessionID = String(existing?.id || '');
  if (sessionID) {
    if (runtimeSessions.size >= MAX_RUNTIME_SESSIONS) runtimeSessions.delete(runtimeSessions.keys().next().value!);
    runtimeSessions.set(runtimeKey, sessionID);
    return { id: sessionID, fresh: false };
  }

  const created = await runtimeJson<any>('/session', {
    method: 'POST',
    body: JSON.stringify({
      title,
      metadata: {
        orlynxConversationId: runtimeKey,
        source: 'orlynx-direct-chat',
      },
    }),
    signal,
  });
  const createdID = String(created?.id || '');
  if (!createdID) throw new ProviderRequestError('OpenCode runtime did not create a session.', 502, true);
  if (runtimeSessions.size >= MAX_RUNTIME_SESSIONS) runtimeSessions.delete(runtimeSessions.keys().next().value!);
  runtimeSessions.set(runtimeKey, createdID);
  return { id: createdID, fresh: true };
}

function recoveryHistory(messages: { role: 'user' | 'assistant'; content: string }[]): string {
  const previous = messages.slice(0, -1).slice(-12)
    .map((message) => ({ role: message.role, content: message.content.slice(-8_000) }));
  if (!previous.length) return '';
  return [
    'The OpenCode runtime session was recreated, so restore conversational continuity from this private Orlynx history.',
    'Treat this as hidden context only. Do not quote, expose, summarize, or mention this wrapper unless the user explicitly asks about prior conversation content.',
    `<orlynx_durable_history_json>${JSON.stringify(previous)}</orlynx_durable_history_json>`,
  ].join('\n');
}

async function streamFreeModelThroughOpenCodeRuntime(input: {
  runtimeKey: string;
  requestId?: string;
  modelId: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
  onTiming?: (stage: string, ms: number) => void;
}): Promise<string> {
  const started = performance.now();
  input.signal.throwIfAborted();
  await waitForRuntimeReady(input.signal, input.onStatus, input.onTiming);
  input.onStatus?.('Thinking…');

  let session = await getOrCreateRuntimeSession(input.runtimeKey, input.signal);
  let sessionID = session.id;
  let turnSystem = session.fresh
    ? [input.system, recoveryHistory(input.messages)].filter(Boolean).join('\n\n')
    : input.system;
  input.onTiming?.('providerInitMs', performance.now() - started);

  const eventResponse = await runtimeFetch('/event', {
    headers: { Accept: 'text/event-stream' },
    signal: input.signal,
  }, 5 * 60_000);
  if (!eventResponse.ok || !eventResponse.body) {
    throw new ProviderRequestError(`OpenCode event stream returned HTTP ${eventResponse.status}.`, eventResponse.status, true);
  }

  const prompt = [...input.messages].reverse().find((message) => message.role === 'user')?.content.trim() || '';
  if (!prompt) throw new ProviderRequestError('No user message was available for this turn.', 400, true);

  const requested = performance.now();
  const submitPrompt = (targetSessionID: string, system: string) => runtimeJson<void>(
    `/session/${encodeURIComponent(targetSessionID)}/prompt_async`,
    {
      method: 'POST',
      body: JSON.stringify({
        model: { providerID: 'opencode', modelID: input.modelId.replace(/^opencode\//, '') },
        agent: 'plan',
        system,
        parts: [{ type: 'text', text: prompt }],
      }),
      signal: input.signal,
    },
    30_000,
  );

  try {
    await submitPrompt(sessionID, turnSystem);
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || error.statusCode !== 404) throw error;
    // A 404 means the cached OpenCode session disappeared before the prompt was
    // admitted (for example after a free Render runtime restart). Recreate it
    // once and restore context from Orlynx's durable conversation store.
    runtimeSessions.delete(input.runtimeKey);
    session = await getOrCreateRuntimeSession(input.runtimeKey, input.signal);
    sessionID = session.id;
    turnSystem = [input.system, recoveryHistory(input.messages)].filter(Boolean).join('\n\n');
    await submitPrompt(sessionID, turnSystem);
  }
  input.onTiming?.('modelRequestStartedMs', performance.now() - started);

  const abortRemote = () => {
    void runtimeFetch(`/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST' }, 3_000).catch(() => {});
  };
  input.signal.addEventListener('abort', abortRemote, { once: true });

  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let first = true;
  let remoteError = '';
  let done = false;

  const append = (delta: string) => {
    if (!delta) return;
    if (first) {
      first = false;
      input.onTiming?.('timeToFirstTokenMs', performance.now() - requested);
    }
    full += delta;
    input.onDelta(delta);
  };

  try {
    while (!done) {
      input.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const event = runtimeEventData(frame);
        if (!event || typeof event !== 'object') continue;
        const type = String(event.type || '');
        const properties = event.properties || {};
        const eventSession = String(
          properties.sessionID
          || properties.part?.sessionID
          || properties.info?.sessionID
          || '',
        );
        if (eventSession && eventSession !== sessionID) continue;

        if (type === 'message.part.delta') {
          if (!properties.field || properties.field === 'text') append(String(properties.delta || ''));
          continue;
        }

        if (type === 'message.part.updated' && properties.part?.type === 'text') {
          const text = String(properties.part.text || '');
          if (text && text.startsWith(full)) append(text.slice(full.length));
          continue;
        }

        if (type === 'session.error') {
          remoteError = String(
            properties.error?.data?.message
            || properties.error?.message
            || properties.error?.name
            || 'OpenCode session failed.',
          );
          continue;
        }

        if (
          (type === 'session.status' && properties.status?.type === 'idle')
          || type === 'session.idle'
        ) {
          done = true;
          break;
        }
      }
    }
  } finally {
    input.signal.removeEventListener('abort', abortRemote);
    try { await reader.cancel(); } catch {}
    input.onTiming?.('providerTotalMs', performance.now() - started);
  }

  input.signal.throwIfAborted();
  if (remoteError) throw new ProviderRequestError(remoteError, undefined, true);
  if (full.trim()) return full;

  const messages = await runtimeJson<any[]>(
    `/session/${encodeURIComponent(sessionID)}/message?limit=10`,
    { signal: input.signal },
    15_000,
  ).catch(() => []);
  const latest = [...messages].reverse().find((item) => item?.info?.role === 'assistant');
  const finalText = Array.isArray(latest?.parts)
    ? latest.parts.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text || '')).join('')
    : '';
  if (!finalText.trim()) throw new ProviderRequestError('OpenCode returned no visible text.', 502, true);
  append(finalText);
  return finalText;
}


export async function streamWithOfficialOpenCode(input: {
  runtimeKey: string;
  requestId?: string;
  userId: string;
  modelId: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
  onTiming?: (stage: string, ms: number) => void;
}): Promise<string> {
  input.signal.throwIfAborted();
  const started = performance.now();
  const resolved = resolveModel(openCodeCatalog(), input.modelId);

  // OpenCode's free tier must be invoked from an actual OpenCode process.
  // Plan/Ask uses the dedicated OpenCode runtime service; catalog/overview
  // requests prewarm it so normal chat does not carry OpenCode in the main API
  // process or require a Codespace.
  if (resolved.free) {
    return streamFreeModelThroughOpenCodeRuntime({
      runtimeKey: input.runtimeKey,
      requestId: input.requestId,
      modelId: input.modelId,
      system: input.system,
      messages: input.messages,
      signal: input.signal,
      onDelta: input.onDelta,
      onStatus: input.onStatus,
      onTiming: input.onTiming,
    });
  }

  let savedKey: string | undefined;
  try {
    savedKey = await savedOpenCodeAccountKey(input.userId);
  } catch {
    throw new ProviderRequestError('Your saved OpenCode connection can no longer be decrypted. Reconnect OpenCode to use paid models.', 401, false);
  }

  const auth = resolveAuth(false, savedKey);
  input.signal.throwIfAborted();
  // Scope cached clients to user + credential fingerprint. Rotation cannot reuse
  // the old client. Never log this fingerprint or the credential.
  const fingerprint = createHash('sha256').update(auth.apiKey).digest('hex');
  const cacheKey = JSON.stringify([input.userId, fingerprint, resolved.npm, resolved.baseURL, resolved.id]);
  let cached = providers.get(cacheKey);
  if (!cached || cached.expires < Date.now()) {
    if (providers.size >= MAX_PROVIDERS) providers.delete(providers.keys().next().value!);
    const language = initialize(resolved.npm, resolved.baseURL, auth.apiKey, resolved.id);
    cached = { expires: Date.now() + 10 * 60_000, language };
    providers.set(cacheKey, cached);
    void language.catch(() => providers.delete(cacheKey));
  }
  const [{ streamText }, model] = await Promise.all([import('ai'), cached.language]);
  input.signal.throwIfAborted();
  input.onTiming?.('providerInitMs', performance.now() - started);
  input.onStatus?.('Thinking…');
  const requested = performance.now();
  input.onTiming?.('modelRequestStartedMs', requested - started);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60_000)]);
  let full = '';
  let first = true;
  try {
    const result = streamText({
      model,
      system: input.system,
      messages: input.messages as ModelMessage[],
      abortSignal: signal,
      maxRetries: 2,
      maxOutputTokens: Math.min(resolved.model.limit?.output || 8192, 8192),
      // Text-only direct chat uses the provider defaults for reasoning. No
      // guessed model-name switches or forced high reasoning budgets.
      providerOptions: resolved.npm === '@ai-sdk/openai'
        ? { openai: { store: false, promptCacheKey: input.runtimeKey } } : undefined,
      headers: { 'x-opencode-session': input.runtimeKey, 'x-opencode-request': input.requestId || input.runtimeKey, 'x-opencode-client': 'orlynx', 'User-Agent': 'orlynx/1.0' },
    });
    for await (const part of result.fullStream) {
      input.signal.throwIfAborted();
      if (part.type === 'error') throw part.error;
      if (part.type === 'abort') throw signal.reason || new Error('Aborted');
      if (part.type !== 'text-delta' || !part.text) continue;
      if (first) { first = false; input.onTiming?.('timeToFirstTokenMs', performance.now() - requested); }
      full += part.text;
      input.onDelta(part.text);
    }
    input.signal.throwIfAborted();
    if (!full.trim()) throw new ProviderRequestError('The selected model returned no visible text.', undefined, auth.publicAccess);
    return full;
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof ProviderRequestError) throw error;
    throw safeProviderError(error, auth.publicAccess);
  } finally {
    input.onTiming?.('providerTotalMs', performance.now() - started);
  }
}
