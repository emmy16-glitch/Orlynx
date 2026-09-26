import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.ORLYNX_RUNNER_TOKEN || '';
const IMAGE = process.env.ORLYNX_RUNNER_IMAGE || 'orlynx-runner-runtime:local';
const CPU_LIMIT = process.env.ORLYNX_RUNNER_CPUS || '2';
const MEMORY_LIMIT = process.env.ORLYNX_RUNNER_MEMORY || '4g';
const PIDS_LIMIT = process.env.ORLYNX_RUNNER_PIDS || '512';
const PREVIEW_PROXY_PORT = Number(process.env.ORLYNX_RUNNER_PREVIEW_PROXY_PORT || 4108);
const MAX_RUNNING = Math.max(1, Number(process.env.ORLYNX_RUNNER_MAX_WORKSPACES || 4));
const IDLE_SECONDS = Math.max(300, Number(process.env.ORLYNX_RUNNER_IDLE_SECONDS || 3600));
const RECLAIM_SECONDS = Math.max(IDLE_SECONDS, Number(process.env.ORLYNX_RUNNER_RECLAIM_SECONDS || 21600));
const CLEANUP_SECONDS = Math.max(30, Number(process.env.ORLYNX_RUNNER_CLEANUP_SECONDS || 60));
const ACTIVITY_FILE = '/home/orlynx/.orlynx/runtime/activity';

