import type { AIModel } from '@orlynx/shared';
import { decryptCredential } from './credentials.js';
import { controlPlaneRepository } from './storage.js';

const ZEN = 'https://opencode.ai/zen/v1';
const modelCache = new Map<string, { expiresAt: number; models: AIModel[] }>();

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function familyOf(id: string): string {
  const lower = id.toLowerCase();
  if (/gpt|o1|o3|o4/.test(lower)) return 'GPT';
  if (/claude/.test(lower)) return 'Claude';
  if (/gemini|gemma/.test(lower)) return 'Gemini';
  if (/qwen/.test(lower)) return 'Qwen';
  if (/deepseek/.test(lower)) return 'DeepSeek';
  if (/grok/.test(lower)) return 'Grok';
  if (/kimi/.test(lower)) return 'Kimi';
  if (/minimax/.test(lower)) return 'MiniMax';
  if (/glm/.test(lower)) return 'GLM';
  if (/muse/.test(lower)) return 'Muse';
  return 'OpenCode';
}

export async function openCodeAccountKey(userId: string): Promise<string> {
  const row = await controlPlaneRepository().getProviderConnection(userId, 'opencode');
  if (!row || row.state !== 'connected' || !row.credential) throw new Error('Connect your OpenCode account before chatting.');
  return decryptCredential(row.credential);
}

