import WebSocket from 'ws';
import * as pty from 'node-pty';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONTROL = process.env.ORLYNX_CONTROL || '';
let token = process.env.ORLYNX_WORKSPACE_TOKEN || '';
const WORKSPACE_ID = process.env.ORLYNX_WORKSPACE_ID || '';
const SESSION_ID = process.env.ORLYNX_SESSION_ID || '';
const USER_ID = process.env.ORLYNX_USER_ID || '';
const CONNECTION_ID = process.env.ORLYNX_CONNECTION_ID || '';
const REPO_ROOT = path.resolve(process.env.ORLYNX_REPO_ROOT || process.cwd());
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || '';
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const MAX_OUTPUT = 512_000;
const COMMAND_JOURNAL = path.join(os.homedir(), '.orlynx', 'runtime', 'command-results.json');
const OPENCODE_AUTH_MODE_FILE = path.join(os.homedir(), '.orlynx', 'runtime', 'opencode-auth-mode');

type Command = { kind: 'COMMAND'; commandId: string; type: string; payload?: Record<string, unknown> };
type CommandReply = { ok: boolean; result?: Record<string, unknown>; error?: string };
type InFlightCommand = { sockets: Set<WebSocket>; promise: Promise<CommandReply> };
type PtyState = { terminal: pty.IPty; pending: string };
const terminals = new Map<string, PtyState>();
const completed = new Map<string, CommandReply>();
const inFlight = new Map<string, InFlightCommand>();
const activeAgents = new Map<string, string>();
type OpenCodeAuthMode = 'public' | 'account';
type AdapterLifecycle = { state: 'starting' | 'ready' | 'failed' | 'unavailable'; reason?: string };
let openCodeAuthMode: OpenCodeAuthMode | undefined;
try {
  const savedMode = fs.readFileSync(OPENCODE_AUTH_MODE_FILE, 'utf8').trim();
  if (savedMode === 'public' || savedMode === 'account') openCodeAuthMode = savedMode;
} catch {}
let openCodeLifecycle: AdapterLifecycle = { state: 'starting' };

function rememberOpenCodeAuthMode(mode: OpenCodeAuthMode | undefined): void {
  openCodeAuthMode = mode;
  try {
    if (mode) fs.writeFileSync(OPENCODE_AUTH_MODE_FILE, mode, { mode: 0o600 });
    else fs.unlinkSync(OPENCODE_AUTH_MODE_FILE);
  } catch {}
}
try { for (const [id, value] of Object.entries(JSON.parse(fs.readFileSync(COMMAND_JOURNAL, 'utf8')) as Record<string, CommandReply>)) completed.set(id, value); } catch {}
function remember(id: string, value: CommandReply) {
  completed.set(id, value); while (completed.size > 500) completed.delete(completed.keys().next().value!);
  try { fs.writeFileSync(`${COMMAND_JOURNAL}.tmp`, JSON.stringify(Object.fromEntries(completed)), { mode: 0o600 }); fs.renameSync(`${COMMAND_JOURNAL}.tmp`, COMMAND_JOURNAL); } catch {}
}
function sendCommandReply(ws: WebSocket, commandId: string, reply: CommandReply): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ kind: 'RESULT', commandId, ...reply })); } catch { /* a replacement socket will receive the durable retry */ }
}
function runCommandOnce(command: Command, ws: WebSocket): void {
  const prior = completed.get(command.commandId);
  if (prior) { sendCommandReply(ws, command.commandId, prior); return; }
  const existing = inFlight.get(command.commandId);
  if (existing) { existing.sockets.add(ws); return; }

  const sockets = new Set<WebSocket>([ws]);
  const promise = (async (): Promise<CommandReply> => {
    let reply: CommandReply;
    try { reply = { ok: true, result: await execute(command, ws) }; }
    catch (error) { reply = { ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : 'Command failed.' }; }
    remember(command.commandId, reply);
    const active = inFlight.get(command.commandId);
    if (active) for (const target of active.sockets) sendCommandReply(target, command.commandId, reply);
    return reply;
  })().finally(() => { inFlight.delete(command.commandId); });
  inFlight.set(command.commandId, { sockets, promise });
  void promise;
}

function safePath(relative = '.'): string {
  const result = path.resolve(REPO_ROOT, relative);
  if (result !== REPO_ROOT && !result.startsWith(`${REPO_ROOT}${path.sep}`)) throw new Error('Path is outside the workspace repository.');
  return result;
}

