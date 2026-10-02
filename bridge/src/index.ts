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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.ORLYNX_GITHUB_TOKEN || '';
const CONFIGURED_OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const OPENCODE_VERSION = process.env.OPENCODE_VERSION || '1.18.32';
const GH_BIN = process.env.ORLYNX_GH_BIN || 'gh';
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const MAX_OUTPUT = 512_000;
const COMMAND_JOURNAL = path.join(os.homedir(), '.orlynx', 'runtime', 'command-results.json');
const ACTIVITY_FILE = path.join(os.homedir(), '.orlynx', 'runtime', 'activity');
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
let openCodeTransientHealthFailures = 0;
const OPENCODE_HEALTH_FAILURE_THRESHOLD = 2;
let openCodeRepair: Promise<{ state: 'ready' | 'failed'; reason?: string }> | undefined;
let nextOpenCodeRepairAt = 0;

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
function touchActivity(): void {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true, mode: 0o700 });
    const now = new Date();
    if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '', { mode: 0o600 });
    fs.utimesSync(ACTIVITY_FILE, now, now);
  } catch {}
}

function activityAt(): string | undefined {
  try { return fs.statSync(ACTIVITY_FILE).mtime.toISOString(); } catch { return undefined; }
}

function runtimeCapabilities(): string[] {
  const capabilities = ['pty', 'exec', 'fs', 'git', 'ports', 'agent-adapters', 'task-heartbeat-v2'];
  try {
    const runtime = path.join(os.homedir(), '.orlynx', 'runtime');
    if (fs.readdirSync(runtime).some((name) => /^playwright-.*\.ready$/.test(name))) capabilities.push('browser-e2e');
  } catch {}
  for (const id of bridgeAgentAdapters.keys()) capabilities.push(`agent:${id}`);
  return capabilities;
}

function sendCommandReply(ws: WebSocket, commandId: string, reply: CommandReply): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ kind: 'RESULT', commandId, ...reply })); } catch { /* a replacement socket will receive the durable retry */ }
}
export function runCommandOnce(command: Command, ws: WebSocket): void {
  touchActivity();
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

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safePath(relative = '.'): string {
  const result = path.resolve(REPO_ROOT, relative);
  if (!pathInside(REPO_ROOT, result)) throw new Error('Path is outside the workspace repository.');

  // Lexical containment is not enough: a repository symlink can point outside
  // REPO_ROOT. Validate the existing target, or the nearest existing parent
  // for a path that is about to be created, against the repository realpath.
  const realRoot = fs.realpathSync(REPO_ROOT);
  let probe = result;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (!pathInside(realRoot, realProbe)) throw new Error('Path resolves outside the workspace repository.');
  return result;
}

type VerificationArtifact = {
  path: string;
  kind: 'context' | 'screenshot' | 'trace' | 'report' | 'video' | 'other';
  size: number;
  excerpt?: string;
};

const VERIFICATION_ARTIFACT_ROOTS = [
  'test-results',
  'playwright-report',
  'blob-report',
  'cypress/screenshots',
  'cypress/videos',
  'artifacts',
] as const;

function verificationArtifactKind(relative: string): VerificationArtifact['kind'] {
  const lower = relative.toLowerCase();
  const base = path.basename(lower);
  if (base === 'error-context.md' || base === 'error-context.txt') return 'context';
  if (/\.(png|jpe?g|webp)$/.test(lower)) return 'screenshot';
  if (base === 'trace.zip' || /(?:^|\/)trace[^/]*\.zip$/.test(lower)) return 'trace';
  if (/\.(webm|mp4)$/.test(lower)) return 'video';
  if (/\.(md|txt|log|json|xml|html|htm)$/.test(lower)) return 'report';
  return 'other';
}

function verificationArtifactPriority(artifact: VerificationArtifact): number {
  if (artifact.kind === 'context') return 100;
  if (artifact.kind === 'screenshot') return 90;
  if (artifact.kind === 'trace') return 85;
  if (artifact.kind === 'report') return 70;
  if (artifact.kind === 'video') return 50;
  return 10;
}

function verificationArtifacts(): VerificationArtifact[] {
  const discovered: VerificationArtifact[] = [];
  const maxScannedFiles = 160;
  let scannedFiles = 0;

  const visit = (absolute: string, depth: number): void => {
    if (depth > 6 || scannedFiles >= maxScannedFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (scannedFiles >= maxScannedFiles) break;
      const target = path.join(absolute, entry.name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(target); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(target, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      scannedFiles += 1;

      const relative = path.relative(REPO_ROOT, target).split(path.sep).join('/');
      if (!relative || relative.startsWith('../')) continue;
      const kind = verificationArtifactKind(relative);
      const artifact: VerificationArtifact = { path: relative, kind, size: stat.size };

      const textLike = kind === 'context' || kind === 'report';
      if (textLike && stat.size > 0 && stat.size <= 512_000) {
        try {
          const raw = fs.readFileSync(target, 'utf8').slice(0, 12_000);
          artifact.excerpt = redactSecrets(raw).replace(/\u0000/g, '').slice(0, 6_000);
        } catch { /* binary or unreadable report: metadata is still useful */ }
      }
      discovered.push(artifact);
    }
  };

  for (const root of VERIFICATION_ARTIFACT_ROOTS) {
    const absolute = safePath(root);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absolute); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) visit(absolute, 0);
    else if (stat.isFile()) {
      const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
      discovered.push({ path: relative, kind: verificationArtifactKind(relative), size: stat.size });
    }
  }

  let excerpts = 0;
  return discovered
    .sort((a, b) => verificationArtifactPriority(b) - verificationArtifactPriority(a) || a.path.localeCompare(b.path))
    .slice(0, 40)
    .map((artifact) => {
      if (!artifact.excerpt) return artifact;
      excerpts += 1;
      return excerpts <= 6 ? artifact : { path: artifact.path, kind: artifact.kind, size: artifact.size };
    });
}

function redactSecrets(value: string): string {
  return String(value || '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-github-token]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted-api-key]')
    .replace(/((?:admin\s+)?token|password|secret|api[_ -]?key|authorization|bearer)(\s*(?:[:=]|is)?\s*)([A-Za-z0-9._~+/=-]{16,})/ig, '$1$2[redacted]')
    .replace(/((?:admin\s+)?token[^\n]{0,80}?)([a-f0-9]{40,128})\b/ig, '$1[redacted]');
}
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|secret|password|private.?key|api.?key|credential|authorization/i.test(key) ? '[redacted]' : redactValue(item),
    ]));
  }
  return value;
}
function output(value: string | Buffer | null | undefined): string { return redactSecrets(String(value || '')).slice(0, MAX_OUTPUT); }
function codespacesPreviewEnvironment(): NodeJS.ProcessEnv {
  const domain = String(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || '').trim().replace(/^\.+/, '');
  if (process.env.CODESPACES !== 'true' || !/^[a-z0-9.-]+$/i.test(domain)) return {};
  const allowed = `.${domain}`;
  const current = String(process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!current.includes(allowed)) current.push(allowed);
  return { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: current.join(',') };
}
function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/(ORLYNX_WORKSPACE_TOKEN|OPENCODE_SERVER_PASSWORD|TOKEN|SECRET|PRIVATE.?KEY|API.?KEY|CREDENTIAL)/i.test(name)) env[name] = value;
  return { ...env, ...codespacesPreviewEnvironment(), ...extra };
}
function probeOpenCodeBinary(binary: string): boolean {
  if (!binary) return false;
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: cleanEnvironment(),
  });
  return !result.error && result.status === 0;
}

