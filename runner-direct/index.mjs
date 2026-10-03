import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.ORLYNX_RUNNER_TOKEN || '';
const ROOT = process.cwd();
const DATA_ROOT = process.env.ORLYNX_DIRECT_RUNNER_DATA || path.join(os.tmpdir(), 'orlynx-direct-runner');
const REPO_ROOT = path.join(DATA_ROOT, 'repo');
const STATE_FILE = path.join(DATA_ROOT, 'state.json');
const ACTIVITY_FILE = path.join(os.homedir(), '.orlynx', 'runtime', 'activity');
const BRIDGE_PATH = path.join(ROOT, 'bridge', 'dist', 'index.js');
const OPENCODE_BIN = process.env.ORLYNX_DIRECT_OPENCODE_BIN || path.join(ROOT, '.runner-opencode', 'node_modules', '.bin', 'opencode');
const IDLE_SECONDS = Math.max(300, Number(process.env.ORLYNX_RUNNER_IDLE_SECONDS || 1800));
const RECLAIM_SECONDS = Math.max(IDLE_SECONDS, Number(process.env.ORLYNX_RUNNER_RECLAIM_SECONDS || 7200));
const CLEANUP_SECONDS = Math.max(30, Number(process.env.ORLYNX_RUNNER_CLEANUP_SECONDS || 60));
const PREVIEW_COOKIE = 'orlynx_preview';
// Runner protocol/build identity. Render injects RENDER_GIT_COMMIT at deploy
// time; ORLYNX_RUNNER_BUILD allows image builds to stamp the same value.
const RUNNER_PROTOCOL_VERSION = 1;
const RUNNER_BUILD_COMMIT = String(
  process.env.ORLYNX_RUNNER_BUILD || process.env.RENDER_GIT_COMMIT || '',
).slice(0, 40) || null;
const RUNNER_SERVICE_ID = String(process.env.RENDER_SERVICE_ID || '') || null;

let bridgeChild = null;
let lastActivityTouchMs = 0;
let cachedBrowserRuntimeReady;

function browserRuntimeReady() {
  if (process.env.ORLYNX_BROWSER_RUNTIME_READY === '1') return true;
  if (process.env.ORLYNX_BROWSER_RUNTIME_READY === '0') return false;
  if (typeof cachedBrowserRuntimeReady === 'boolean') return cachedBrowserRuntimeReady;
  const probe = spawnSync('sh', ['-lc', [
    "ldconfig -p 2>/dev/null | grep -q 'libatk-1.0.so.0'",
    "ldconfig -p 2>/dev/null | grep -Eq 'libnss3\\.so|libnss3\\.so\\.1d'",
    "ldconfig -p 2>/dev/null | grep -Eq 'libgbm\\.so\\.1|libgbm\\.so'",
  ].join(' && ')], { encoding: 'utf8', timeout: 5_000 });
  cachedBrowserRuntimeReady = probe.status === 0;
  return cachedBrowserRuntimeReady;
}

function touchActivity(force = false) {
  const now = Date.now();
  // Preview assets and HMR can be very chatty. One filesystem timestamp write
  // every 15 seconds is enough to prove the workspace is actively being used.
  if (!force && now - lastActivityTouchMs < 15_000) return;
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '', { mode: 0o600 });
    const stamp = new Date(now);
    fs.utimesSync(ACTIVITY_FILE, stamp, stamp);
    lastActivityTouchMs = now;
  } catch {}
}

