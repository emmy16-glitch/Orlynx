import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.ORLYNX_RUNNER_TOKEN || '';
const IMAGE = process.env.ORLYNX_RUNNER_IMAGE || 'orlynx-runner-runtime:local';
const CPU_LIMIT = process.env.ORLYNX_RUNNER_CPUS || '2';
const MEMORY_LIMIT = process.env.ORLYNX_RUNNER_MEMORY || '4g';
const PIDS_LIMIT = process.env.ORLYNX_RUNNER_PIDS || '512';

function safeId(value) {
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(String(value || ''))) throw new Error('invalid identifier');
  return String(value);
}
function safeBranch(value) {
  const branch = String(value || '');
  if (!branch || branch.length > 240 || /[\s~^:?*[\\]/.test(branch) || branch.includes('..') || branch.startsWith('-')) throw new Error('invalid branch');
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
async function inspect(name) {
  const result = await docker(['inspect', name, '--format', '{{json .State}}'], { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
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
    if (!existing.Running) await docker(['start', name], { timeoutMs: 30_000 });
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
  await docker(createArgs, { timeoutMs: 30_000 });
  try {
    await docker(['start', name], { timeoutMs: 30_000 });
    const auth = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
    const script = `set -eu
IFS= read -r GIT_AUTH_HEADER
if [ ! -d /workspace/repo/.git ]; then
  git -c http.https://github.com/.extraheader="$GIT_AUTH_HEADER" clone --filter=blob:none --single-branch --branch "$ORLYNX_BRANCH" "https://github.com/$ORLYNX_REPOSITORY.git" /workspace/repo
fi
`;
    await docker([
      'exec', '-i',
      '-e', `ORLYNX_BRANCH=${branch}`,
      '-e', `ORLYNX_REPOSITORY=${fullName}`,
      name, 'bash', '-s',
    ], { stdin: `AUTHORIZATION: basic ${auth}\n${script}`, timeoutMs: Math.max(60_000, Number(process.env.ORLYNX_RUNNER_CLONE_TIMEOUT_MS || 180_000)) });
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
  if (!bridgeUrl.startsWith('wss://') || !bridgeToken || !openCodePassword) throw new Error('invalid bridge configuration');
  if (!(await inspect(name))) throw new Error('runner not found');

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
  };
  const encoded = Object.entries(values)
    .map(([key, value]) => `${key}=${Buffer.from(String(value)).toString('base64')}`)
    .join('\n');
  const script = `set -eu
while IFS='=' read -r key value; do
  test -n "$key" || continue
  decoded="$(printf '%s' "$value" | base64 -d)"
  export "$key=$decoded"
done
/opt/orlynx/start-bridge.sh
`;
  await docker(['exec', '-i', name, 'bash', '-s'], { stdin: `${encoded}\n\n${script}`, timeoutMs: 15_000 });
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
    await docker(['start', name], { timeoutMs: 30_000, allowFailure: true });
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
  route(req, res).catch((error) => {
    console.error('[runner-manager]', redact(error instanceof Error ? error.message : error));
    json(res, 502, { error: 'Runner operation failed.', detail: redact(error instanceof Error ? error.message : error) });
  });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '0.0.0.0', () => console.log(`[runner-manager] listening on :${PORT}`));
}