function nativeOpenCodePackage(): string | undefined {
  const arch = os.arch();
  const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 2_000 });
  const musl = fs.existsSync('/etc/alpine-release') || /musl/i.test(String(ldd.stdout || '') + String(ldd.stderr || ''));
  const suffix = musl ? '-musl' : '';
  if (arch === 'x64') return `opencode-linux-x64-baseline${suffix}`;
  if (arch === 'arm64') return `opencode-linux-arm64${suffix}`;
  return undefined;
}

function openCodeBinaryCandidates(): string[] {
  const candidates = [
    CONFIGURED_OPENCODE_BIN,
    '/opt/orlynx/bin/opencode',
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
  ];
  const modules = path.join(os.homedir(), '.orlynx', 'runtime', 'node_modules');
  try {
    for (const name of fs.readdirSync(modules)) {
      if (/^opencode-linux-/.test(name)) candidates.push(path.join(modules, name, 'bin', 'opencode'));
    }
  } catch {}
  return [...new Set(candidates.filter(Boolean))];
}

function repairOpenCodeBinary(): string | undefined {
  const packageName = nativeOpenCodePackage();
  if (!packageName) return undefined;
  const root = path.join(os.homedir(), '.orlynx', 'runtime', 'opencode-self-heal');
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch {}
  const binary = path.join(root, 'node_modules', packageName, 'bin', 'opencode');
  if (probeOpenCodeBinary(binary)) return binary;

  console.warn(`[bridge] repairing OpenCode runtime package=${packageName} version=${OPENCODE_VERSION}`);
  const install = spawnSync('npm', [
    'install',
    '--prefix', root,
    '--no-save',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    `${packageName}@${OPENCODE_VERSION}`,
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    env: cleanEnvironment(),
  });
  if (install.error || install.status !== 0) {
    const detail = output(install.stderr || install.error?.message || `npm exited ${install.status}`).slice(-1_000);
    console.error(`[bridge] OpenCode self-heal install failed: ${detail}`);
    return undefined;
  }
  if (!probeOpenCodeBinary(binary)) {
    console.error('[bridge] OpenCode self-heal binary failed its startup probe.');
    return undefined;
  }
  return binary;
}