function nowIso() { return new Date().toISOString(); }
function safeId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(id)) throw new Error('invalid identifier');
  return id;
}
function safeBranch(value) {
  const branch = String(value || '');
  if (!branch || branch.length > 240 || /[\\\s~^:?*\[\]]/.test(branch) || branch.includes('..') || branch.startsWith('-')) throw new Error('invalid branch');
  return branch;
}
function runnerId(workspaceId) {
  return `orlynx-${safeId(workspaceId).toLowerCase().replace(/_/g, '-')}`.slice(0, 120);
}
function redact(value) {
  return String(value || '')
    .replace(/(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .slice(-4000);
}
function authorized(header) {
  const candidate = String(header || '').startsWith('Bearer ') ? String(header).slice(7) : '';
  if (!TOKEN || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(state) {
  fs.mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}
function removeState() {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
}
function activityEpoch(state) {
  try {
    const stat = fs.statSync(ACTIVITY_FILE);
    return Math.floor(stat.mtimeMs / 1000);
  } catch {}
  const touched = Date.parse(String(state?.updatedAt || state?.createdAt || ''));
  return Number.isFinite(touched) ? Math.floor(touched / 1000) : Math.floor(Date.now() / 1000);
}
function touchState(state) {
  const next = { ...state, updatedAt: nowIso() };
  saveState(next);
  return next;
}
function killBridge() {
  const child = bridgeChild;
  bridgeChild = null;
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
}
async function run(command, args, { cwd = ROOT, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, stdout, stderr };
      if (error) reject(error);
      else if (code !== 0) reject(new Error(redact(stderr || stdout || `${command} exited ${code}`)));
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-12000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-12000); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(undefined, code ?? 1));
  });
}
async function resolveRepository(repositoryId, githubToken) {
  const response = await fetch(`https://api.github.com/repositories/${Number(repositoryId)}`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub repository lookup failed (HTTP ${response.status}).`);
  const body = await response.json();
  const fullName = String(body.full_name || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error('GitHub returned an invalid repository name.');
  return fullName;
}
async function cloneWorkspace(body) {
  const workspaceId = safeId(body.workspaceId);
  const branch = safeBranch(body.branch);
  const repositoryId = Number(body.repositoryId);
  const githubToken = String(body.githubToken || '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !githubToken) throw new Error('invalid repository credentials');

  const id = runnerId(workspaceId);
  let current = loadState();
  if (current?.runnerId === id && fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    current = touchState({ ...current, state: 'running' });
    return { runnerId: id, state: 'running', repoRoot: REPO_ROOT };
  }
  if (current && current.runnerId !== id) {
    const idle = Math.floor(Date.now() / 1000) - activityEpoch(current);

    // A stopped workspace has no live bridge/process ownership and is safe to
    // reassign immediately. The old behavior held this single-capacity Render
    // runner hostage until the long reclaim timer expired.
    if (current.state === 'stopped') {
      console.log(`[direct-runner] reassigning stopped workspace ${current.runnerId} to ${id}`);
      destroyWorkspace(current.runnerId);
      current = null;
    } else if (current.state === 'running' && idle >= IDLE_SECONDS) {
      console.log(`[direct-runner] reclaiming idle workspace ${current.runnerId} for ${id} idleSeconds=${idle}`);
      stopWorkspace(current.runnerId);
      destroyWorkspace(current.runnerId);
      current = null;
    } else {
      const error = new Error('Orlynx direct runner capacity is full.');
      error.statusCode = 409;
      throw error;
    }
  }

  const fullName = await resolveRepository(repositoryId, githubToken);
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  await run('git', ['clone', '--filter=blob:none', '--single-branch', '--branch', branch, `https://github.com/${fullName}.git`, REPO_ROOT], {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
    timeoutMs: Math.max(60_000, Number(process.env.ORLYNX_RUNNER_CLONE_TIMEOUT_MS || 180_000)),
  });

  current = {
    runnerId: id,
    workspaceId,
    sessionId: safeId(body.sessionId),
    userId: safeId(body.userId),
    repositoryId,
    branch,
    state: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  saveState(current);
  return { runnerId: id, state: 'running', repoRoot: REPO_ROOT };
}
function connectWorkspace(id, body) {
  const current = loadState();
  if (!current || current.runnerId !== id || !fs.existsSync(path.join(REPO_ROOT, '.git'))) throw Object.assign(new Error('runner not found'), { statusCode: 404 });

  const bridgeUrl = String(body.bridgeUrl || '');
  const bridgeToken = String(body.bridgeToken || '');
  const openCodePassword = String(body.openCodePassword || '');
  const githubToken = String(body.githubToken || '');
  if (!bridgeUrl.startsWith('wss://') || !bridgeToken || !openCodePassword || !githubToken) throw new Error('invalid bridge configuration');
  if (!fs.existsSync(BRIDGE_PATH)) throw new Error('runner bridge is not built');
  if (!fs.existsSync(OPENCODE_BIN)) throw new Error('runner OpenCode binary is not installed');

  killBridge();
  const env = {
    ...process.env,
    ORLYNX_CONTROL: bridgeUrl,
    ORLYNX_WORKSPACE_TOKEN: bridgeToken,
    ORLYNX_WORKSPACE_ID: safeId(body.workspaceId),
    ORLYNX_SESSION_ID: safeId(body.sessionId),
    ORLYNX_USER_ID: safeId(body.userId),
    ORLYNX_CONNECTION_ID: safeId(body.connectionId),
    OPENCODE_SERVER_PASSWORD: openCodePassword,
    ORLYNX_REPO_ROOT: REPO_ROOT,
    OPENCODE_API_KEY: String(body.openCodeApiKey || ''),
    ORLYNX_OPENROUTER_API_KEY: String(body.openRouterApiKey || process.env.ORLYNX_OPENROUTER_API_KEY || ''),
    ORLYNX_MINI_SWE_API_BASE: String(body.miniSweApiBase || process.env.ORLYNX_MINI_SWE_API_BASE || ''),
    ORLYNX_MINI_SWE_MODEL: String(body.miniSweModel || process.env.ORLYNX_MINI_SWE_MODEL || ''),
    ORLYNX_CLINE_API_BASE: String(body.clineApiBase || process.env.ORLYNX_CLINE_API_BASE || ''),
    ORLYNX_CLINE_MODEL: String(body.clineModel || process.env.ORLYNX_CLINE_MODEL || ''),
    ORLYNX_GITHUB_TOKEN: githubToken,
    OPENCODE_BIN,
  };
  bridgeChild = spawn(process.execPath, [BRIDGE_PATH], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    detached: true,
  });
  const pid = bridgeChild.pid;
  bridgeChild.once('exit', (code, signal) => {
    if (bridgeChild?.pid === pid) bridgeChild = null;
    console.warn(`[direct-runner] bridge exited code=${code ?? '-'} signal=${signal || '-'}`);
  });
  touchState({ ...current, state: 'running' });
}
function stopWorkspace(id) {
  const current = loadState();
  if (!current || current.runnerId !== id) throw Object.assign(new Error('runner not found'), { statusCode: 404 });
  killBridge();
  saveState({ ...current, state: 'stopped', updatedAt: nowIso() });
}
function destroyWorkspace(id) {
  const current = loadState();
  if (current && id && current.runnerId !== id) return;
  killBridge();
  try { fs.rmSync(REPO_ROOT, { recursive: true, force: true }); } catch {}
  removeState();
}
function previewSignature(name, port, expires) {
  return crypto.createHmac('sha256', TOKEN).update(`${name}:${port}:${expires}`).digest('base64url');
}
function validPreviewToken(name, port, token) {
  if (!TOKEN || !/^orlynx-[a-z0-9-]{3,120}$/.test(name)) return false;
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || port === 4096) return false;
  const [expiresRaw, signature = ''] = String(token || '').split('.');
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || !signature) return false;
  const expected = Buffer.from(previewSignature(name, port, expires));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function encodePreviewCookie(name, port, token) {
  return Buffer.from(JSON.stringify({ name, port, token })).toString('base64url');
}
function cookieValue(header, name) {
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=');
    if (index >= 0 && item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
  }
  return '';
}
function previewContext(req, url) {
  const initial = url.pathname.match(/^\/preview\/(orlynx-[a-z0-9-]{3,120})\/(\d{4,5})(\/.*)?$/);
  if (initial) {
    const name = initial[1];
    const port = Number(initial[2]);
    const token = String(url.searchParams.get('t') || '');
    if (!validPreviewToken(name, port, token)) return { denied: true };
    const state = loadState();
    if (!state || state.runnerId !== name || state.state !== 'running') return { denied: true };
    const params = new URLSearchParams(url.searchParams);
    params.delete('t');
    const pathValue = (initial[3] || '/') + (params.size ? `?${params.toString()}` : '');
    const maxAge = Math.max(1, Number(token.split('.')[0]) - Math.floor(Date.now() / 1000));
    return {
      name, port, path: pathValue,
      cookie: `${PREVIEW_COOKIE}=${encodePreviewCookie(name, port, token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
    };
  }
  if (url.pathname === '/health' || url.pathname.startsWith('/v1/')) return null;
  const encoded = cookieValue(req.headers.cookie, PREVIEW_COOKIE);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const name = String(parsed.name || '');
    const port = Number(parsed.port);
    const token = String(parsed.token || '');
    const state = loadState();
    if (!state || state.runnerId !== name || state.state !== 'running' || !validPreviewToken(name, port, token)) return null;
    return { name, port, path: url.pathname + url.search };
  } catch { return null; }
}
function proxyHeaders(headers, port) {
  const next = { ...headers, host: `127.0.0.1:${port}` };
  delete next.authorization;
  delete next.cookie;
  delete next['proxy-authorization'];
  return next;
}
function proxyPreview(req, res, context) {
  touchActivity();
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: context.port,
    path: context.path,
    method: req.method,
    headers: proxyHeaders(req.headers, context.port),
  }, (response) => {
    const headers = { ...response.headers };
    const existing = headers['set-cookie'];
    if (context.cookie) {
      headers['set-cookie'] = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), context.cookie];
    }
    headers['referrer-policy'] = 'no-referrer';
    res.writeHead(response.statusCode || 502, headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'Preview server is unavailable.' });
    else res.destroy();
  });
  req.pipe(upstream);
}
async function route(req, res) {
  const url = new URL(req.url || '/', 'http://runner.local');
  if (req.method === 'GET' && url.pathname === '/health') {
    const state = loadState();
    const healthy = Boolean(TOKEN && fs.existsSync(BRIDGE_PATH) && fs.existsSync(OPENCODE_BIN));
    const running = state?.state === 'running' ? 1 : 0;
    const stopped = state && state.state !== 'running' ? 1 : 0;
    return json(res, healthy ? 200 : 503, {
      ok: healthy,
      service: 'orlynx-direct-runner',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      buildCommit: RUNNER_BUILD_COMMIT,
      serviceId: RUNNER_SERVICE_ID,
      hostId: String(process.env.ORLYNX_RUNNER_HOST_ID || 'direct-default'),
      region: String(process.env.ORLYNX_RUNNER_REGION || '') || undefined,
      capacity: 1,
      running,
      stopped,
      available: running ? 0 : 1,
      draining: process.env.ORLYNX_RUNNER_DRAINING === '1',
      capabilities: {
        browserE2e: browserRuntimeReady(),
      },
      workspace: state ? { runnerId: state.runnerId, state: state.state } : null,
    });
  }
  if (!authorized(req.headers.authorization)) return json(res, 401, { error: 'Unauthorized.' });

  if (req.method === 'POST' && url.pathname === '/v1/workspaces') {
    return json(res, 201, await cloneWorkspace(await readJson(req)));
  }
  const match = url.pathname.match(/^\/v1\/workspaces\/(orlynx-[a-z0-9-]{3,120})(?:\/(connect|start|stop))?$/);
  if (!match) return json(res, 404, { error: 'Not found.' });
  const id = match[1];
  const action = match[2];
  const current = loadState();

  if (req.method === 'GET' && !action) {
    if (!current || current.runnerId !== id) return json(res, 404, { error: 'Runner not found.' });
    return json(res, 200, { runnerId: id, state: current.state, repoRoot: REPO_ROOT });
  }
  if (req.method === 'POST' && action === 'connect') {
    connectWorkspace(id, await readJson(req));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && action === 'start') {
    if (!current || current.runnerId !== id) return json(res, 404, { error: 'Runner not found.' });
    saveState({ ...current, state: 'running', updatedAt: nowIso() });
    return json(res, 200, { runnerId: id, state: 'running', repoRoot: REPO_ROOT });
  }
  if (req.method === 'POST' && action === 'stop') {
    stopWorkspace(id);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method === 'DELETE' && !action) {
    destroyWorkspace(id);
    res.statusCode = 204;
    return res.end();
  }
  return json(res, 405, { error: 'Method not allowed.' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://runner.local');
  const preview = previewContext(req, url);
  if (preview?.denied) return json(res, 401, { error: 'Preview link is invalid or expired.' });
  if (preview) return proxyPreview(req, res, preview);
  route(req, res).catch((error) => {
    console.error('[direct-runner]', redact(error instanceof Error ? error.message : error));
    json(res, Number(error?.statusCode) || 502, { error: 'Runner operation failed.', detail: redact(error instanceof Error ? error.message : error) });
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://runner.local');
  const preview = previewContext(req, url);
  if (!preview || preview.denied) { socket.destroy(); return; }
  touchActivity();
  socket.on('data', () => touchActivity());
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: preview.port,
    path: preview.path,
    method: req.method,
    headers: proxyHeaders(req.headers, preview.port),
  });
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    let status = `HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}\r\n`;
    for (const [key, value] of Object.entries(response.headers)) {
      if (value == null || key.toLowerCase() === 'set-cookie') continue;
      for (const item of Array.isArray(value) ? value : [value]) status += `${key}: ${item}\r\n`;
    }
    status += '\r\n';
    socket.write(status);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.on('data', () => touchActivity());
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on('response', (response) => {
    socket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

const cleanup = setInterval(() => {
  const state = loadState();
  if (!state) return;
  const idle = Math.max(0, Math.floor(Date.now() / 1000) - activityEpoch(state));
  if (state.state === 'running' && idle >= IDLE_SECONDS) {
    console.log(`[direct-runner] stopping idle workspace ${state.runnerId} idleSeconds=${idle}`);
    stopWorkspace(state.runnerId);
  } else if (state.state === 'stopped' && idle >= RECLAIM_SECONDS) {
    console.log(`[direct-runner] reclaiming workspace ${state.runnerId} idleSeconds=${idle}`);
    destroyWorkspace(state.runnerId);
  }
}, CLEANUP_SECONDS * 1000);
cleanup.unref?.();

process.on('SIGTERM', () => { killBridge(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { killBridge(); server.close(() => process.exit(0)); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[direct-runner] listening on :${PORT} capacity=1 idleSeconds=${IDLE_SECONDS}`);
  async function reportAdapterReadiness() {
    try {
      const { portableHealth } = await import('../bridge/dist/portable-agents.js');
      const adapters = await Promise.all(['mini-swe', 'cline'].map(async adapterId => ({ adapterId, ...await portableHealth(adapterId, ROOT) })));
      // Only bounded public health results are logged. Never log environment,
      // credentials, provider replies, or private model diagnostics.
      console.log(`[direct-runner] adapter-readiness ${JSON.stringify(adapters)}`);
    } catch { console.warn('[direct-runner] adapter-readiness probe unavailable'); }
  }
  if (process.env.ORLYNX_INSTALL_MINI_SWE === '1' && !fs.existsSync(path.join(ROOT, '.runner-mini-swe', 'bin', 'python'))) {
    // Optional installation runs independently of the OpenCode startup path.
    run('bash',[path.join(ROOT,'scripts','install-mini-swe-runtime.sh')],{timeoutMs:180000}).then(()=>console.log('[direct-runner] mini-SWE 2.4.6 import verified')).catch(()=>console.warn('[direct-runner] optional mini-SWE installation unavailable; OpenCode remains available')).finally(reportAdapterReadiness);
  } else void reportAdapterReadiness();
});