export async function listZenModels(_userId?: string, force = false): Promise<AIModel[]> {
  const cacheKey = 'public';
  const cached = modelCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.models;

  let response: Response;
  try {
    response = await fetch(`${ZEN}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    if (cached?.models?.length) return cached.models;
    throw new Error('The OpenCode model catalog could not be reached.');
  }
  if (!response.ok) {
    if (cached?.models?.length) return cached.models;
    throw new Error(`The OpenCode model catalog returned HTTP ${response.status}.`);
  }

  const body = await response.json() as { data?: unknown[]; models?: unknown[] };
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const seen = new Set<string>();
  const models: AIModel[] = [];
  for (const item of rows) {
    const record = typeof item === 'string' ? { id: item } : item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const rawId = String(record.id || record.model || '');
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    const display = String(record.name || record.display_name || record.displayName || titleCase(rawId));
    models.push({
      id: `opencode/${rawId}`,
      providerId: 'opencode',
      providerName: 'OpenCode',
      displayName: display,
      family: familyOf(rawId),
      connected: true,
      status: 'available',
    });
  }
  models.sort((a,b)=>a.displayName.localeCompare(b.displayName));
  modelCache.set(cacheKey, { expiresAt: Date.now() + 10 * 60_000, models });
  return models;
}

type Dialect = 'chat' | 'responses' | 'messages';

function preferredDialect(model: string): Dialect {
  const id = model.toLowerCase();
  if (/^(gpt-|o[134]-|grok-4|grok-build|muse-)/.test(id)) return 'responses';
  if (/^(claude-|qwen3\.[5-8]-)/.test(id)) return 'messages';
  return 'chat';
}

function endpoint(dialect: Dialect): string {
  if (dialect === 'responses') return `${ZEN}/responses`;
  if (dialect === 'messages') return `${ZEN}/messages`;
  return `${ZEN}/chat/completions`;
}

type ChatTurn = { role: 'user' | 'assistant'; content: string };

function requestBody(dialect: Dialect, model: string, system: string, messages: ChatTurn[]): Record<string, unknown> {
  if (dialect === 'responses') {
    return { model, stream: true, input: [{ role: 'system', content: system }, ...messages] };
  }
  if (dialect === 'messages') {
    return { model, stream: true, max_tokens: 8192, system, messages };
  }
  return { model, stream: true, messages: [{ role: 'system', content: system }, ...messages] };
}

function textFromJson(value: any): string {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.delta === 'string' && value.type === 'response.output_text.delta') return value.delta;
  if (value.type === 'content_block_delta' && typeof value.delta?.text === 'string') return value.delta.text;
  const choice = value.choices?.[0];
  const choiceText = choice?.delta?.content ?? choice?.message?.content;
  if (typeof choiceText === 'string') return choiceText;
  if (Array.isArray(choiceText)) return choiceText.map((part: any) => typeof part === 'string' ? part : String(part?.text || '')).join('');
  if (typeof value.output_text === 'string') return value.output_text;
  if (Array.isArray(value.output)) {
    return value.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []).map((part: any) => String(part?.text || '')).join('');
  }
  if (Array.isArray(value.content)) return value.content.map((part: any) => String(part?.text || '')).join('');
  return '';
}

async function readStreamingText(response: Response, onDelta: (delta: string) => void): Promise<string> {
  const contentType = String(response.headers.get('content-type') || '');
  if (!response.body || !contentType.includes('text/event-stream')) {
    const body = await response.json().catch(() => ({}));
    const text = textFromJson(body);
    if (text) onDelta(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') {
        try {
          const delta = textFromJson(JSON.parse(data));
          if (delta) { full += delta; onDelta(delta); }
        } catch { /* ignore non-json keepalive frames */ }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  return full;
}

function retryableRouteFailure(status: number, text: string): boolean {
  return [400,404,405,422].includes(status) && /route|endpoint|unsupported|not supported|model.*provider|invalid request/i.test(text);
}

function providerBusy(status: number, text: string): boolean {
  return status === 408 || status === 429 || status >= 500 ||
    /FreeUsageLimitError|rate.?limit|too many requests|temporarily unavailable|overloaded|capacity/i.test(text);
}

function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15_000, Math.max(500, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(15_000, Math.max(500, date - Date.now()));
  }
  return Math.min(8_000, 1000 * (2 ** attempt));
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Cancelled.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function streamZenChat(input: {
  userId: string;
  modelId: string;
  system: string;
  messages: ChatTurn[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
}): Promise<string> {
  const key = await openCodeAccountKey(input.userId);
  const model = input.modelId.replace(/^opencode\//, '');
  if (!model) throw new Error('Choose a model before sending a message.');

  const preferred = preferredDialect(model);
  const attempts: Dialect[] = [preferred, ...(['chat','responses','messages'] as Dialect[]).filter((item) => item !== preferred)];
  let lastError = '';

  for (const dialect of attempts) {
    let tryAnotherDialect = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      input.onStatus?.(attempt === 0 ? `Connecting to ${model}…` : `Retrying ${model}…`);
      const combinedSignal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)])
        : AbortSignal.timeout(10 * 60_000);
      const headers: Record<string,string> = {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      if (dialect === 'messages') headers['anthropic-version'] = '2023-06-01';

      const response = await fetch(endpoint(dialect), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(dialect, model, input.system, input.messages)),
        signal: combinedSignal,
      });

      if (response.ok) {
        input.onStatus?.('Streaming response…');
        const text = await readStreamingText(response, input.onDelta);
        if (!text.trim()) throw new Error('The selected model finished without returning visible text.');
        return text;
      }

      const detail = await response.text().catch(() => '');
      lastError = `OpenCode ${model} request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0,700)}` : ''}`;

      if (providerBusy(response.status, detail)) {
        if (attempt < 2) {
          const delay = retryAfterMs(response.headers.get('retry-after'), attempt);
          input.onStatus?.(`Model busy — retrying in ${Math.max(1, Math.ceil(delay / 1000))}s · attempt ${attempt + 2} of 3`);
          await waitForRetry(delay, input.signal);
          continue;
        }
        throw new Error(lastError);
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenCode rejected the saved account credential (HTTP ${response.status}). Reconnect OpenCode and try again.`);
      }

      if (retryableRouteFailure(response.status, detail)) {
        tryAnotherDialect = true;
        break;
      }

      throw new Error(lastError);
    }

    if (tryAnotherDialect) continue;
  }

  throw new Error(lastError || 'The selected OpenCode model could not be reached.');
}