function output(value: string | Buffer | null | undefined): string { return String(value || '').slice(0, MAX_OUTPUT); }
function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/(ORLYNX_WORKSPACE_TOKEN|OPENCODE_SERVER_PASSWORD|TOKEN|SECRET|PRIVATE.?KEY|API.?KEY|CREDENTIAL)/i.test(name)) env[name] = value;
  return { ...env, ...extra };
}
function git(args: string[], timeout = 30_000) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout, env: cleanEnvironment() });
  if (result.error || result.status !== 0) throw new Error(output(result.stderr) || result.error?.message || `git exited ${result.status}`);
  return output(result.stdout);
}

const allowedExecutables = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'pytest', 'go', 'cargo', 'make']);
const deniedFragments = /(?:^|\s)(?:sudo|su|ssh|scp|curl|wget|nc|ncat|socat|docker|kubectl|terraform|rm\s+-rf|git\s+push\s+.*--force)(?:\s|$)|[;&|`]|\$\(/i;
function commandAllowed(command: string, args: string[]): boolean {
  if (!allowedExecutables.has(command) || command.includes('/') || args.length > 100) return false;
  if (deniedFragments.test(`${command} ${args.join(' ')}`)) return false;
  if (command === 'npx' && !['vitest', 'jest', 'playwright', 'tsc', 'eslint', 'vite', 'next'].includes(args[0] || '')) return false;
  return args.every((arg) => arg.length <= 1000 && !arg.includes('\0'));
}
function terminalLineAllowed(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (deniedFragments.test(trimmed) || /[<>]/.test(trimmed)) return false;
  const [command, ...args] = trimmed.split(/\s+/);
  if (['pwd', 'ls', 'cat', 'head', 'tail', 'find', 'rg', 'grep', 'cd', 'clear', 'echo'].includes(command)) return args.every((arg) => !arg.startsWith('/') && arg !== '..' && !arg.startsWith('../'));
  if (command === 'git') return ['status', 'diff', 'log', 'show', 'branch'].includes(args[0] || '');
  return commandAllowed(command, args);
}

async function openCodeHealth(): Promise<'ready' | 'unauthorized' | 'unavailable'> {
  try {
    const auth = Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64');
    const response = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/global/health`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(2_000) });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (!response.ok) return 'unavailable';
    const body = await response.json() as { healthy?: boolean };
    return body.healthy ? 'ready' : 'unavailable';
  } catch { return 'unavailable'; }
}
function stopStaleOpenCode(): boolean {
  // Earlier reconnects rotated the password while leaving the old server on
  // this private loopback port. Only stop a verified OpenCode serve process.
  const result = spawnSync('fuser', ['-n', 'tcp', String(OPENCODE_PORT)], { encoding: 'utf8', timeout: 3_000 });
  if (result.status !== 0) return false;
  let stopped = false;
  for (const match of String(result.stdout).matchAll(/\b\d+\b/g)) {
    const pid = Number(match[0]);
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (!/opencode/i.test(command) || !/\bserve\b/.test(command)) continue;
      process.kill(pid, 'SIGTERM'); stopped = true;
    } catch { /* another process may have exited during inspection */ }
  }
  return stopped;
}
async function waitForOpenCodeToStop(): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await openCodeHealth() === 'unavailable') return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return (await openCodeHealth()) === 'unavailable';
}

async function startOpenCode(useAccountKey = Boolean(OPENCODE_API_KEY), forceRestart = false): Promise<{ state: 'ready' | 'failed'; reason?: string }> {
  if (!OPENCODE_PASSWORD) return { state: 'failed', reason: 'configuration_missing' };
  if (forceRestart) {
    stopStaleOpenCode();
    if (!(await waitForOpenCodeToStop())) return { state: 'failed', reason: 'existing_server_auth_mismatch' };
    rememberOpenCodeAuthMode(undefined);
  }

  const initialHealth = await openCodeHealth();
  if (initialHealth === 'ready') return { state: 'ready' };
  if (initialHealth === 'unauthorized') {
    if (!stopStaleOpenCode()) return { state: 'failed', reason: 'existing_server_auth_mismatch' };
    if (!(await waitForOpenCodeToStop())) return { state: 'failed', reason: 'existing_server_auth_mismatch' };
  }
  if (useAccountKey && !OPENCODE_API_KEY) return { state: 'failed', reason: 'account_key_unavailable' };
  const binaryProbe = spawnSync(OPENCODE_BIN, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (binaryProbe.status !== 0) {
    const signal = binaryProbe.signal ? String(binaryProbe.signal) : 'none';
    const status = typeof binaryProbe.status === 'number' ? String(binaryProbe.status) : 'none';
    console.error(`[bridge] OpenCode binary probe failed status=${status} signal=${signal}`);
    return { state: 'failed', reason: 'binary_unavailable' };
  }

  const child = spawn(OPENCODE_BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(OPENCODE_PORT)], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: cleanEnvironment({
      OPENCODE_SERVER_PASSWORD: OPENCODE_PASSWORD,
      ...(useAccountKey && OPENCODE_API_KEY ? { OPENCODE_API_KEY } : {}),
    }),
  });
  child.unref();

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const health = await openCodeHealth();
    if (health === 'ready') {
      rememberOpenCodeAuthMode(useAccountKey ? 'account' : 'public');
      return { state: 'ready' };
    }
    if (health === 'unauthorized') return { state: 'failed', reason: 'existing_server_auth_mismatch' };
  }
  return { state: 'failed', reason: 'startup_timeout' };
}

