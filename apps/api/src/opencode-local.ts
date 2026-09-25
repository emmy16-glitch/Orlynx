import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openCodeAccountKey } from './zen.js';

type Runtime = {
  sessionKey: string;
  child: ChildProcess;
  baseUrl: string;
  root: string;
  lastUsed: number;
  logTail: string;
};

const runtimes = new Map<string, Runtime>();
const START_TIMEOUT_MS = Math.max(5_000, Number(process.env.ORLYNX_LOCAL_OPENCODE_START_TIMEOUT_MS || 15_000));
const IDLE_MS = Math.max(5 * 60_000, Number(process.env.ORLYNX_LOCAL_OPENCODE_IDLE_MS || 20 * 60_000));

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function freeModel(model: string): boolean {
  const id = model.toLowerCase();
  return id.endsWith('-free') || id.includes('-contributor-free') || id === 'big-pickle';
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function request(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}

async function waitHealthy(runtime: Runtime): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      throw new Error(`OpenCode runtime exited during startup${runtime.logTail ? `: ${runtime.logTail.slice(-800)}` : ''}`);
    }
    try {
      const response = await request(`${runtime.baseUrl}/global/health`, {}, 1_000);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  runtime.child.kill('SIGTERM');
  throw new Error(`OpenCode runtime did not become ready within ${Math.round(START_TIMEOUT_MS / 1000)} seconds${last ? `: ${last}` : ''}`);
}

async function startRuntime(sessionKey: string): Promise<Runtime> {
  const root = path.join(os.tmpdir(), 'orlynx-opencode', safe(sessionKey));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const cacheDir = path.join(root, 'cache');
  await Promise.all([
    fs.mkdir(projectDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
  ]);
  const port = await reservePort();
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: projectDir,
    env: {
      ...process.env,
      XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runtime: Runtime = {
    sessionKey,
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    root,
    lastUsed: Date.now(),
    logTail: '',
  };
  const append = (chunk: Buffer | string) => {
    runtime.logTail = (runtime.logTail + String(chunk)).slice(-8_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('exit', () => {
    const current = runtimes.get(sessionKey);
    if (current?.child === child) runtimes.delete(sessionKey);
  });
  child.once('error', (error) => {
    runtime.logTail = (runtime.logTail + '\n' + error.message).slice(-8_000);
  });
  await waitHealthy(runtime);
  runtimes.set(sessionKey, runtime);
  return runtime;
}

async function ensureRuntime(sessionKey: string): Promise<Runtime> {
  const existing = runtimes.get(sessionKey);
  if (existing && existing.child.exitCode === null) {
    existing.lastUsed = Date.now();
    try {
      const response = await request(`${existing.baseUrl}/global/health`, {}, 1_000);
      if (response.ok) return existing;
    } catch {}
    existing.child.kill('SIGTERM');
    runtimes.delete(sessionKey);
  }
  return startRuntime(sessionKey);
}

async function json<T>(runtime: Runtime, pathname: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  runtime.lastUsed = Date.now();
  const response = await request(`${runtime.baseUrl}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }, timeoutMs);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenCode runtime ${pathname} failed (HTTP ${response.status})${detail ? `: ${detail.slice(0,800)}` : ''}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function configureAuth(runtime: Runtime, userId: string, modelId: string): Promise<void> {
  const model = modelId.replace(/^opencode\//, '');
  const key = freeModel(model) ? 'public' : await openCodeAccountKey(userId);
  await json(runtime, '/auth/opencode', {
    method: 'PUT',
    body: JSON.stringify({ type: 'api', key }),
  });
}

function eventData(frame: string): unknown | undefined {
  const payload = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!payload || payload === '[DONE]') return undefined;
  try { return JSON.parse(payload); } catch { return undefined; }
}

async function streamEvents(input: {
  runtime: Runtime;
  sessionID: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
  startPrompt: () => Promise<void>;
}): Promise<string> {
  const { runtime, sessionID, signal } = input;
  const response = await request(`${runtime.baseUrl}/event`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  }, 10 * 60_000);
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (HTTP ${response.status}).`);

  const abortRemote = () => {
    void request(`${runtime.baseUrl}/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST' }, 3_000).catch(() => {});
  };
  signal.addEventListener('abort', abortRemote, { once: true });

  await input.startPrompt();
  input.onStatus?.('Streaming response…');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let errorText = '';
  let idleSeen = false;

  try {
    while (!idleSeen) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = eventData(frame) as any;
        boundary = buffer.indexOf('\n\n');
        if (!event || typeof event !== 'object') continue;

        const type = String(event.type || '');
        const p = event.properties || {};
        const eventSession = String(p.sessionID || p.part?.sessionID || p.info?.sessionID || '');
        if (eventSession && eventSession !== sessionID) continue;

        if (type === 'message.part.delta') {
          const field = String(p.field || '');
          const delta = typeof p.delta === 'string' ? p.delta : '';
          if (delta && (!field || field === 'text')) {
            full += delta;
            input.onDelta(delta);
          }
          continue;
        }

        if (type === 'session.error') {
          const raw = p.error?.data?.message || p.error?.message || p.error?.name || 'OpenCode session failed.';
          errorText = String(raw);
          continue;
        }

        if (type === 'session.status' && p.status?.type === 'idle') {
          idleSeen = true;
          break;
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', abortRemote);
    try { await reader.cancel(); } catch {}
  }

  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Cancelled by user.');
  if (errorText) throw new Error(errorText);
  if (full.trim()) return full;

  const messages = await json<any[]>(runtime, `/session/${encodeURIComponent(sessionID)}/message?limit=10`, {}, 10_000).catch(() => []);
  const latest = [...messages].reverse().find((item) => item?.info?.role === 'assistant');
  const text = Array.isArray(latest?.parts)
    ? latest.parts.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text || '')).join('')
    : '';
  if (!text.trim()) throw new Error('OpenCode completed without returning visible text.');
  input.onDelta(text);
  return text;
}

export async function streamWithOfficialOpenCode(input: {
  runtimeKey: string;
  userId: string;
  modelId: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
}): Promise<string> {
  input.onStatus?.('Starting OpenCode…');
  const runtime = await ensureRuntime(input.runtimeKey);
  await configureAuth(runtime, input.userId, input.modelId);

  const model = input.modelId.replace(/^opencode\//, '');
  const created = await json<any>(runtime, '/session', {
    method: 'POST',
    body: JSON.stringify({ title: `Orlynx ${input.runtimeKey}` }),
  });
  const sessionID = String(created?.id || '');
  if (!sessionID) throw new Error('OpenCode did not create a chat session.');

  return streamEvents({
    runtime,
    sessionID,
    signal: input.signal,
    onDelta: input.onDelta,
    onStatus: input.onStatus,
    startPrompt: () => json<void>(runtime, `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({
        model: { providerID: 'opencode', modelID: model },
        agent: 'plan',
        system: input.system,
        parts: [{ type: 'text', text: input.prompt }],
      }),
    }, 30_000),
  });
}

export function stopLocalOpenCode(runtimeKey: string): void {
  const runtime = runtimes.get(runtimeKey);
  if (!runtime) return;
  runtimes.delete(runtimeKey);
  if (runtime.child.exitCode === null) runtime.child.kill('SIGTERM');
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, runtime] of runtimes) {
    if (runtime.lastUsed + IDLE_MS > now) continue;
    stopLocalOpenCode(key);
    void fs.rm(runtime.root, { recursive: true, force: true }).catch(() => {});
  }
}, 60_000);
sweeper.unref?.();