function resolveOpenCodeBinary(): string | undefined {
  for (const candidate of openCodeBinaryCandidates()) {
    if (probeOpenCodeBinary(candidate)) return candidate;
  }
  return repairOpenCodeBinary();
}
function git(args: string[], timeout = 30_000, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout, env: cleanEnvironment(extraEnv) });
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
  const openCodeBinary = resolveOpenCodeBinary();
  if (!openCodeBinary) {
    console.error('[bridge] OpenCode runtime could not be resolved or repaired.');
    return { state: 'failed', reason: 'binary_unavailable' };
  }

  const child = spawn(openCodeBinary, ['serve', '--hostname', '127.0.0.1', '--port', String(OPENCODE_PORT)], {
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
  // A catalog-marked free model belongs to OpenCode's public/free route.
  // Do not inject a saved account credential into that route: free-tier quota
  // and availability are separate from paid/account authentication, and a
  // stale saved key must never turn a free-model failure into "Reconnect AI".
  // Paid/account models still require the isolated workspace credential.
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
let bridgeEventSequence = 0;
function bridgeEvent(ws: WebSocket, type: string, payload: Record<string, unknown>, taskId?: string, runId?: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const sequence = ++bridgeEventSequence;
  const eventId = `${CONNECTION_ID || WORKSPACE_ID || 'bridge'}:${sequence}`;
  const safePayload = redactValue(payload) as Record<string, unknown>;
  ws.send(JSON.stringify({ kind: 'EVENT', event: { eventId, sequence, type, payload: safePayload, taskId, runId } }));
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
export async function runAgent(payload: Record<string, unknown>, ws: WebSocket) {
  try {
    return await runAgentOnce(payload, ws);
  } catch (error) {
    const failure = error as Error & { retrySafe?: boolean; engineSessionId?: string };
    const transient = /\b(?:429|502|503|504)\b|econn|timed out|timeout|connection.*(?:closed|failed)/i.test(failure.message || '');
    const publicRoute = payload.openCodePublicAccess === true && /\b(?:401|403)\b/.test(failure.message || '')
      && !/unsupported|unknown model|model.*not found/i.test(failure.message || '');
    if (!failure.retrySafe || payload.recoveryAttempt || !(transient || publicRoute)) throw error;
    // Replay only before any visible output or tool invocation, and only once.
    // Abort must be acknowledged before a replacement prompt is submitted.
    if (failure.engineSessionId) await opencodeRequest({ path: `/session/${failure.engineSessionId}/abort`, method: 'POST', timeoutMs: 5_000 });
    bridgeEvent(ws, 'activity.progress', { sourceType: 'agent.runtime.retry', text: 'Retrying the selected model…' }, String(payload.taskId || ''), String(payload.runId || ''));
    return runAgentOnce({ ...payload, engineSessionId: '', recoveryAttempt: 1 }, ws);
  }
}

async function runAgentOnce(payload: Record<string, unknown>, ws: WebSocket) {
  const taskId = String(payload.taskId || ''); const runId = String(payload.runId || '');
  const reflectionId = Number(payload.reflectionId || 0);
  let engineSessionId = String(payload.engineSessionId || '');
  if (typeof payload.openCodePublicAccess === 'boolean') {
    const restarted = await ensureOpenCodeAuthMode(payload.openCodePublicAccess);
    if (restarted) engineSessionId = '';
  }
  if (!engineSessionId) {
    const created = await opencodeRequest({ path: '/session', method: 'POST', body: { title: `Orlynx ${String(payload.sessionId || '')}` } }) as { body?: { id?: string } };
    engineSessionId = String(created.body?.id || ''); if (!engineSessionId) throw new Error('OpenCode did not create a session.');
  }

  // Persist the resumable engine-session checkpoint before tool work begins.
  // If the bridge/API restarts mid-turn, the durable command replay can attach
  // to this same OpenCode session instead of silently creating a new one.
  bridgeEvent(ws, 'state.delta', {
    scope: 'harness',
    state: 'executing',
    engineSessionId,
  }, taskId, runId);

  let prior: { body?: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }> };
  try {
    prior = await opencodeRequest({ path: `/session/${engineSessionId}/message`, method: 'GET' });
  } catch (error) {
    if (!/\b404\b/.test(error instanceof Error ? error.message : '')) throw error;
    const created = await opencodeRequest({ path: '/session', method: 'POST', body: { title: `Orlynx ${String(payload.sessionId || '')}` } }) as { body?: { id?: string } };
    engineSessionId = String(created.body?.id || '');
    if (!engineSessionId) throw new Error('OpenCode did not recreate the stale session.');
    prior = { body: [] };
    bridgeEvent(ws, 'state.delta', { scope: 'harness', state: 'executing', engineSessionId }, taskId, runId);
  }
  const previousAssistant = [...(prior.body || [])].reverse().find((message) => message.info?.role === 'assistant')?.info?.id;
  const messageRoles = new Map<string, string>();
  for (const message of prior.body || []) {
    const id = String(message.info?.id || '');
    if (id) messageRoles.set(id, String(message.info?.role || ''));
  }
  const body: Record<string, unknown> = { parts: [{ type: 'text', text: String(payload.text || '') }] };
  if (payload.system) body.system = String(payload.system);
  if (payload.tools && typeof payload.tools === 'object') body.tools = payload.tools;
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
  let lastProgressAt = Date.now();
  let madeProgress = false;
  const markProgress = () => { madeProgress = true; lastProgressAt = Date.now(); };
  const firstProgressMs = Math.max(10_000, Number(process.env.ORLYNX_AGENT_FIRST_PROGRESS_MS || 60_000));
  const silenceMs = Math.max(30_000, Number(process.env.ORLYNX_AGENT_SILENCE_MS || 90_000));
  const toolSilenceMs = Math.max(60_000, Number(process.env.ORLYNX_AGENT_TOOL_SILENCE_MS || 4 * 60_000));
  let lastRetryKey = '';
  let streamFallbackNotified = false;
  const textParts = new Map<string, string>();
  const partMessages = new Map<string, string>();
  const partTypes = new Map<string, string>();
  const partSnapshots = new Map<string, string>();
  const pendingTextDeltas = new Map<string, string>();
  const blockedTextParts = new Set<string>();
  const toolParts = new Map<string, Record<string, any>>();
  const toolStates = new Map<string, string>();
  const toolOutputs = new Map<string, string>();
  const toolFailureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastPlanSignature = '';
  let reflectionDiagnosticEmitted = false;

  const emitRetry = (status: Record<string, any>) => {
    if (Number(status.attempt || 0) > 2) throw new Error('The model provider exceeded the bounded retry budget (HTTP 503).');
    const key = `${status.attempt || 0}:${status.next || 0}:${status.message || ''}`;
    if (key === lastRetryKey) return;
    lastRetryKey = key;
    markProgress();
    bridgeEvent(ws, 'activity.progress', {
      sourceType: 'opencode.retry',
      text: String(status.message || 'Provider is temporarily unavailable. Retrying…'),
      attempt: Number(status.attempt || 0),
      nextAt: Number(status.next || 0),
      provider: status.action?.provider ? String(status.action.provider) : undefined,
      reason: status.action?.reason ? String(status.action.reason) : undefined,
    }, taskId, runId);
  };

function toolSemanticType(toolName: string, command: string, filePath: string): string {
  const tool = toolName.trim().toLowerCase();
  const cmd = command.trim().toLowerCase();
  const testCommand = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|:)|(?:npx\s+)?(?:vitest|jest|mocha)\b|pytest\b|python(?:3)?\s+-m\s+pytest\b|(?:npx\s+)?playwright\s+test\b|node\s+--test\b)/i.test(cmd);
  const buildCommand = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint)\b|(?:npx\s+)?tsc\b|(?:npx\s+)?webpack\b|(?:npx\s+)?vite\s+build\b|(?:npx\s+)?next\s+build\b)/i.test(cmd);
  if (testCommand || /^(?:test|tests|vitest|jest|pytest|mocha|playwright)$/i.test(tool)) return 'test-result';
  if (buildCommand || /^(?:build|compile|typecheck|lint)$/i.test(tool)) return 'build-result';
  if (/^(?:git|commit|push|branch|checkout|merge|rebase)$/i.test(tool) || /^git\s+/.test(cmd)) return 'git';
  if (filePath && /^(?:read|cat|view|inspect|open|grep|search|find|glob)$/i.test(tool)) return 'file-read';
  if (filePath && /^(?:write|edit|patch|apply|create|delete|remove|replace|apply_patch)$/i.test(tool)) return 'file-change';
  if (/^(?:vite|next|astro|remix|serve|preview)$/i.test(tool) || /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b|(?:npx\s+)?vite\b|(?:npx\s+)?next\s+(?:dev|start)\b)/i.test(cmd)) return 'preview';
  if (/^(?:bash|shell|exec|terminal|command)$/i.test(tool) || command) return 'terminal';
  return 'generic';
}