function safeId(value) {
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(String(value || ''))) throw new Error('invalid identifier');
  return String(value);
}
function safeBranch(value) {
  const branch = String(value || '');
  if (!branch || branch.length > 240 || /[\\\s~^:?*\[\]]/.test(branch) || branch.includes('..') || branch.startsWith('-')) throw new Error('invalid branch');
  return branch;
}
function containerName(workspaceId) {
  return `orlynx-${safeId(workspaceId).toLowerCase().replace(/_/g, '-')}`.slice(0, 120);
}
function authorized(header) {
  const candidate = String(header || '').startsWith('Bearer ') ? String(header).slice(7) : '';
  if (!TOKEN || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PREVIEW_COOKIE = 'orlynx_preview';
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
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
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
    const params = new URLSearchParams(url.searchParams);
    params.delete('t');
    const path = (initial[3] || '/') + (params.size ? `?${params.toString()}` : '');
    const maxAge = Math.max(1, Number(token.split('.')[0]) - Math.floor(Date.now() / 1000));
    return {
      name, port, path,
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
    if (!validPreviewToken(name, port, token)) return null;
    return { name, port, path: url.pathname + url.search };
  } catch {
    return null;
  }
}
function redact(text) {
  return String(text || '').replace(/(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]').slice(-4000);
}
function run(command, args, { env = {}, stdin = '', timeoutMs = 60_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
      else if (code !== 0 && !allowFailure) reject(new Error(redact(stderr || stdout || `${command} exited ${code}`)));
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      force.unref?.();
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-8000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(undefined, code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
async function docker(args, options) {
  return run('docker', args, options);
}

async function managedNames(runningOnly = false) {
  const args = ['ps', ...(runningOnly ? [] : ['-a']), '--filter', 'label=orlynx.workspace', '--format', '{{.Names}}'];
  const result = await docker(args, { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0) return [];
  return result.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
}

let allocationTail = Promise.resolve();
async function withAllocationLock(fn) {
  const previous = allocationTail;
  let release;
  allocationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); }
  finally { release(); }
}

async function assertRunnerCapacity(excludeName = '') {
  const running = (await managedNames(true)).filter((name) => name !== excludeName);
  if (running.length >= MAX_RUNNING) throw new Error(`Orlynx runner capacity is full (${running.length}/${MAX_RUNNING}).`);
}

async function startManagedContainer(name) {
  return withAllocationLock(async () => {
    const state = await inspect(name);
    if (!state) throw new Error('runner not found');
    if (state.Running) return;
    await assertRunnerCapacity(name);
    await docker(['start', name], { timeoutMs: 30_000 });
  });
}

async function touchManagedActivity(name) {
  await docker(['exec', name, 'sh', '-c', `mkdir -p "${ACTIVITY_FILE%/*}" && touch "${ACTIVITY_FILE}"`], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
}

async function activityEpoch(name, state) {
  if (state?.Running) {
    const result = await docker(['exec', name, 'stat', '-c', '%Y', ACTIVITY_FILE], { allowFailure: true, timeoutMs: 5_000 });
    const value = Number(result.stdout.trim());
    if (result.code === 0 && Number.isFinite(value) && value > 0) return value;
    const started = Date.parse(String(state.StartedAt || ''));
    return Number.isFinite(started) ? Math.floor(started / 1000) : Math.floor(Date.now() / 1000);
  }
  const finished = Date.parse(String(state?.FinishedAt || ''));
  return Number.isFinite(finished) ? Math.floor(finished / 1000) : Math.floor(Date.now() / 1000);
}

async function cleanupManagedRunners() {
  const names = await managedNames(false);
  const now = Math.floor(Date.now() / 1000);
  for (const name of names) {
    await withAllocationLock(async () => {
      const state = await inspect(name);
      if (!state) return;
      const last = await activityEpoch(name, state);
      const idle = Math.max(0, now - last);
      if (state.Running && idle >= IDLE_SECONDS) {
        console.log(`[runner-manager] stopping idle workspace ${name} idleSeconds=${idle}`);
        await docker(['stop', '--time', '10', name], { allowFailure: true, timeoutMs: 30_000 });
        return;
      }
      if (!state.Running && idle >= RECLAIM_SECONDS) {
        console.log(`[runner-manager] reclaiming stopped workspace ${name} idleSeconds=${idle}`);
        await docker(['rm', '-f', name], { allowFailure: true, timeoutMs: 30_000 });
      }
    });
  }
}
async function inspect(name) {
  const result = await docker(['inspect', name, '--format', '{{json .State}}'], { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

async function containerAddress(name) {
  const result = await docker(['inspect', name, '--format', '{{json .NetworkSettings.Networks}}'], { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  try {
    const networks = JSON.parse(result.stdout.trim());
    for (const value of Object.values(networks || {})) {
      const address = String(value?.IPAddress || '');
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return address;
    }
  } catch {}
  return null;
}

function upstreamHeaders(headers, address, port) {
  const next = { ...headers, host: `${address}:${port}` };
  delete next.authorization;
  delete next.cookie;
  delete next['proxy-authorization'];
  return next;
}

async function proxyPreview(req, res, context) {
  const address = await containerAddress(context.name);
  if (!address) return json(res, 404, { error: 'Preview workspace is unavailable.' });

  const upstream = http.request({
    hostname: address,
    port: PREVIEW_PROXY_PORT,
    path: `/proxy/${context.port}${context.path}`,
    method: req.method,
    headers: upstreamHeaders(req.headers, address, PREVIEW_PROXY_PORT),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    const existingCookies = headers['set-cookie'];
    if (context.cookie) {
      headers['set-cookie'] = [
        ...(Array.isArray(existingCookies) ? existingCookies : existingCookies ? [existingCookies] : []),
        context.cookie,
      ];
    }
    headers['referrer-policy'] = 'no-referrer';
    res.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', (error) => {
    console.warn('[runner-manager] preview proxy failed', redact(error.message));
    if (!res.headersSent) json(res, 502, { error: 'Preview server is unavailable.' });
    else res.destroy(error);
  });
  req.pipe(upstream);
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
async function createWorkspace(body) {
  const workspaceId = safeId(body.workspaceId);
  const sessionId = safeId(body.sessionId);
  const userId = safeId(body.userId);
  const branch = safeBranch(body.branch);
  const repositoryId = Number(body.repositoryId);
  const githubToken = String(body.githubToken || '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !githubToken) throw new Error('invalid repository credentials');
  const name = containerName(workspaceId);

  const existing = await inspect(name);
  if (existing) {
    if (!existing.Running) await startManagedContainer(name);
    return { runnerId: name, state: 'running', repoRoot: '/workspace/repo' };
  }

  const fullName = await resolveRepository(repositoryId, githubToken);
  const createArgs = [
    'create',
    '--name', name,
    '--label', `orlynx.workspace=${workspaceId}`,
    '--label', `orlynx.session=${sessionId}`,
    '--label', `orlynx.user=${userId}`,
    '--cpus', CPU_LIMIT,
    '--memory', MEMORY_LIMIT,
    '--pids-limit', PIDS_LIMIT,
    '--security-opt', 'no-new-privileges:true',
    '--cap-drop', 'ALL',
    IMAGE,
  ];
  await withAllocationLock(async () => {
    const raced = await inspect(name);
    if (raced) {
      if (!raced.Running) {
        await assertRunnerCapacity(name);
        await docker(['start', name], { timeoutMs: 30_000 });
      }
      return;
    }
    await assertRunnerCapacity();
    await docker(createArgs, { timeoutMs: 30_000 });
    await docker(['start', name], { timeoutMs: 30_000 });
  });
  try {
    const auth = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
    const authEncoded = Buffer.from(`AUTHORIZATION: basic ${auth}`).toString('base64');
    const branchEncoded = Buffer.from(branch).toString('base64');
    const repoEncoded = Buffer.from(fullName).toString('base64');
    const script = `set -eu
GIT_AUTH_HEADER="$(printf '%s' '${authEncoded}' | base64 -d)"
ORLYNX_BRANCH="$(printf '%s' '${branchEncoded}' | base64 -d)"
ORLYNX_REPOSITORY="$(printf '%s' '${repoEncoded}' | base64 -d)"
if [ ! -d /workspace/repo/.git ]; then
  git -c http.https://github.com/.extraheader="$GIT_AUTH_HEADER" clone --filter=blob:none --single-branch --branch "$ORLYNX_BRANCH" "https://github.com/$ORLYNX_REPOSITORY.git" /workspace/repo
fi
unset GIT_AUTH_HEADER
`;
    await docker(['exec', '-i', name, 'bash', '-s'], {
      stdin: script,
      timeoutMs: Math.max(60_000, Number(process.env.ORLYNX_RUNNER_CLONE_TIMEOUT_MS || 180_000)),
    });
  } catch (error) {
    await docker(['rm', '-f', name], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
    throw error;
  }
  return { runnerId: name, state: 'running', repoRoot: '/workspace/repo' };
}
async function connectWorkspace(name, body) {
  const workspaceId = safeId(body.workspaceId);
  const sessionId = safeId(body.sessionId);
  const userId = safeId(body.userId);
  const connectionId = safeId(body.connectionId);
  const bridgeUrl = String(body.bridgeUrl || '');
  const bridgeToken = String(body.bridgeToken || '');
  const openCodePassword = String(body.openCodePassword || '');
  const openCodeApiKey = String(body.openCodeApiKey || '');
  const githubToken = String(body.githubToken || '');
  if (!bridgeUrl.startsWith('wss://') || !bridgeToken || !openCodePassword || !githubToken) throw new Error('invalid bridge configuration');
  if (!(await inspect(name))) throw new Error('runner not found');
  await touchManagedActivity(name);

  const values = {
    ORLYNX_CONTROL: bridgeUrl,
    ORLYNX_WORKSPACE_TOKEN: bridgeToken,
    ORLYNX_WORKSPACE_ID: workspaceId,
    ORLYNX_SESSION_ID: sessionId,
    ORLYNX_USER_ID: userId,
    ORLYNX_CONNECTION_ID: connectionId,
    OPENCODE_SERVER_PASSWORD: openCodePassword,
    ORLYNX_REPO_ROOT: '/workspace/repo',
    OPENCODE_API_KEY: openCodeApiKey,
    ORLYNX_GITHUB_TOKEN: githubToken,
  };
  const exports = Object.entries(values)
    .map(([key, value]) => `export ${key}="$(printf '%s' '${Buffer.from(String(value)).toString('base64')}' | base64 -d)"`)
    .join('\n');
  const script = `set -eu
${exports}
/opt/orlynx/start-bridge.sh
`;
  await docker(['exec', '-i', name, 'bash', '-s'], { stdin: script, timeoutMs: 15_000 });
}
async function route(req, res) {
  const url = new URL(req.url || '/', 'http://runner.local');
  if (req.method === 'GET' && url.pathname === '/health') {
    const probe = await docker(['version', '--format', '{{.Client.Version}}'], { allowFailure: true, timeoutMs: 5_000 }).catch(() => ({ code: 1 }));
    return json(res, probe.code === 0 && TOKEN ? 200 : 503, { ok: probe.code === 0 && Boolean(TOKEN), service: 'orlynx-runner-manager', image: IMAGE });
  }
  if (!authorized(req.headers.authorization)) return json(res, 401, { error: 'Unauthorized.' });

  if (req.method === 'POST' && url.pathname === '/v1/workspaces') {
    const body = await readJson(req);
    return json(res, 201, await createWorkspace(body));
  }

  const match = url.pathname.match(/^\/v1\/workspaces\/([A-Za-z0-9-]+)(?:\/(connect|start|stop))?$/);
  if (!match) return json(res, 404, { error: 'Not found.' });
  const name = match[1];
  const action = match[2];

  if (req.method === 'GET' && !action) {
    const state = await inspect(name);
    if (!state) return json(res, 404, { error: 'Runner not found.' });
    return json(res, 200, { runnerId: name, state: state.Running ? 'running' : state.Status === 'exited' ? 'stopped' : String(state.Status || 'starting'), repoRoot: '/workspace/repo' });
  }
  if (req.method === 'POST' && action === 'connect') {
    const body = await readJson(req);
    await connectWorkspace(name, body);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && action === 'start') {
    if (!(await inspect(name))) return json(res, 404, { error: 'Runner not found.' });
    await startManagedContainer(name);
    return json(res, 200, { runnerId: name, state: 'running', repoRoot: '/workspace/repo' });
  }
  if (req.method === 'POST' && action === 'stop') {
    if (!(await inspect(name))) return json(res, 404, { error: 'Runner not found.' });
    await docker(['stop', '--time', '10', name], { timeoutMs: 30_000, allowFailure: true });
    return json(res, 204, {});
  }
  if (req.method === 'DELETE' && !action) {
    await docker(['rm', '-f', name], { timeoutMs: 30_000, allowFailure: true });
    return json(res, 204, {});
  }
  return json(res, 405, { error: 'Method not allowed.' });
}

export const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://runner.local');
  const preview = previewContext(req, url);
  if (preview?.denied) return json(res, 401, { error: 'Preview link is invalid or expired.' });
  if (preview) {
    void proxyPreview(req, res, preview).catch((error) => {
      console.error('[runner-manager] preview failed', redact(error instanceof Error ? error.message : error));
      if (!res.headersSent) json(res, 502, { error: 'Preview server is unavailable.' });
      else res.destroy();
    });
    return;
  }

  route(req, res).catch((error) => {
    console.error('[runner-manager]', redact(error instanceof Error ? error.message : error));
    json(res, 502, { error: 'Runner operation failed.', detail: redact(error instanceof Error ? error.message : error) });
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://runner.local');
  const preview = previewContext(req, url);
  if (!preview || preview.denied) { socket.destroy(); return; }

  void (async () => {
    const address = await containerAddress(preview.name);
    if (!address) { socket.destroy(); return; }
    const upstream = http.request({
      hostname: address,
      port: PREVIEW_PROXY_PORT,
      path: `/proxy/${preview.port}${preview.path}`,
      method: req.method,
      headers: upstreamHeaders(req.headers, address, PREVIEW_PROXY_PORT),
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
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstream.on('response', (response) => {
      socket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  })().catch(() => socket.destroy());
});

const cleanupTimer = setInterval(() => {
  void cleanupManagedRunners().catch((error) => console.warn('[runner-manager] cleanup failed', redact(error instanceof Error ? error.message : error)));
}, CLEANUP_SECONDS * 1000);
cleanupTimer.unref?.();

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[runner-manager] listening on :${PORT} maxRunning=${MAX_RUNNING} idleSeconds=${IDLE_SECONDS}`);
    void cleanupManagedRunners().catch(() => {});
  });
}
