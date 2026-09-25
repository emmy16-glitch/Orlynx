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
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const MAX_OUTPUT = 512_000;
const COMMAND_JOURNAL = path.join(os.homedir(), '.orlynx', 'runtime', 'command-results.json');

type Command = { kind: 'COMMAND'; commandId: string; type: string; payload?: Record<string, unknown> };
type PtyState = { terminal: pty.IPty; pending: string };
const terminals = new Map<string, PtyState>();
const completed = new Map<string, { ok: boolean; result?: Record<string, unknown>; error?: string }>();
const activeAgents = new Map<string, string>();
try { for (const [id, value] of Object.entries(JSON.parse(fs.readFileSync(COMMAND_JOURNAL, 'utf8')) as Record<string, { ok: boolean; result?: Record<string, unknown>; error?: string }>)) completed.set(id, value); } catch {}
function remember(id: string, value: { ok: boolean; result?: Record<string, unknown>; error?: string }) {
  completed.set(id, value); while (completed.size > 500) completed.delete(completed.keys().next().value!);
  try { fs.writeFileSync(`${COMMAND_JOURNAL}.tmp`, JSON.stringify(Object.fromEntries(completed)), { mode: 0o600 }); fs.renameSync(`${COMMAND_JOURNAL}.tmp`, COMMAND_JOURNAL); } catch {}
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

async function openCodeHealth(): Promise<'ready' | 'unavailable'> {
  try {
    const auth = Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64');
    const response = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/global/health`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return 'unavailable';
    const body = await response.json() as { healthy?: boolean };
    return body.healthy ? 'ready' : 'unavailable';
  } catch { return 'unavailable'; }
}
async function startOpenCode(): Promise<'ready' | 'failed'> {
  if (await openCodeHealth() === 'ready') return 'ready';
  if (spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 5_000 }).status !== 0) return 'failed';
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(OPENCODE_PORT)], { cwd: REPO_ROOT, detached: true, stdio: 'ignore', env: cleanEnvironment({ OPENCODE_SERVER_PASSWORD: OPENCODE_PASSWORD, ...(OPENCODE_API_KEY ? { OPENCODE_API_KEY } : {}) }) });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) { await new Promise((resolve) => setTimeout(resolve, 1_000)); if (await openCodeHealth() === 'ready') return 'ready'; }
  return 'failed';
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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
function bridgeEvent(ws: WebSocket, type: string, payload: Record<string, unknown>, taskId?: string, runId?: string) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'EVENT', event: { type, payload, taskId, runId } }));
}
async function runAgent(payload: Record<string, unknown>, ws: WebSocket) {
  const taskId = String(payload.taskId || ''); const runId = String(payload.runId || '');
  let engineSessionId = String(payload.engineSessionId || '');
  if (!engineSessionId) {
    const created = await opencodeRequest({ path: '/session', method: 'POST', body: { title: `Orlynx ${String(payload.sessionId || '')}` } }) as { body?: { id?: string } };
    engineSessionId = String(created.body?.id || ''); if (!engineSessionId) throw new Error('OpenCode did not create a session.');
  }
  const prior = await opencodeRequest({ path: `/session/${engineSessionId}/message`, method: 'GET' }) as { body?: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }> };
  const previousAssistant = [...(prior.body || [])].reverse().find((message) => message.info?.role === 'assistant')?.info?.id;
  const body: Record<string, unknown> = { parts: [{ type: 'text', text: String(payload.text || '') }] }; if (payload.model) body.model = payload.model; if (payload.agent) body.agent = payload.agent;
  await opencodeRequest({ path: `/session/${engineSessionId}/prompt_async`, method: 'POST', body, timeoutMs: 120_000 });
  activeAgents.set(taskId, engineSessionId);
  const deadline = Date.now() + 30 * 60_000; let visible = ''; let assistant: { info?: Record<string, any>; parts?: Array<Record<string, any>> } | undefined;
  while (Date.now() < deadline) {
    const messages = await opencodeRequest({ path: `/session/${engineSessionId}/message`, method: 'GET' }) as { body?: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }> };
    assistant = [...(messages.body || [])].reverse().find((message) => message.info?.role === 'assistant' && message.info?.id !== previousAssistant);
    if (assistant) {
      const text = (assistant.parts || []).filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
      if (text.startsWith(visible) && text.length > visible.length) { bridgeEvent(ws, 'message.delta', { delta: text.slice(visible.length) }, taskId, runId); visible = text; }
      if (assistant.info?.error) throw new Error('OpenCode reported that the task failed.');
      if (assistant.info?.time?.completed || (assistant.info?.finish && assistant.info.finish !== 'tool-calls')) break;
    }
    const status = await opencodeRequest({ path: '/session/status', method: 'GET' }) as { body?: Record<string, { type?: string }> };
    if (assistant && status.body?.[engineSessionId]?.type === 'idle') break;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (!assistant) throw new Error('OpenCode finished without an assistant response.');
  const responseText = (assistant.parts || []).filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
  const diff = await opencodeRequest({ path: `/session/${engineSessionId}/diff`, method: 'GET' }) as { body?: Array<Record<string, unknown>> };
  const status = await execute({ kind: 'COMMAND', commandId: '', type: 'git.status', payload: {} }, ws);
  activeAgents.delete(taskId);
  return { engineSessionId, responseText, diff: diff.body || [], head: status.head };
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
    case 'health': return { bridge: 'ready', openCode: await openCodeHealth() };
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
    case 'agent.run': return runAgent(payload, ws);
    case 'agent.cancel': { const id = activeAgents.get(String(payload.taskId || '')); if (!id) return { cancelled: false }; await opencodeRequest({ path: `/session/${id}/abort`, method: 'POST' }); activeAgents.delete(String(payload.taskId || '')); return { cancelled: true }; }
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
    const openCodeStartup = startOpenCode();
    const ws = new WebSocket(CONTROL, { headers: { Authorization: `Bearer ${token}` } }); let heartbeat: NodeJS.Timeout | undefined;
    ws.on('open', () => ws.send(JSON.stringify({ kind: 'HELLO', workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, userId: USER_ID, connectionId: CONNECTION_ID, bridgeVersion: '2.0.0', os: os.platform(), arch: os.arch(), capabilities: ['pty', 'exec', 'fs', 'git', 'ports', 'opencode'] })));
    ws.on('message', async (raw) => {
      let message: { kind: string; token?: string; commandId?: string; type?: string; payload?: Record<string, unknown> }; try { message = JSON.parse(String(raw)); } catch { return; }
      if ((message.kind === 'AUTHENTICATED' || message.kind === 'CREDENTIAL') && message.token) {
        token = message.token;
        if (message.kind === 'AUTHENTICATED') { const openCode = await openCodeStartup; if (ws.readyState !== WebSocket.OPEN) return; ws.send(JSON.stringify({ kind: 'READY', repoRoot: REPO_ROOT, openCode: { state: openCode === 'ready' ? 'ready' : 'failed' } })); heartbeat ||= setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'EVENT', event: { type: 'heartbeat', payload: { openCode } } })); }, 15_000); }
        return;
      }
      if (message.kind !== 'COMMAND' || !message.commandId) return;
      const prior = completed.get(message.commandId); if (prior) { ws.send(JSON.stringify({ kind: 'RESULT', commandId: message.commandId, ...prior })); return; }
      try { const result = await execute(message as Command, ws); const reply = { ok: true, result }; remember(message.commandId, reply); ws.send(JSON.stringify({ kind: 'RESULT', commandId: message.commandId, ...reply })); }
      catch (error) { const reply = { ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : 'Command failed.' }; remember(message.commandId, reply); ws.send(JSON.stringify({ kind: 'RESULT', commandId: message.commandId, ...reply })); }
    });
    ws.on('close', () => { if (heartbeat) clearInterval(heartbeat); connect(Math.min(delay ? delay * 2 : 1_000, 30_000)); }); ws.on('error', () => ws.close());
  }, delay);
}

export function start(): void {
  if (!CONTROL.startsWith('wss://') || !token || !WORKSPACE_ID || !SESSION_ID || !USER_ID || !CONNECTION_ID || !OPENCODE_PASSWORD) { console.error('[bridge] required secure workspace configuration is missing'); process.exitCode = 2; return; }
  connect();
}
if (import.meta.url.endsWith(process.argv[1] || '')) start();