function openCodeTodoItems(input: unknown): { present: boolean; items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority?: 'high' | 'medium' | 'low' }> } {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {};
  const raw = Array.isArray(input) ? input
    : Array.isArray(record.todos) ? record.todos
      : Array.isArray(record.items) ? record.items
        : Array.isArray(record.tasks) ? record.tasks
          : Array.isArray(record.plan) ? record.plan
            : null;
  if (!raw) return { present: false, items: [] };
  const items = raw.slice(0, 50).flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const content = String(item.content || item.text || item.title || item.task || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!content) return [];
    const state = String(item.status || item.state || 'pending').toLowerCase().replace(/[ -]+/g, '_');
    const status: 'pending' | 'in_progress' | 'completed' | 'cancelled' = /^(?:done|complete|completed|success)$/.test(state)
      ? 'completed'
      : /^(?:in_progress|running|active|doing|current)$/.test(state)
        ? 'in_progress'
        : /^(?:cancelled|canceled|skipped)$/.test(state)
          ? 'cancelled'
          : 'pending';
    const rawPriority = String(item.priority || '').toLowerCase();
    const priority: 'high' | 'medium' | 'low' | undefined = rawPriority === 'high' || rawPriority === 'medium' || rawPriority === 'low'
      ? rawPriority
      : undefined;
    return [{ content, status, ...(priority ? { priority } : {}) }];
  });
  return { present: true, items };
}

  const emitTextDelta = (partID: string, delta: string) => {
    if (!delta) return;
    markProgress();
    const before = textParts.get(partID) || '';
    const combined = before + delta;
    const responseOffset = visible.length;
    bridgeEvent(ws, 'message.delta', { delta, messagePartId: partID, offset: before.length, responseOffset }, taskId, runId);
    textParts.set(partID, combined);
    visible += delta;

    if (reflectionId > 0 && !reflectionDiagnosticEmitted) {
      const lineEnd = combined.indexOf('\n');
      const firstLine = (lineEnd >= 0 ? combined.slice(0, lineEnd) : combined).trim();
      if (/^Model\s*[→>-]\s*Orlynx:/i.test(firstLine) && (lineEnd >= 0 || firstLine.length >= 80)) {
        reflectionDiagnosticEmitted = true;
        bridgeEvent(ws, 'activity.progress', {
          sourceType: 'agent.dialogue.model',
          reflectionId,
          text: firstLine.slice(0, 420),
        }, taskId, runId);
      } else if (lineEnd >= 0 && firstLine && !/^Model\s*[→>-]\s*Orlynx:/i.test(firstLine)) {
        // Do not hold or reinterpret normal assistant text when the model does
        // not follow the diagnostic-line convention.
        reflectionDiagnosticEmitted = true;
      }
    }
  };

  const flushTextPart = (partID: string) => {
    if (blockedTextParts.has(partID) || partTypes.get(partID) !== 'text') return;
    const messageID = partMessages.get(partID) || '';
    if (!messageID || messageID === previousAssistant || messageRoles.get(messageID) !== 'assistant') return;

    const pending = pendingTextDeltas.get(partID) || '';
    if (pending) {
      pendingTextDeltas.delete(partID);
      emitTextDelta(partID, pending);
    }

    const snapshot = partSnapshots.get(partID) || '';
    const emitted = textParts.get(partID) || '';
    if (snapshot.startsWith(emitted) && snapshot.length > emitted.length) {
      emitTextDelta(partID, snapshot.slice(emitted.length));
    }
  };

  const emitTool = (part: Record<string, any>) => {
    const state = part.state && typeof part.state === 'object' ? part.state as Record<string, any> : {};
    const status = String(state.status || '');
    const id = String(part.callID || part.id || part.tool || '');
    if (!id || !status) return;

    // OpenCode tool parts carry observable inputs in state.input/part.input.
    // Forward the observable execution metadata and output as it changes so the
    // Orlynx timeline mirrors the engine instead of waiting for completion.
    const input = state.input && typeof state.input === 'object'
      ? state.input as Record<string, any>
      : part.input && typeof part.input === 'object'
        ? part.input as Record<string, any>
        : {};
    const toolName = String(part.tool || 'tool');
    const todoTool = /^(?:todo(?:write)?|write[_-]?todos?|update[_-]?plan)$/i.test(toolName);
    if (todoTool) {
      const plan = openCodeTodoItems(input);
      if (plan.present) {
        const signature = JSON.stringify(plan.items);
        if (signature !== lastPlanSignature) {
          lastPlanSignature = signature;
          markProgress();
          const completed = plan.items.filter((item) => item.status === 'completed' || item.status === 'cancelled').length;
          const active = plan.items.find((item) => item.status === 'in_progress')?.content || '';
          bridgeEvent(ws, 'activity.progress', {
            sourceType: 'agent.plan',
            text: 'Plan',
            items: plan.items,
            completed,
            total: plan.items.length,
            ...(active ? { active } : {}),
          }, taskId, runId);
        }
      }
      // The provider todo tool is control metadata, not user-facing terminal
      // work. Do not spend harness tool budget or render its raw JSON.
      return;
    }
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
    const semanticType = toolSemanticType(toolName, command, filePath);
    const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata as Record<string, any> : {};
    const exitCodeCandidate = metadata.exitCode ?? metadata.exit_code ?? metadata.code;
    const exitCode = Number.isFinite(Number(exitCodeCandidate)) ? Number(exitCodeCandidate) : undefined;
    const common = {
      tool: toolName,
      callId: id,
      semanticType,
      title,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(command ? { command: command.slice(0, 4_000) } : {}),
      ...(filePath ? { path: filePath.slice(0, 1_200) } : {}),
      ...(code ? { code: code.slice(0, 24_000) } : {}),
    };

    const previousStatus = toolStates.get(id);
    if (status !== previousStatus) {
      markProgress();
      toolStates.set(id, status);
      if (status === 'pending') bridgeEvent(ws, 'tool.requested', common, taskId, runId);
      else if (status === 'running') {
        bridgeEvent(ws, 'step.started', { stepId: id, tool: toolName, semanticType, title }, taskId, runId);
        bridgeEvent(ws, 'tool.started', common, taskId, runId);
      }
    }

    const currentOutput = String(state.output || '');
    const previousOutput = toolOutputs.get(id) || '';
    if (currentOutput !== previousOutput) {
      markProgress();
      const appendOnly = currentOutput.startsWith(previousOutput);
      const delta = appendOnly ? currentOutput.slice(previousOutput.length) : currentOutput;
      // Keep each WebSocket/event frame bounded while preserving the complete
      // observable output as an ordered sequence of chunks.
      const chunkSize = 12_000;
      for (let offset = 0; offset < delta.length; offset += chunkSize) {
        bridgeEvent(ws, 'tool.output', {
          ...common,
          outDelta: delta.slice(offset, offset + chunkSize),
          replace: !appendOnly && offset === 0,
        }, taskId, runId);
      }
      toolOutputs.set(id, currentOutput);
    }

    if (status === 'completed' && previousStatus !== 'completed') {
      const pendingFailure = toolFailureTimers.get(id);
      if (pendingFailure) clearTimeout(pendingFailure);
      toolFailureTimers.delete(id);
      bridgeEvent(ws, 'tool.completed', {
        ...common,
        ...(typeof state.time?.end === 'number' ? { endedAt: state.time.end } : {}),
      }, taskId, runId);
      bridgeEvent(ws, 'step.finished', { stepId: id, tool: toolName, semanticType, state: 'success' }, taskId, runId);
    } else if (status === 'error' && previousStatus !== 'error') {
      const priorTimer = toolFailureTimers.get(id);
      if (priorTimer) clearTimeout(priorTimer);
      const timer = setTimeout(() => {
        toolFailureTimers.delete(id);
        if (toolStates.get(id) !== 'error') return;
        // Some OpenCode bash/tool events briefly report error before the final
        // completed part arrives. Delay the visible failure slightly so an
        // error→completed transition with exitCode 0 does not flash a false
        // red health-check row.
        bridgeEvent(ws, 'tool.failed', {
          ...common,
          error: String(state.error || 'Tool failed.').slice(0, 8_000),
        }, taskId, runId);
        bridgeEvent(ws, 'step.finished', { stepId: id, tool: toolName, semanticType, state: 'failed' }, taskId, runId);
      }, 250);
      timer.unref?.();
      toolFailureTimers.set(id, timer);
    }
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
        bridgeEvent(ws, 'message.delta', { delta: text.slice(visible.length), messagePartId: 'snapshot', offset: visible.length, responseOffset: visible.length }, taskId, runId);
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
      const activeTool = [...toolStates.values()].some(state => state === 'running' || state === 'pending');
      const progressLimitMs = activeTool ? toolSilenceMs : madeProgress ? silenceMs : firstProgressMs;
      if (Date.now() - lastProgressAt > progressLimitMs) {
        throw new Error(
          activeTool
            ? 'OpenCode tool stopped making observable progress before completion.'
            : madeProgress
              ? 'OpenCode stopped making progress before completion.'
              : 'OpenCode first response timed out.'
        );
      }
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
            const sessionID = String(properties.sessionID || properties.part?.sessionID || properties.info?.sessionID || '');
            if (sessionID && sessionID !== engineSessionId) continue;

            if (event.type === 'message.part.updated') {
              const part = properties.part && typeof properties.part === 'object' ? properties.part as Record<string, any> : undefined;
              const messageID = String(part?.messageID || '');
              const partID = String(part?.id || '');
              if (partID && messageID) {
                partMessages.set(partID, messageID);
                partTypes.set(partID, String(part?.type || ''));
              }

              if (part?.type === 'text' && partID) {
                if (part.synthetic || part.ignored) {
                  blockedTextParts.add(partID);
                  pendingTextDeltas.delete(partID);
                } else {
                  partSnapshots.set(partID, String(part.text || ''));
                  flushTextPart(partID);
                }
              } else if (part?.type === 'tool' && partID) {
                toolParts.set(partID, part);
                if (messageID !== previousAssistant && messageRoles.get(messageID) === 'assistant') emitTool(part);
              }
            } else if (event.type === 'message.part.delta') {
              if (!properties.field || properties.field === 'text') {
                const messageID = String(properties.messageID || '');
                const partID = String(properties.partID || '');
                const delta = String(properties.delta || '');
                if (messageID && partID && delta && !blockedTextParts.has(partID)) {
                  partMessages.set(partID, messageID);
                  pendingTextDeltas.set(partID, (pendingTextDeltas.get(partID) || '') + delta);
                  flushTextPart(partID);
                }
              }
            } else if (event.type === 'session.status') {
              const status = properties.status && typeof properties.status === 'object' ? properties.status as Record<string, any> : {};
              if (status.type === 'retry') emitRetry(status);
              if (status.type === 'idle') finished = true;
            } else if (event.type === 'session.error') {
              throw new Error(openCodeErrorMessage(properties.error));
            } else if (event.type === 'message.updated') {
              const info = properties.info && typeof properties.info === 'object' ? properties.info as Record<string, any> : {};
              const messageID = String(info.id || '');
              if (messageID) {
                messageRoles.set(messageID, String(info.role || ''));
                if (info.role === 'assistant') {
                  for (const [partID, owner] of partMessages) {
                    if (owner === messageID) {
                      flushTextPart(partID);
                      const toolPart = toolParts.get(partID);
                      if (toolPart && messageID !== previousAssistant) emitTool(toolPart);
                    }
                  }
                }
              }
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
    const previewPorts = await ports();
    return { engineSessionId, responseText, diff: diff.body || [], head: status.head, previewPorts };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    Object.assign(failure, { retrySafe: !visible && toolParts.size === 0, engineSessionId });
    // A timed-out run must not remain alive in OpenCode after Orlynx fails it.
    await opencodeRequest({ path: `/session/${engineSessionId}/abort`, method: 'POST', timeoutMs: 5_000 }).catch(() => undefined);
    throw failure;
  } finally {
    // iterator.next() may still be pending when an error/idle event ends the
    // run. Observe its abort rejection before closing the stream.
    void nextEvent?.catch(() => undefined);
    streamAbort.abort();
    for (const timer of toolFailureTimers.values()) clearTimeout(timer);
    toolFailureTimers.clear();
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
        openCodeTransientHealthFailures = 0;
        openCodeLifecycle = { state: 'ready' };
        return openCodeLifecycle;
      }
      if (openCodeLifecycle.state === 'starting') return openCodeLifecycle;

      // A single slow /global/health response must not flap a working adapter
      // to unavailable. The heartbeat runs every 15 seconds and OpenCode can
      // briefly miss the 2-second probe while handling provider/session work.
      // Require consecutive misses before changing durable readiness.
      if (health === 'unavailable' && openCodeLifecycle.state === 'ready') {
        openCodeTransientHealthFailures += 1;
        if (openCodeTransientHealthFailures < OPENCODE_HEALTH_FAILURE_THRESHOLD) {
          console.warn(`[bridge] transient OpenCode health miss ${openCodeTransientHealthFailures}/${OPENCODE_HEALTH_FAILURE_THRESHOLD}; keeping adapter ready`);
          return openCodeLifecycle;
        }
      }

      openCodeTransientHealthFailures = OPENCODE_HEALTH_FAILURE_THRESHOLD;
      openCodeLifecycle = { state: 'unavailable', ...(health === 'unauthorized' ? { reason: 'auth_mismatch' } : {}) };
      // Repair only the private agent server. Shell/files/Git and repository
      // edits survive; no provider replacement is needed for this fault.
      if (!activeAgents.size && OPENCODE_PASSWORD && Date.now() >= nextOpenCodeRepairAt) {
        nextOpenCodeRepairAt = Date.now() + 60_000;
        openCodeRepair ||= startOpenCode(openCodeAuthMode === 'account', true).finally(() => { openCodeRepair = undefined; });
        openCodeLifecycle = await openCodeRepair;
      }
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
const NON_PREVIEW_PORTS = new Set([22, 23, 25, 2222, 3306, 5432, 5601, 6379, 6380, 9229, 9333, 27017, 27018]);

async function httpPreviewReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(1_500),
      headers: { Accept: 'text/html,*/*;q=0.8', 'User-Agent': 'Orlynx-Preview-Probe/1.0' },
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    // Preview means a browser surface, not merely "some TCP service speaks
    // HTTP". Accept successful/redirect responses, and HTML error/login pages,
    // but reject JSON/text API 4xx roots such as server-dashboard :3001 before
    // its frontend build exists.
    return (response.status >= 200 && response.status < 400)
      || (response.status >= 400 && response.status < 500 && contentType.includes('text/html'));
  } catch {
    return false;
  }
}