async function ensureOpenCodeAuthMode(publicAccess: boolean): Promise<boolean> {
  const desired: OpenCodeAuthMode = publicAccess ? 'public' : 'account';
  if (desired === 'account' && !OPENCODE_API_KEY) {
    throw new Error('Connect your OpenCode account before using this paid model.');
  }
  if (openCodeAuthMode === desired && await openCodeHealth() === 'ready') return false;

  const started = await startOpenCode(desired === 'account', true);
  if (started.state === 'ready') {
    openCodeLifecycle = { state: 'ready' };
    return true;
  }

  // Authentication-mode switching belongs to this run. A failed switch must
  // not poison the whole adapter if an already-running OpenCode server remains
  // healthy for other models/tasks.
  const health = await openCodeHealth();
  openCodeLifecycle = health === 'ready'
    ? { state: 'ready' }
    : { state: 'unavailable', reason: started.reason || (health === 'unauthorized' ? 'auth_mismatch' : 'auth_switch_failed') };

  throw new Error(started.reason === 'account_key_unavailable'
    ? 'Connect your OpenCode account before using this paid model.'
    : 'OpenCode could not switch authentication mode in the Codespace.');
}
async function opencodeRequest(payload: Record<string, unknown>) {
  const method = String(payload.method || 'GET').toUpperCase();
  const pathname = String(payload.path || '');
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method) || !/^\/(global\/health|agent|provider|session(?:\/[^/?]+(?:\/(?:prompt_async|message|diff|abort|shell))?|\/status)?)$/.test(pathname)) throw new Error('OpenCode route denied by bridge policy.');
  const url = new URL(pathname, `http://127.0.0.1:${OPENCODE_PORT}`); url.searchParams.set('directory', REPO_ROOT);
  const auth = Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64');
  const response = await fetch(url, { method, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', 'x-opencode-directory': REPO_ROOT }, body: payload.body === undefined || method === 'GET' ? undefined : JSON.stringify(payload.body), signal: AbortSignal.timeout(Number(payload.timeoutMs || 120_000)) });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenCode request failed (HTTP ${response.status}): ${text.slice(0, 1000)}`);
  const body = text ? JSON.parse(text) : null;
  if (pathname === '/provider' && body && typeof body === 'object') {
    // OpenCode includes full model metadata for many providers; sending that
    // catalog over the workspace socket can exceed its 1 MiB frame limit.
    // The picker needs only the connected providers' model IDs and names.
    const connected = Array.isArray(body.connected) ? body.connected.map(String) : [];
    const ids = new Set(connected.map((id: string) => id.toLowerCase()));
    const all = Array.isArray(body.all) ? body.all.filter((provider: any) => ids.has(String(provider?.id || '').toLowerCase())).map((provider: any) => ({
      id: String(provider.id),
      name: String(provider.name || provider.id),
      models: Object.entries(provider.models || {}).map(([id, model]) => ({ id, name: String((model as { name?: string })?.name || id) })),
    })) : [];
    return { status: response.status, body: { connected, all } };
  }
  return { status: response.status, body };
}
function bridgeEvent(ws: WebSocket, type: string, payload: Record<string, unknown>, taskId?: string, runId?: string) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'EVENT', event: { type, payload, taskId, runId } }));
}

type OpenCodeEvent = { type?: string; properties?: Record<string, any> };

function openCodeHeaders(): Record<string, string> {
  const auth = Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    Accept: 'text/event-stream',
    'x-opencode-directory': REPO_ROOT,
  };
}

