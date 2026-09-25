import { createHash } from 'node:crypto';
import type { LanguageModel, ModelMessage } from 'ai';
import { savedOpenCodeAccountKey } from './zen.js';
import { openCodeCatalog, resolveAuth, resolveModel } from './opencode-catalog.js';

const providers = new Map<string, { expires: number; language: Promise<LanguageModel> }>();
const MAX_PROVIDERS = 64;

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

async function runtimeJson<T>(pathname: string, init: RequestInit = {}, timeoutMs = 90_000): Promise<T> {
  const response = await runtimeFetch(pathname, init, timeoutMs);
  if (!response.ok) {
    // Do not forward remote response bodies: they may contain provider,
    // request, or authentication diagnostics that belong only in the runtime.
    const message = response.status === 401
      ? 'OpenCode runtime authentication failed (HTTP 401).'
      : response.status === 403
        ? 'OpenCode runtime rejected the request (HTTP 403).'
        : `OpenCode runtime returned HTTP ${response.status}.`;
    throw new ProviderRequestError(message, response.status, true);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
  input.onStatus?.('Thinking…');

  const created = await runtimeJson<any>('/session', {
    method: 'POST',
    body: JSON.stringify({ title: `Orlynx ${input.runtimeKey}` }),
    signal: input.signal,
  });
  const sessionID = String(created?.id || '');
  if (!sessionID) throw new ProviderRequestError('OpenCode runtime did not create a session.', 502, true);

  input.onTiming?.('providerInitMs', performance.now() - started);

  const eventResponse = await runtimeFetch('/event', {
    headers: { Accept: 'text/event-stream' },
    signal: input.signal,
  }, 5 * 60_000);
  if (!eventResponse.ok || !eventResponse.body) {
    throw new ProviderRequestError(`OpenCode event stream returned HTTP ${eventResponse.status}.`, eventResponse.status, true);
  }

  const transcript = input.messages
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n\n');
  const prompt = transcript
    ? `Conversation so far:\n\n${transcript}\n\nRespond naturally to the latest user message. Do not repeat the transcript.`
    : 'Respond naturally to the user.';

  const requested = performance.now();
  await runtimeJson<void>(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({
      model: { providerID: 'opencode', modelID: input.modelId.replace(/^opencode\//, '') },
      agent: 'plan',
      system: input.system,
      parts: [{ type: 'text', text: prompt }],
    }),
    signal: input.signal,
  }, 30_000);
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
  if (!resolved.free) {
    try {
      savedKey = await savedOpenCodeAccountKey(input.userId);
    } catch {
      throw new ProviderRequestError('Your saved OpenCode connection can no longer be decrypted. Reconnect OpenCode to use paid models.', 401, false);
    }
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
