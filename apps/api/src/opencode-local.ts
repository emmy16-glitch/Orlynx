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
  const auth = resolveAuth(resolved.free, await savedOpenCodeAccountKey(input.userId));
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