type CodespacePortMetadata = { browseUrl?: string; visibility?: string };
let codespacePortsCache: { key: string; expiresAt: number; value: Map<number, CodespacePortMetadata> } | undefined;
let codespacePortsPending: Promise<Map<number, CodespacePortMetadata>> | undefined;
const codespaceForwarders = new Map<number, ReturnType<typeof spawn>>();
let safeGhPortForwarding: boolean | undefined;

function ghSupportsLoopbackPortForwarding(): boolean {
  if (safeGhPortForwarding !== undefined) return safeGhPortForwarding;
  try {
    const result = spawnSync(GH_BIN, ['--version'], { encoding: 'utf8', timeout: 3_000 });
    const match = String(result.stdout || '').match(/gh version\s+(\d+)\.(\d+)\.(\d+)/i);
    const major = Number(match?.[1] || 0);
    const minor = Number(match?.[2] || 0);
    // gh v2.98.0 fixed codespace port-forward listeners to bind loopback by
    // default. Older versions could expose the helper listener on all
    // interfaces, so Orlynx refuses to use them for automatic forwarding.
    safeGhPortForwarding = major > 2 || (major === 2 && minor >= 98);
  } catch {
    safeGhPortForwarding = false;
  }
  return safeGhPortForwarding;
}

async function codespacePortMetadata(force = false): Promise<Map<number, CodespacePortMetadata>> {
  const codespace = String(process.env.CODESPACE_NAME || '');
  if (!codespace) return new Map();
  const authToken = String(process.env.GITHUB_TOKEN || GITHUB_TOKEN || '');
  const cacheKey = `${codespace}:${authToken ? 'auth' : 'anon'}`;
  const now = Date.now();
  if (!force && codespacePortsCache?.key === cacheKey && codespacePortsCache.expiresAt > now) return codespacePortsCache.value;
  if (codespacePortsPending) return codespacePortsPending;

  const pending = new Promise<Map<number, CodespacePortMetadata>>((resolve) => {
    const child = spawn(GH_BIN, [
      'codespace', 'ports',
      '-c', codespace,
      '--json', 'sourcePort,browseUrl,visibility',
    ], {
      cwd: REPO_ROOT,
      env: {
        ...cleanEnvironment(),
        ...(authToken ? { GH_TOKEN: authToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (value: Map<number, CodespacePortMetadata>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(codespacePortsCache?.key === cacheKey ? codespacePortsCache.value : new Map<number, CodespacePortMetadata>());
    }, 3_000);
    timer.unref?.();

    child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-64_000); });
    child.once('error', () => finish(codespacePortsCache?.key === cacheKey ? codespacePortsCache.value : new Map<number, CodespacePortMetadata>()));
    child.once('exit', (code) => {
      if (code !== 0) return finish(codespacePortsCache?.key === cacheKey ? codespacePortsCache.value : new Map<number, CodespacePortMetadata>());
      try {
        const rows = JSON.parse(stdout || '[]') as Array<{ sourcePort?: number; browseUrl?: string; visibility?: string }>;
        const value = new Map<number, CodespacePortMetadata>(rows.flatMap((row) => {
          const port = Number(row.sourcePort);
          return Number.isInteger(port) && port > 0
            ? [[port, { browseUrl: String(row.browseUrl || '') || undefined, visibility: String(row.visibility || '') || undefined }] as const]
            : [];
        }));
        codespacePortsCache = { key: cacheKey, expiresAt: Date.now() + 15_000, value };
        finish(value);
      } catch {
        finish(codespacePortsCache?.key === cacheKey ? codespacePortsCache.value : new Map<number, CodespacePortMetadata>());
      }
    });
  }).finally(() => {
    if (codespacePortsPending === pending) codespacePortsPending = undefined;
  });

  codespacePortsPending = pending;
  return pending;
}

async function ensureCodespaceForwardedPort(port: number): Promise<CodespacePortMetadata | undefined> {
  const codespace = String(process.env.CODESPACE_NAME || '');
  if (!codespace || !ghSupportsLoopbackPortForwarding()) return undefined;

  const existing = (await codespacePortMetadata()).get(port);
  if (existing?.browseUrl) return existing;

  if (!codespaceForwarders.has(port)) {
    const authToken = String(process.env.GITHUB_TOKEN || GITHUB_TOKEN || '');
    const child = spawn(GH_BIN, ['codespace', 'ports', 'forward', `${port}:0`, '-c', codespace], {
      cwd: REPO_ROOT,
      env: {
        ...cleanEnvironment(),
        ...(authToken ? { GH_TOKEN: authToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    codespaceForwarders.set(port, child);
    child.once('exit', () => {
      if (codespaceForwarders.get(port) === child) codespaceForwarders.delete(port);
    });
    child.once('error', () => {
      if (codespaceForwarders.get(port) === child) codespaceForwarders.delete(port);
    });
  }

  // The forwarder creates the GitHub Dev Tunnel port before it begins relaying
  // traffic. Give GitHub a short non-blocking window to publish the browse URL.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const metadata = (await codespacePortMetadata(true)).get(port);
    if (metadata?.browseUrl) return metadata;
  }
  return undefined;
}

function stopUnusedCodespaceForwarders(listening: Set<number>) {
  for (const [port, child] of codespaceForwarders) {
    if (listening.has(port)) continue;
    try { child.kill('SIGTERM'); } catch {}
    codespaceForwarders.delete(port);
  }
}

async function ports() {
  const result = spawnSync('ss', ['-ltnH'], { encoding: 'utf8', timeout: 5_000 });
  const found = new Set<number>();
  const servicePort = Number(process.env.PORT || 0);
  for (const line of String(result.stdout || '').split('\n')) {
    const match = line.match(/:(\d+)\s/);
    if (!match) continue;
    const port = Number(match[1]);
    const loopbackOnly = /(?:^|\s)(?:127(?:\.\d+){3}|\[?::1\]?):\d+\s/.test(line);
    if (
      port <= 1024
      || port === OPENCODE_PORT
      || port === servicePort
      || NON_PREVIEW_PORTS.has(port)
      || loopbackOnly
    ) continue;
    found.add(port);
  }

  const ready = (await Promise.all([...found].map(async (port) => ({
    port,
    ready: await httpPreviewReady(port),
  })))).filter((item) => item.ready);

  stopUnusedCodespaceForwarders(found);
  const codespace = String(process.env.CODESPACE_NAME || '');
  const confirmed = await codespacePortMetadata();
  const values = await Promise.all(ready.map(async ({ port }) => {
    const metadata = confirmed.get(port) || (codespace ? await ensureCodespaceForwardedPort(port) : undefined);
    return {
      port,
      visibility: metadata?.visibility || 'private',
      // For Codespaces, only a URL returned by GitHub's forwarded-port
      // inventory is trustworthy. A locally listening port is not necessarily
      // reachable at app.github.dev yet.
      url: metadata?.browseUrl,
    };
  }));
  return values;
}

async function execute(command: Command, ws: WebSocket): Promise<Record<string, unknown>> {
  const payload = command.payload || {};
  switch (command.type) {
    case 'health': {
      const adapters = await bridgeAdapterHealth();
      // Keep the legacy top-level openCode field while exposing the generic
      // adapter map. Older control-plane builds used health.openCode; newer
      // builds read adapters.opencode.state.
      return { bridge: 'ready', openCode: adapters.opencode?.state, adapters, capabilities: runtimeCapabilities(), activityAt: activityAt() };
    }
    case 'runtime.capabilities': return { capabilities: runtimeCapabilities(), activityAt: activityAt() };
    case 'verification.artifacts': return { artifacts: verificationArtifacts() };
    case 'fs.list': return { files: listFiles(String(payload.path || '.')) };
    case 'fs.read': { const target = safePath(String(payload.path || '')); const stat = fs.statSync(target); if (stat.size > 1_000_000) throw new Error('File is too large to read.'); return { path: path.relative(REPO_ROOT, target), content: fs.readFileSync(target, 'utf8') }; }
    case 'fs.write-attachment': {
      const name = String(payload.name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180); if (!name) throw new Error('Attachment name is invalid.');
      const data = Buffer.from(String(payload.contentBase64 || ''), 'base64'); if (data.length > 15 * 1024 * 1024) throw new Error('Attachment is too large.');
      const directory = safePath('.orlynx/attachments'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const target = safePath(path.join('.orlynx/attachments', name)); fs.writeFileSync(target, data, { mode: 0o600 });
      const exclude = safePath('.git/info/exclude'); const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''; if (!current.split(/\r?\n/).includes('.orlynx/')) fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.orlynx/\n`);
      return { path: path.relative(REPO_ROOT, target).split(path.sep).join('/') };
    }
    case 'git.status': {
      const branch = git(['branch', '--show-current']).trim();
      const head = git(['rev-parse', 'HEAD']).trim();
      const porcelain = git(['status', '--porcelain=v1']);
      let upstream = '';
      let remoteHead = '';
      let ahead = 0;
      let behind = 0;
      try {
        upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
        remoteHead = git(['rev-parse', '@{u}']).trim();
        const counts = git(['rev-list', '--left-right', '--count', '@{u}...HEAD']).trim().split(/\s+/).map(Number);
        behind = Number.isFinite(counts[0]) ? counts[0] : 0;
        ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
      } catch { /* new/local branches may not have an upstream yet */ }
      return { branch, head, porcelain, upstream, remoteHead, ahead, behind };
    }
    case 'git.fetch': {
      if (payload.approved !== true) throw new Error('Fetch requires an approved command.');
      // Managed runners receive an explicit short-lived GitHub token. GitHub
      // Codespaces already provide a repository credential helper, so do not
      // reject them merely because no token variable is present in the bridge.
      const authEnv = GITHUB_TOKEN ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`,
      } : {};
      return { output: git(['fetch', '--prune', 'origin'], 120_000, authEnv) };
    }
    case 'git.sync': {
      if (payload.approved !== true) throw new Error('Repository sync requires an approved control-plane command.');
      const targetBranch = String(payload.branch || '').trim();
      if (!targetBranch || targetBranch.startsWith('-') || targetBranch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(targetBranch)) {
        throw new Error('Repository sync branch is invalid.');
      }
      // Prefer the explicit token on managed runners; otherwise allow the
      // native Codespaces Git credential helper to authenticate the fetch.
      const authEnv = GITHUB_TOKEN ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`,
      } : {};
      const branch = git(['branch', '--show-current']).trim();
      const headBefore = git(['rev-parse', 'HEAD']).trim();
      const porcelainBefore = git(['status', '--porcelain=v1']);
      if (branch !== targetBranch) {
        return { state: 'branch_mismatch', branch, targetBranch, head: headBefore, porcelain: porcelainBefore };
      }

      git(['fetch', '--prune', 'origin', targetBranch], 120_000, authEnv);
      const remoteRef = `origin/${targetBranch}`;
      const remoteHead = git(['rev-parse', remoteRef]).trim();
      const counts = git(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]).trim().split(/\s+/).map(Number);
      const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
      const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;

      if (behind === 0) {
        return { state: 'current', branch, head: headBefore, remoteHead, ahead, behind, porcelain: porcelainBefore };
      }

      // Old persistent workspaces can carry package-lock drift from a previous
      // dependency install even though no dependency change was intended. Do
      // not let that one generated file strand Build on a stale default branch.
      // Preserve the exact patch outside the repository before restoring it.
      // Any source edit, untracked file, second dirty path, or local commit still
      // blocks sync and requires normal reconciliation.
      let porcelain = porcelainBefore;
      let recoveredGeneratedLockfile = false;
      let recoveryPatch: string | undefined;
      if (ahead === 0 && porcelain.trim()) {
        const dirty = porcelain.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
        const packageLockOnly = dirty.length > 0 && dirty.every((line) => {
          if (line.startsWith('??')) return false;
          return line.slice(3).trim().replace(/^"|"$/g, '') === 'package-lock.json';
        });
        if (packageLockOnly) {
          const patch = git(['diff', 'HEAD', '--binary', '--', 'package-lock.json']);
          if (patch.trim()) {
            const recoveryRoot = path.join(os.homedir(), '.orlynx', 'recovery');
            fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
            const recoveryName = `package-lock-${Date.now()}-${headBefore.slice(0, 8)}.patch`;
            fs.writeFileSync(path.join(recoveryRoot, recoveryName), patch, { mode: 0o600 });
            recoveryPatch = path.join('~', '.orlynx', 'recovery', recoveryName);
          }
          git(['restore', '--source=HEAD', '--staged', '--worktree', '--', 'package-lock.json']);
          porcelain = git(['status', '--porcelain=v1']);
          recoveredGeneratedLockfile = !porcelain.trim();
        }
      }

      if (porcelain.trim()) {
        return { state: 'blocked_dirty', branch, head: headBefore, remoteHead, ahead, behind, porcelain };
      }
      if (ahead > 0) {
        return { state: 'blocked_diverged', branch, head: headBefore, remoteHead, ahead, behind, porcelain };
      }

      git(['merge', '--ff-only', remoteRef], 120_000);
      const head = git(['rev-parse', 'HEAD']).trim();
      return {
        state: 'synced',
        branch,
        head,
        previousHead: headBefore,
        remoteHead,
        ahead: 0,
        behind: 0,
        updatedBy: behind,
        recoveredGeneratedLockfile,
        recoveryPatch,
      };
    }
    case 'git.diff': return { diff: git(['diff', '--no-ext-diff', '--', String(payload.path || '.')]) };
    case 'git.read-publication-file': {
      if (payload.approved !== true) throw new Error('Publication file read requires an approved control-plane command.');
      const target = safePath(String(payload.path || ''));
      const stat = fs.lstatSync(target);
      let bytes: Buffer;
      let mode: '100644' | '100755' | '120000';
      if (stat.isSymbolicLink()) {
        bytes = Buffer.from(fs.readlinkSync(target), 'utf8');
        mode = '120000';
      } else {
        if (!stat.isFile()) throw new Error('Publication path is not a regular file.');
        if (stat.size > 1_000_000) throw new Error('Publication file is too large for verified transfer.');
        bytes = fs.readFileSync(target);
        mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
      }
      if (bytes.length > 1_000_000) throw new Error('Publication file is too large for verified transfer.');
      return {
        path: path.relative(REPO_ROOT, target).split(path.sep).join('/'),
        contentBase64: bytes.toString('base64'),
        mode,
        size: bytes.length,
      };
    }
    case 'git.reconcile-published': {
      if (payload.approved !== true) throw new Error('Published-work reconciliation requires an approved control-plane command.');
      const branch = String(payload.branch || '').trim();
      const expectedHead = String(payload.expectedHead || '').trim();
      const publishedHead = String(payload.publishedHead || '').trim();
      const files = Array.isArray(payload.files)
        ? [...new Set(payload.files.map(String).map((value) => value.trim()).filter(Boolean))]
        : [];
      if (!branch || branch.startsWith('-') || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('Published-work branch is invalid.');
      if (!/^[a-f0-9]{40}$/i.test(expectedHead) || !/^[a-f0-9]{40}$/i.test(publishedHead)) throw new Error('Published-work commit identity is invalid.');
      if (!files.length) throw new Error('Published-work reconciliation requires an approved file allowlist.');
      for (const file of files) {
        if (file.startsWith('/') || file.startsWith('-') || file.split('/').includes('..')) throw new Error('Published-work file path is invalid.');
        safePath(file);
      }
      const currentBranch = git(['branch', '--show-current']).trim();
      const currentHead = git(['rev-parse', 'HEAD']).trim();
      if (currentBranch !== branch || currentHead !== expectedHead) throw new Error('Workspace moved before published-work reconciliation.');

      const dirty = git(['status', '--porcelain=v1']).split(/\r?\n/).filter(Boolean).map((line) => {
        const raw = line.length > 3 ? line.slice(3).trim() : '';
        return (raw.includes(' -> ') ? raw.split(' -> ').pop() || raw : raw).replace(/^"|"$/g, '');
      }).filter(Boolean);
      const allow = new Set(files);
      const unrelated = dirty.filter((file) => !allow.has(file));
      if (unrelated.length) throw new Error(`Workspace gained unrelated changes after publication: ${unrelated.slice(0, 8).join(', ')}`);

      const authEnv = GITHUB_TOKEN ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`,
      } : {};
      git(['fetch', '--prune', 'origin', branch], 120_000, authEnv);
      const remoteRef = `origin/${branch}`;
      const remoteHead = git(['rev-parse', remoteRef]).trim();
      if (remoteHead !== publishedHead) throw new Error('Remote branch changed before workspace reconciliation.');
      git(['reset', '--hard', remoteRef], 60_000);
      const head = git(['rev-parse', 'HEAD']).trim();
      if (head !== publishedHead) throw new Error('Workspace did not reach the published commit.');
      return { state: 'reconciled', branch, head };
    }
    case 'git.branch.create': { const branch = String(payload.branch || ''); if (!/^orlynx(?:-e2e)?\/[a-zA-Z0-9._-]+$/.test(branch)) throw new Error('Only an isolated orlynx/* branch may be created through this operation.'); git(['checkout', '-b', branch]); return { branch }; }
    case 'git.commit': {
      const message = String(payload.message || '').trim().slice(0, 240);
      if (!message) throw new Error('Commit message is required.');
      const files = Array.isArray(payload.files)
        ? [...new Set(payload.files.map(String).map((value) => value.trim()).filter(Boolean))]
        : [];
      if (!files.length) throw new Error('Commit requires an approved file allowlist.');
      for (const file of files) {
        if (file.startsWith('/') || file.startsWith('-') || file.split('/').includes('..')) throw new Error('Commit file path is invalid.');
        safePath(file);
      }
      const staged = git(['diff', '--cached', '--name-only']).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      const unrelatedStaged = staged.filter((file) => !files.includes(file));
      if (unrelatedStaged.length) {
        throw new Error(`Commit blocked by unrelated staged files: ${unrelatedStaged.slice(0, 8).join(', ')}`);
      }
      for (const file of files) git(['add', '--', file]);
      git(['commit', '-m', message], 60_000);
      return { sha: git(['rev-parse', 'HEAD']).trim(), files };
    }
    case 'command.exec': { const executable = String(payload.command || ''); const args = Array.isArray(payload.args) ? payload.args.map(String) : []; if (!commandAllowed(executable, args)) throw new Error('Command denied by bridge policy.'); const result = spawnSync(executable, args, { cwd: safePath(String(payload.cwd || '.')), encoding: 'utf8', timeout: Math.min(Number(payload.timeoutMs || 120_000), 300_000), env: cleanEnvironment() }); return { code: result.status ?? 1, stdout: output(result.stdout), stderr: output(result.stderr) }; }
    case 'ports.list': return { ports: await ports() };
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
    openCodeTransientHealthFailures = 0;
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
      if (message.kind === 'HELLO_REQUEST') { ws.send(JSON.stringify({ kind: 'HELLO', workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, userId: USER_ID, connectionId: CONNECTION_ID, bridgeVersion: '2.1.0', os: os.platform(), arch: os.arch(), capabilities: runtimeCapabilities() })); return; }
      if ((message.kind === 'AUTHENTICATED' || message.kind === 'CREDENTIAL') && message.token) {
        token = message.token;
        if (message.kind === 'AUTHENTICATED') {
          if (ws.readyState !== WebSocket.OPEN) return;
          // Workspace readiness is independent of any agent adapter. Make shell,
          // files, Git and ports available immediately; adapters report their
          // own lifecycle asynchronously.
          ws.send(JSON.stringify({ kind: 'READY', repoRoot: REPO_ROOT, capabilities: runtimeCapabilities(), adapters: { opencode: { state: 'starting' } } }));
          void openCodeStartup.then((adapter) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'ADAPTER_STATUS', adapterId: 'opencode', adapter }));
          }).catch((error) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'ADAPTER_STATUS', adapterId: 'opencode', adapter: { state: 'failed', reason: error instanceof Error ? error.message.slice(0, 160) : 'startup_failed' } }));
          });
          heartbeat ||= setInterval(async () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (inFlight.size > 0 || activeAgents.size > 0 || terminals.size > 0) touchActivity();
            const currentAdapters = await bridgeAdapterHealth();
            for (const [adapterId, adapter] of Object.entries(currentAdapters)) {
              ws.send(JSON.stringify({ kind: 'ADAPTER_STATUS', adapterId, adapter }));
            }
            ws.send(JSON.stringify({
              kind: 'EVENT',
              event: {
                type: 'heartbeat',
                payload: {
                  bridge: 'ready',
                  capabilities: runtimeCapabilities(),
                  activityAt: activityAt(),
                  // Workspace liveness is not task liveness. The API renews
                  // only these exact durable tasks, so an idle healthy bridge
                  // cannot keep a dead/hung agent run alive forever.
                  activeTaskIds: [...activeAgents.keys()],
                },
              },
            }));
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
  touchActivity();
  if (!CONTROL.startsWith('wss://') || !token || !WORKSPACE_ID || !SESSION_ID || !USER_ID || !CONNECTION_ID) { console.error('[bridge] required secure workspace configuration is missing'); process.exitCode = 2; return; }
  connect();
}
if (import.meta.url.endsWith(process.argv[1] || '')) start();