async function* openCodeEvents(signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
  const url = new URL('/event', `http://127.0.0.1:${OPENCODE_PORT}`);
  url.searchParams.set('directory', REPO_ROOT);
  const response = await fetch(url, { headers: openCodeHeaders(), signal });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (HTTP ${response.status}).`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            const event = JSON.parse(data) as OpenCodeEvent;
            if (event && typeof event === 'object') yield event;
          } catch { /* ignore malformed/partial event frames */ }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function openCodeErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value : 'OpenCode reported that the task failed.';
  const record = value as Record<string, any>;
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : undefined;
  const message = String(data?.message || record.message || record.name || 'OpenCode reported that the task failed.');
  const status = Number(data?.statusCode || 0);
  return status > 0 ? `${message} (HTTP ${status})` : message;
}

function assistantText(message: { parts?: Array<Record<string, any>> } | undefined): string {
  return (message?.parts || []).filter((part) => part.type === 'text' && !part.synthetic && !part.ignored).map((part) => String(part.text || '')).join('');
}
async function runAgent(payload: Record<string, unknown>, ws: WebSocket) {
  const taskId = String(payload.taskId || ''); const runId = String(payload.runId || '');
  let engineSessionId = String(payload.engineSessionId || '');
  if (typeof payload.openCodePublicAccess === 'boolean') {
    const restarted = await ensureOpenCodeAuthMode(payload.openCodePublicAccess);
    if (restarted) engineSessionId = '';
  }
  if (!engineSessionId) {
    const created = await opencodeRequest({ path: '/session', method: 'POST', body: { title: `Orlynx ${String(payload.sessionId || '')}` } }) as { body?: { id?: string } };
    engineSessionId = String(created.body?.id || ''); if (!engineSessionId) throw new Error('OpenCode did not create a session.');
  }

  const prior = await opencodeRequest({ path: `/session/${engineSessionId}/message`, method: 'GET' }) as { body?: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }> };
  const previousAssistant = [...(prior.body || [])].reverse().find((message) => message.info?.role === 'assistant')?.info?.id;
  const body: Record<string, unknown> = { parts: [{ type: 'text', text: String(payload.text || '') }] };
  if (payload.model) body.model = payload.model;
  if (payload.agent) body.agent = payload.agent;

  // OpenCode already exposes an event stream. Subscribe first so Orlynx does
  // not have to poll the engine continuously just to discover new tokens.
  const streamAbort = new AbortController();
  let iterator: AsyncIterator<OpenCodeEvent> | undefined;
  let nextEvent: Promise<IteratorResult<OpenCodeEvent>> | undefined;
  try {
    iterator = openCodeEvents(streamAbort.signal)[Symbol.asyncIterator]();
    nextEvent = iterator.next();
    const warm = await Promise.race([
      nextEvent.then((value) => ({ kind: 'event' as const, value })).catch(() => ({ kind: 'failed' as const })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 1_500)),
    ]);
    if (warm.kind === 'event') {
      nextEvent = warm.value.done ? undefined : iterator.next();
    } else if (warm.kind === 'failed') {
      nextEvent = undefined;
    }
    // On timeout, keep the original pending iterator.next(); it may still
    // connect after the prompt starts. The fallback poll below guarantees progress.
  } catch {
    nextEvent = undefined;
  }

  await opencodeRequest({ path: `/session/${engineSessionId}/prompt_async`, method: 'POST', body, timeoutMs: 120_000 });
  activeAgents.set(taskId, engineSessionId);

  const deadline = Date.now() + 30 * 60_000;
  let assistant: { info?: Record<string, any>; parts?: Array<Record<string, any>> } | undefined;
  let visible = '';
  let finished = false;
  let lastRetryKey = '';
  let streamFallbackNotified = false;
  const textParts = new Map<string, string>();
  const toolStates = new Map<string, string>();

  const emitRetry = (status: Record<string, any>) => {
    const key = `${status.attempt || 0}:${status.next || 0}:${status.message || ''}`;
    if (key === lastRetryKey) return;
    lastRetryKey = key;
    bridgeEvent(ws, 'activity.progress', {
      sourceType: 'opencode.retry',
      text: String(status.message || 'Provider is temporarily unavailable. Retrying…'),
      attempt: Number(status.attempt || 0),
      nextAt: Number(status.next || 0),
      provider: status.action?.provider ? String(status.action.provider) : undefined,
      reason: status.action?.reason ? String(status.action.reason) : undefined,
    }, taskId, runId);
  };

  const emitTool = (part: Record<string, any>) => {
    const state = part.state && typeof part.state === 'object' ? part.state as Record<string, any> : {};
    const status = String(state.status || '');
    const id = String(part.callID || part.id || part.tool || '');
    if (!id || !status) return;
    const marker = `${status}:${String(state.time?.end || '')}:${String(state.output || state.error || '').length}`;
    if (toolStates.get(id) === marker) return;
    toolStates.set(id, marker);

    // OpenCode tool parts carry observable inputs in state.input/part.input.
    // Preserve only small, user-verifiable execution metadata — never hidden
    // reasoning — so Build mode can show the command/file being worked on.
    const input = state.input && typeof state.input === 'object'
      ? state.input as Record<string, any>
      : part.input && typeof part.input === 'object'
        ? part.input as Record<string, any>
        : {};
    const toolName = String(part.tool || 'tool');
    const title = String(state.title || input.description || part.tool || 'Tool').slice(0, 240);
    const commandCandidate = input.command ?? input.cmd ?? input.script ?? input.shell;
    const pathCandidate = input.filePath ?? input.path ?? input.file ?? input.filename;
    const codeCandidate = input.patch ?? input.diff ?? input.content ?? input.newString ?? input.newText;
    const command = typeof commandCandidate === 'string'
      ? commandCandidate
      : /bash|shell|exec|terminal/i.test(toolName) && title && title !== toolName
        ? title
        : '';
    const filePath = typeof pathCandidate === 'string' ? pathCandidate : '';
    const code = typeof codeCandidate === 'string' ? codeCandidate : '';
    const common = {
      tool: toolName,
      callId: id,
      title,
      ...(command ? { command: command.slice(0, 1_200) } : {}),
      ...(filePath ? { path: filePath.slice(0, 800) } : {}),
      ...(code ? { code: code.slice(0, 8_000) } : {}),
    };
    if (status === 'pending') bridgeEvent(ws, 'tool.requested', common, taskId, runId);
    else if (status === 'running') bridgeEvent(ws, 'tool.started', common, taskId, runId);
    else if (status === 'completed') bridgeEvent(ws, 'tool.completed', { ...common, out: String(state.output || '').slice(0, 8_000) }, taskId, runId);
    else if (status === 'error') bridgeEvent(ws, 'tool.failed', { ...common, error: String(state.error || 'Tool failed.').slice(0, 2_000) }, taskId, runId);
  };

  const reconcile = async () => {
    const [messages, status] = await Promise.all([
      opencodeRequest({ path: `/session/${engineSessionId}/message`, method: 'GET' }) as Promise<{ body?: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }> }>,
      opencodeRequest({ path: '/session/status', method: 'GET' }) as Promise<{ body?: Record<string, Record<string, any>> }>,
    ]);
    assistant = [...(messages.body || [])].reverse().find((message) => message.info?.role === 'assistant' && message.info?.id !== previousAssistant);
    if (assistant) {
      const text = assistantText(assistant);
      if (text.startsWith(visible) && text.length > visible.length) {
        bridgeEvent(ws, 'message.delta', { delta: text.slice(visible.length) }, taskId, runId);
        visible = text;
      }
      if (assistant.info?.error) throw new Error(openCodeErrorMessage(assistant.info.error));
    }
    const current = status.body?.[engineSessionId] || {};
    if (current.type === 'retry') emitRetry(current);
    if (current.type === 'idle' && assistant) finished = true;
  };

  try {
    while (Date.now() < deadline && !finished) {
      if (nextEvent) {
        const outcome = await Promise.race([
          nextEvent.then((value) => ({ kind: 'event' as const, value })).catch((error) => ({ kind: 'stream-error' as const, error })),
          new Promise<{ kind: 'tick' }>((resolve) => setTimeout(() => resolve({ kind: 'tick' }), 5_000)),
        ]);

        if (outcome.kind === 'event') {
          if (outcome.value.done) {
            nextEvent = undefined;
          } else {
            const event = outcome.value.value;
            nextEvent = iterator?.next();
            const properties = event.properties || {};
            const sessionID = String(properties.sessionID || '');
            if (sessionID && sessionID !== engineSessionId) continue;

            if (event.type === 'message.part.updated') {
              const part = properties.part && typeof properties.part === 'object' ? properties.part as Record<string, any> : undefined;
              if (part?.messageID !== previousAssistant && part?.type === 'text' && !part.synthetic && !part.ignored) {
                const id = String(part.id || part.messageID || 'text');
                const current = String(part.text || '');
                const before = textParts.get(id) || '';
                if (current.startsWith(before) && current.length > before.length) {
                  const delta = current.slice(before.length);
                  bridgeEvent(ws, 'message.delta', { delta }, taskId, runId);
                  visible += delta;
                }
                textParts.set(id, current);
              } else if (part?.type === 'tool' && part?.messageID !== previousAssistant) {
                emitTool(part);
              }
            } else if (event.type === 'session.status') {
              const status = properties.status && typeof properties.status === 'object' ? properties.status as Record<string, any> : {};
              if (status.type === 'retry') emitRetry(status);
              if (status.type === 'idle') finished = true;
            } else if (event.type === 'session.error') {
              throw new Error(openCodeErrorMessage(properties.error));
            } else if (event.type === 'message.updated') {
              const info = properties.info && typeof properties.info === 'object' ? properties.info as Record<string, any> : {};
              if (info.role === 'assistant' && info.id !== previousAssistant && info.error) throw new Error(openCodeErrorMessage(info.error));
            }
            continue;
          }
        } else if (outcome.kind === 'stream-error') {
          nextEvent = undefined;
        }

        if (!nextEvent && !streamFallbackNotified) {
          streamFallbackNotified = true;
          bridgeEvent(ws, 'activity.progress', { sourceType: 'opencode.transport', text: 'Live engine stream interrupted; Orlynx is recovering from session state.' }, taskId, runId);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }

      // Event delivery is primary. This slower snapshot poll is intentionally
      // retained as a safety net, matching OpenCode's own transport strategy.
      await reconcile();
    }

    if (!finished) {
      await reconcile().catch(() => {});
      if (!finished) throw new Error('OpenCode task timed out before the session returned to idle.');
    }

    const finalMessages = await opencodeRequest({ path: `/session/${engineSessionId}/message`, method: 'GET' }) as { body?: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }> };
    assistant = [...(finalMessages.body || [])].reverse().find((message) => message.info?.role === 'assistant' && message.info?.id !== previousAssistant);
    if (!assistant) throw new Error('OpenCode finished without an assistant response.');
    if (assistant.info?.error) throw new Error(openCodeErrorMessage(assistant.info.error));

    const responseText = assistantText(assistant);
    const diff = await opencodeRequest({ path: `/session/${engineSessionId}/diff`, method: 'GET' }) as { body?: Array<Record<string, unknown>> };
    const status = await execute({ kind: 'COMMAND', commandId: '', type: 'git.status', payload: {} }, ws);
    return { engineSessionId, responseText, diff: diff.body || [], head: status.head };
  } finally {
    streamAbort.abort();
    try { await iterator?.return?.(); } catch {}
    activeAgents.delete(taskId);
  }
}

type BridgeAgentAdapter = {
  id: string;
  health: () => Promise<{ state: string; reason?: string }>;
  run: (payload: Record<string, unknown>, ws: WebSocket) => Promise<Record<string, unknown>>;
  cancel: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

async function cancelOpenCodeAgent(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = activeAgents.get(String(payload.taskId || ''));
  if (!id) return { cancelled: false };
  await opencodeRequest({ path: `/session/${id}/abort`, method: 'POST' });
  activeAgents.delete(String(payload.taskId || ''));
  return { cancelled: true };
}

const bridgeAgentAdapters = new Map<string, BridgeAgentAdapter>([
  ['opencode', {
    id: 'opencode',
    health: async () => {
      const health = await openCodeHealth();
      if (health === 'ready') {
        openCodeLifecycle = { state: 'ready' };
        return openCodeLifecycle;
      }
      if (openCodeLifecycle.state === 'failed') return openCodeLifecycle;
      if (openCodeLifecycle.state === 'starting') return openCodeLifecycle;
      openCodeLifecycle = { state: 'unavailable', ...(health === 'unauthorized' ? { reason: 'auth_mismatch' } : {}) };
      return openCodeLifecycle;
    },
    run: runAgent,
    cancel: cancelOpenCodeAgent,
  }],
]);

function bridgeAgentAdapter(payload: Record<string, unknown>): BridgeAgentAdapter {
  const adapterId = String(payload.adapterId || 'opencode');
  const adapter = bridgeAgentAdapters.get(adapterId);
  if (!adapter) throw new Error(`Agent adapter "${adapterId}" is not installed in this workspace runtime.`);
  return adapter;
}

async function bridgeAdapterHealth(): Promise<Record<string, { state: string; reason?: string }>> {
  const entries = await Promise.all([...bridgeAgentAdapters.entries()].map(async ([id, adapter]) => [id, await adapter.health()] as const));
  return Object.fromEntries(entries);
}

function listFiles(relative: string) {
  const target = safePath(relative);
  return fs.readdirSync(target, { withFileTypes: true }).filter((entry) => entry.name !== '.git').map((entry) => ({ name: entry.name, path: path.relative(REPO_ROOT, path.join(target, entry.name)), dir: entry.isDirectory(), size: entry.isFile() ? fs.statSync(path.join(target, entry.name)).size : undefined }));
}
function ports() {
  const result = spawnSync('ss', ['-ltnH'], { encoding: 'utf8', timeout: 5_000 }); const found = new Set<number>();
  for (const line of String(result.stdout || '').split('\n')) { const match = line.match(/:(\d+)\s/); if (match) { const port = Number(match[1]); if (port > 1024 && port !== OPENCODE_PORT) found.add(port); } }
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN; const codespace = process.env.CODESPACE_NAME;
  return [...found].map((port) => ({ port, visibility: 'private', url: domain && codespace ? `https://${codespace}-${port}.${domain}` : undefined }));
}

async function execute(command: Command, ws: WebSocket): Promise<Record<string, unknown>> {
  const payload = command.payload || {};
  switch (command.type) {
    case 'health': {
      const adapters = await bridgeAdapterHealth();
      // Keep the legacy top-level openCode field while exposing the generic
      // adapter map. Older control-plane builds used health.openCode; newer
      // builds read adapters.opencode.state.
      return { bridge: 'ready', openCode: adapters.opencode?.state, adapters };
    }
    case 'fs.list': return { files: listFiles(String(payload.path || '.')) };
    case 'fs.read': { const target = safePath(String(payload.path || '')); const stat = fs.statSync(target); if (stat.size > 1_000_000) throw new Error('File is too large to read.'); return { path: path.relative(REPO_ROOT, target), content: fs.readFileSync(target, 'utf8') }; }
    case 'fs.write-attachment': {
      const name = String(payload.name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180); if (!name) throw new Error('Attachment name is invalid.');
      const data = Buffer.from(String(payload.contentBase64 || ''), 'base64'); if (data.length > 15 * 1024 * 1024) throw new Error('Attachment is too large.');
      const directory = safePath('.orlynx/attachments'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const target = path.join(directory, name); fs.writeFileSync(target, data, { mode: 0o600 });
      const exclude = safePath('.git/info/exclude'); const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''; if (!current.split(/\r?\n/).includes('.orlynx/')) fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.orlynx/\n`);
      return { path: path.relative(REPO_ROOT, target).split(path.sep).join('/') };
    }
    case 'git.status': return { branch: git(['branch', '--show-current']).trim(), head: git(['rev-parse', 'HEAD']).trim(), porcelain: git(['status', '--porcelain=v1']) };
    case 'git.diff': return { diff: git(['diff', '--no-ext-diff', '--', String(payload.path || '.')]) };
    case 'git.branch.create': { const branch = String(payload.branch || ''); if (!/^orlynx(?:-e2e)?\/[a-zA-Z0-9._-]+$/.test(branch)) throw new Error('Only an isolated orlynx/* branch may be created through this operation.'); git(['checkout', '-b', branch]); return { branch }; }
    case 'git.commit': { const message = String(payload.message || '').trim().slice(0, 240); if (!message) throw new Error('Commit message is required.'); git(['add', '--all']); git(['commit', '-m', message], 60_000); return { sha: git(['rev-parse', 'HEAD']).trim() }; }
    case 'git.push': { if (payload.approved !== true) throw new Error('Push requires an approved command.'); const branch = git(['branch', '--show-current']).trim(); if (!branch || branch === 'main' || branch === 'master') throw new Error('Direct push to the default branch is denied.'); return { output: git(['push', '--set-upstream', 'origin', branch], 120_000), branch }; }
    case 'command.exec': { const executable = String(payload.command || ''); const args = Array.isArray(payload.args) ? payload.args.map(String) : []; if (!commandAllowed(executable, args)) throw new Error('Command denied by bridge policy.'); const result = spawnSync(executable, args, { cwd: safePath(String(payload.cwd || '.')), encoding: 'utf8', timeout: Math.min(Number(payload.timeoutMs || 120_000), 300_000), env: cleanEnvironment() }); return { code: result.status ?? 1, stdout: output(result.stdout), stderr: output(result.stderr) }; }
    case 'ports.list': return { ports: ports() };
    case 'opencode.request': return opencodeRequest(payload);
    case 'agent.run': return bridgeAgentAdapter(payload).run(payload, ws);
    case 'agent.cancel': return bridgeAgentAdapter(payload).cancel(payload);
    case 'pty.open': {
      const id = String(payload.ptyId || command.commandId); if (terminals.has(id)) throw new Error('PTY already exists.');
      const terminal = pty.spawn(process.env.SHELL || '/bin/bash', ['--noprofile', '--norc'], { name: 'xterm-256color', cols: Math.min(Number(payload.cols || 80), 300), rows: Math.min(Number(payload.rows || 24), 100), cwd: REPO_ROOT, env: cleanEnvironment() as Record<string, string> });
      terminals.set(id, { terminal, pending: '' });
      terminal.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'EVENT', event: { type: 'pty.output', payload: { ptyId: id, data: output(data) } } })); });
      terminal.onExit(({ exitCode }) => { terminals.delete(id); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'EVENT', event: { type: 'pty.exit', payload: { ptyId: id, exitCode } } })); });
      return { ptyId: id };
    }
    case 'pty.input': {
      const state = terminals.get(String(payload.ptyId || '')); if (!state) throw new Error('PTY not found.'); const data = String(payload.data || '');
      if (/[^\x08\x09\x0a\x0d\x20-\x7e]/.test(data)) throw new Error('PTY control sequence denied.');
      for (const character of data) {
        if (character === '\r' || character === '\n') {
          if (terminalLineAllowed(state.pending)) state.terminal.write('\r');
          else state.terminal.write('\x15echo "command denied by Orlynx workspace policy"\r');
          state.pending = '';
        } else if (character === '\x08') {
          state.pending = state.pending.slice(0, -1); state.terminal.write(character);
        } else {
          state.pending += character; state.terminal.write(character);
        }
      }
      return { accepted: true };
    }
    case 'pty.resize': { const state = terminals.get(String(payload.ptyId || '')); if (!state) throw new Error('PTY not found.'); state.terminal.resize(Math.min(Number(payload.cols || 80), 300), Math.min(Number(payload.rows || 24), 100)); return { resized: true }; }
    case 'pty.close': { const state = terminals.get(String(payload.ptyId || '')); if (state) state.terminal.kill(); terminals.delete(String(payload.ptyId || '')); return { closed: true }; }
    default: throw new Error('Unknown bridge command.');
  }
}

function connect(delay = 0): void {
  setTimeout(async () => {
    openCodeLifecycle = { state: 'starting' };
    const openCodeStartup = startOpenCode()
      .then((result) => { openCodeLifecycle = result; return result; })
      .catch((error) => {
        openCodeLifecycle = { state: 'failed', reason: error instanceof Error ? error.message.slice(0, 160) : 'startup_failed' };
        return openCodeLifecycle;
      });
    const ws = new WebSocket(CONTROL, { headers: { Authorization: `Bearer ${token}` } }); let heartbeat: NodeJS.Timeout | undefined;
    ws.on('message', async (raw) => {
      let message: { kind: string; token?: string; commandId?: string; type?: string; payload?: Record<string, unknown> }; try { message = JSON.parse(String(raw)); } catch { return; }
      // The server attaches its message listener after verifying durable
      // workspace state. Wait for its request so HELLO cannot be lost.
      if (message.kind === 'HELLO_REQUEST') { ws.send(JSON.stringify({ kind: 'HELLO', workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, userId: USER_ID, connectionId: CONNECTION_ID, bridgeVersion: '2.1.0', os: os.platform(), arch: os.arch(), capabilities: ['pty', 'exec', 'fs', 'git', 'ports', 'agent-adapters', ...[...bridgeAgentAdapters.keys()].map((id) => `agent:${id}`)] })); return; }
      if ((message.kind === 'AUTHENTICATED' || message.kind === 'CREDENTIAL') && message.token) {
        token = message.token;
        if (message.kind === 'AUTHENTICATED') {
          if (ws.readyState !== WebSocket.OPEN) return;
          // Workspace readiness is independent of any agent adapter. Make shell,
          // files, Git and ports available immediately; adapters report their
          // own lifecycle asynchronously.
          ws.send(JSON.stringify({ kind: 'READY', repoRoot: REPO_ROOT, adapters: { opencode: { state: 'starting' } } }));
          void openCodeStartup.then((adapter) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'ADAPTER_STATUS', adapterId: 'opencode', adapter }));
          }).catch((error) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'ADAPTER_STATUS', adapterId: 'opencode', adapter: { state: 'failed', reason: error instanceof Error ? error.message.slice(0, 160) : 'startup_failed' } }));
          });
          heartbeat ||= setInterval(async () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const currentAdapters = await bridgeAdapterHealth();
            for (const [adapterId, adapter] of Object.entries(currentAdapters)) {
              ws.send(JSON.stringify({ kind: 'ADAPTER_STATUS', adapterId, adapter }));
            }
            ws.send(JSON.stringify({ kind: 'EVENT', event: { type: 'heartbeat', payload: { bridge: 'ready' } } }));
          }, 15_000);
        }
        return;
      }
      if (message.kind !== 'COMMAND' || !message.commandId) return;
      runCommandOnce(message as Command, ws);
    });
    ws.on('close', () => { if (heartbeat) clearInterval(heartbeat); connect(Math.min(delay ? delay * 2 : 1_000, 30_000)); }); ws.on('error', () => ws.close());
  }, delay);
}

export function start(): void {
  if (!CONTROL.startsWith('wss://') || !token || !WORKSPACE_ID || !SESSION_ID || !USER_ID || !CONNECTION_ID) { console.error('[bridge] required secure workspace configuration is missing'); process.exitCode = 2; return; }
  connect();
}
if (import.meta.url.endsWith(process.argv[1] || '')) start();
