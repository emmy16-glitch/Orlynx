import type { WorkspaceRecord } from '@orlynx/shared';
import { githubUserAccessToken } from './github.js';
import { Sandbox } from '@vercel/sandbox';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

type Values = { bridgeToken: string; connectionId: string; openCodePassword: string };
const bridgeBundle = fileURLToPath(new URL('../../../bridge/dist/index.js', import.meta.url));
const OPENCODE_VERSION = '1.18.32';
let cachedBridgeRevision = '';
export function bridgeRuntimeRevision(): string {
  if (!cachedBridgeRevision) cachedBridgeRevision = createHash('sha256').update(fs.readFileSync(bridgeBundle)).digest('hex').slice(0, 12);
  return cachedBridgeRevision;
}
function encoded(value: string): string { return Buffer.from(value).toString('base64'); }
function sandboxCredentials() {
  return process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
    ? { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
    : {};
}
function bootstrapScript(workspace: WorkspaceRecord, values: Values, bridgeUrl: string, openCodeApiKey = ''): string {
  const bridge = fs.readFileSync(bridgeBundle, 'utf8');
  const envValues = [`ORLYNX_CONTROL=${bridgeUrl}`, `ORLYNX_WORKSPACE_TOKEN=${values.bridgeToken}`, `ORLYNX_WORKSPACE_ID=${workspace.id}`, `ORLYNX_SESSION_ID=${workspace.sessionId}`, `ORLYNX_USER_ID=${workspace.userId}`, `ORLYNX_CONNECTION_ID=${values.connectionId}`, `OPENCODE_SERVER_PASSWORD=${values.openCodePassword}`];
  if (openCodeApiKey) envValues.push(`OPENCODE_API_KEY=${openCodeApiKey}`);
  const env = envValues.map((line) => encoded(line)).join(' ');
  return `set -euo pipefail
runtime="$HOME/.orlynx/runtime"
mkdir -p "$runtime" && chmod 700 "$HOME/.orlynx" "$runtime"
printf '%s' '${encoded(bridge)}' | base64 -d > "$runtime/index.js"
printf '%s' '${encoded('{"type":"module","dependencies":{"node-pty":"1.1.0","ws":"^8.18.0"},"allowScripts":{"node-pty@1.1.0":true}}')}' | base64 -d > "$runtime/package.json"
if ! test -d "$runtime/node_modules/ws" || ! test -d "$runtime/node_modules/node-pty"; then cd "$runtime" && npm install --omit=dev --no-audit --no-fund >/dev/null; fi

# Install the exact native OpenCode binary instead of the opencode-ai launcher.
# The launcher can cache an AVX2 build on x64 machines that require the baseline binary.
machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) opencode_arch="x64" ;;
  aarch64|arm64) opencode_arch="arm64" ;;
  *) echo "Unsupported Codespace architecture for OpenCode: $machine" >&2; exit 1 ;;
esac
opencode_libc=""
if test -f /etc/alpine-release || (ldd --version 2>&1 || true) | grep -qi musl; then opencode_libc="-musl"; fi
if test "$opencode_arch" = "x64"; then
  if grep -qi -m1 '\\<avx2\\>' /proc/cpuinfo 2>/dev/null; then
    opencode_pkg="opencode-linux-x64\${opencode_libc}"
  else
    opencode_pkg="opencode-linux-x64-baseline\${opencode_libc}"
  fi
else
  opencode_pkg="opencode-linux-arm64\${opencode_libc}"
fi
install_native_opencode() {
  package="$1"
  binary="$runtime/node_modules/$package/bin/opencode"
  if ! test -x "$binary"; then
    cd "$runtime" && npm install --no-save --omit=dev --no-audit --no-fund "$package@${OPENCODE_VERSION}" >/dev/null
  fi
  test -x "$binary"
  printf '%s' "$binary"
}
opencode_bin="$(install_native_opencode "$opencode_pkg")"
if ! "$opencode_bin" --version >"$runtime/opencode-version.txt" 2>"$runtime/opencode-version.err"; then
  if test "$opencode_arch" = "x64" && ! printf '%s' "$opencode_pkg" | grep -q -- '-baseline'; then
    opencode_pkg="opencode-linux-x64-baseline\${opencode_libc}"
    opencode_bin="$(install_native_opencode "$opencode_pkg")"
  fi
fi
if ! "$opencode_bin" --version >"$runtime/opencode-version.txt" 2>"$runtime/opencode-version.err"; then
  echo "OpenCode native binary failed its startup smoke test ($opencode_pkg)." >&2
  tail -c 1000 "$runtime/opencode-version.err" >&2 || true
  exit 1
fi
repo_root="$(find /workspaces -mindepth 2 -maxdepth 3 -type d -name .git -printf '%h\\n' | head -n1)"
test -n "$repo_root"
# Reuse the password of an OpenCode server left running in this Codespace.
existing_password=""
if test -f "$runtime/workspace.env"; then existing_password="$(sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' "$runtime/workspace.env" | tail -n1)"; fi
: > "$runtime/workspace.env" && chmod 600 "$runtime/workspace.env"
for item in ${env}; do printf '%s\\n' "$item" | base64 -d >> "$runtime/workspace.env"; printf '\\n' >> "$runtime/workspace.env"; done
if test -n "$existing_password"; then
  sed -i '/^OPENCODE_SERVER_PASSWORD=/d' "$runtime/workspace.env"
  printf 'OPENCODE_SERVER_PASSWORD=%s\\n' "$existing_password" >> "$runtime/workspace.env"
fi
printf 'ORLYNX_REPO_ROOT=%s\\n' "$repo_root" >> "$runtime/workspace.env"
printf 'OPENCODE_BIN=%s\\n' "$opencode_bin" >> "$runtime/workspace.env"
if test -f "$runtime/bridge.pid" && kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null; then kill "$(cat "$runtime/bridge.pid")" || true; fi
set -a; . "$runtime/workspace.env"; set +a
nohup node "$runtime/index.js" >"$runtime/bridge.log" 2>&1 </dev/null &
printf '%s' "$!" > "$runtime/bridge.pid"
sleep 2
kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null || { echo "Orlynx bridge exited during startup" >&2; exit 1; }
`;
}

async function bootstrapWithSandbox(workspace: WorkspaceRecord, values: Values, githubUserToken: string, bridgeUrl: string, openCodeApiKey: string): Promise<void> {
  const sandbox = await Sandbox.create({ ...sandboxCredentials(), runtime: 'node24', timeout: 5 * 60_000, resources: { vcpus: 2 } });
  try {
    const version = '2.80.0';
    const architecture = await sandbox.runCommand('uname', ['-m']);
    const arch = (await architecture.stdout()).trim() === 'aarch64' ? 'arm64' : 'amd64';
    const archive = `gh_${version}_linux_${arch}`;
    const install = await sandbox.runCommand('sh', ['-c', `curl -fsSL https://github.com/cli/cli/releases/download/v${version}/${archive}.tar.gz -o /tmp/gh.tgz && tar -xzf /tmp/gh.tgz -C /tmp`]);
    if (install.exitCode !== 0) throw new Error('Could not install the GitHub CLI in the bootstrap sandbox.');
    await sandbox.writeFiles([{ path: '/tmp/orlynx-bootstrap.sh', content: bootstrapScript(workspace, values, bridgeUrl, openCodeApiKey), mode: 0o600 }]);
    const result = await sandbox.runCommand({ cmd: 'sh', args: ['-c', `cat /tmp/orlynx-bootstrap.sh | /tmp/${archive}/bin/gh codespace ssh -c "$ORLYNX_CODESPACE" -- bash -s`], env: { GH_TOKEN: githubUserToken, ORLYNX_CODESPACE: workspace.codespaceName || '' } });
    if (result.exitCode !== 0) throw new Error(`Codespace bootstrap failed: ${(await result.stderr()).slice(-1000)}`);
  } finally { await sandbox.stop().catch(() => {}); }
}


async function bootstrapWithLocalGh(workspace: WorkspaceRecord, values: Values, githubUserToken: string, bridgeUrl: string, openCodeApiKey: string): Promise<void> {
  const script = bootstrapScript(workspace, values, bridgeUrl, openCodeApiKey);
  const totalTimeoutMs = Math.max(90_000, Number(process.env.ORLYNX_BOOTSTRAP_TIMEOUT_MS || 2 * 60_000));
  const attemptTimeoutMs = Math.min(
    60_000,
    Math.max(20_000, Number(process.env.ORLYNX_BOOTSTRAP_ATTEMPT_TIMEOUT_MS || 45_000)),
  );
  const deadline = Date.now() + totalTimeoutMs;
  let attempt = 0;
  let lastDetail = '';

  while (Date.now() < deadline) {
    attempt += 1;
    const remaining = Math.max(1_000, deadline - Date.now());
    const timeoutMs = Math.min(attemptTimeoutMs, remaining);
    const result = await new Promise<{ ok: boolean; fatal: boolean; detail: string }>((resolve) => {
      const child = spawn('gh', ['codespace', 'ssh', '-c', workspace.codespaceName || '', '--', 'bash', '-s'], {
        env: { ...process.env, GH_TOKEN: githubUserToken },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value: { ok: boolean; fatal: boolean; detail: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const detail = (stderr || stdout).trim().slice(-1600);
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
        force.unref?.();
        finish({ ok: false, fatal: false, detail: detail || `SSH attempt ${attempt} timed out after ${Math.round(timeoutMs / 1000)} seconds.` });
      }, timeoutMs);
      timer.unref?.();
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-5000); });
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-3000); });
      child.once('error', (error) => finish({ ok: false, fatal: true, detail: error.message }));
      child.once('exit', (code, signal) => {
        if (settled) return;
        if (code === 0) {
          finish({ ok: true, fatal: false, detail: '' });
          return;
        }
        const detail = (stderr || stdout).trim().slice(-1600);
        const fatal = /(?:HTTP\s+(?:401|403|404)|forbidden|not found|permission|authentication|unknown codespace|no such codespace)/i.test(detail);
        finish({
          ok: false,
          fatal,
          detail: `Codespace bootstrap failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${detail || 'SSH was not ready.'}`,
        });
      });
      child.stdin.on('error', (error) => {
        // EPIPE is common while GitHub is still bringing SSH online. Treat it
        // as a retryable readiness signal; a missing local gh binary is fatal.
        const fatal = (error as NodeJS.ErrnoException).code === 'ENOENT';
        finish({ ok: false, fatal, detail: error.message });
      });
      child.stdin.end(script);
    });

    if (result.ok) {
      if (attempt > 1) console.info(`[workspace] Codespace SSH became ready after ${attempt} bootstrap attempts workspace=${workspace.id}`);
      return;
    }

    lastDetail = result.detail;
    if (result.fatal) throw new Error(result.detail || 'Codespace bootstrap failed.');

    const brokenSshServer = /failed to start ssh server|error getting ssh server details|ssh server unavailable/i.test(result.detail);
    if (brokenSshServer && attempt >= 3) {
      throw new Error(`Codespace SSH server is unavailable after ${attempt} attempts: ${result.detail.slice(-1200)}`);
    }

    if (Date.now() >= deadline) break;

    if (attempt === 1 || attempt % 5 === 0) {
      const detail = result.detail.replace(/\s+/g, ' ').slice(-280);
      console.info(`[workspace] Codespace SSH not ready yet workspace=${workspace.id} attempt=${attempt}${detail ? ` detail=${detail}` : ''}; retrying`);
    } else {
      console.info(`[workspace] Codespace SSH not ready yet workspace=${workspace.id} attempt=${attempt}; retrying`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  throw new Error(
    `Codespace SSH did not become ready after ${attempt} bootstrap attempts within ${Math.round(totalTimeoutMs / 1000)} seconds${lastDetail ? `: ${lastDetail}` : '.'}`,
  );
}

export async function bootstrapWorkspace(workspace: WorkspaceRecord, values: Values): Promise<void> {
  const base = (process.env.ORLYNX_RUNTIME_WORKER_URL || '').replace(/\/$/, '');
  const workerToken = process.env.ORLYNX_RUNTIME_WORKER_TOKEN || '';
  const publicUrl = (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl.startsWith('https://') || !workspace.codespaceName) throw new Error('Runtime bootstrap infrastructure is not configured.');
  const githubUserToken = await githubUserAccessToken(workspace.userId);
  const openCodeConnection = await controlPlaneRepository().getProviderConnection(workspace.userId, 'opencode');
  const openCodeApiKey = openCodeConnection?.state === 'connected' && openCodeConnection.credential
    ? decryptCredential(openCodeConnection.credential)
    : '';
  const bridgeUrl = `${publicUrl.replace(/^https:/, 'wss:')}/bridge`;
  if (!base && process.env.ORLYNX_BOOTSTRAP_MODE === 'local') return bootstrapWithLocalGh(workspace, values, githubUserToken, bridgeUrl, openCodeApiKey);
  if (!base && (process.env.VERCEL === '1' || process.env.ORLYNX_BOOTSTRAP_MODE === 'sandbox')) return bootstrapWithSandbox(workspace, values, githubUserToken, bridgeUrl, openCodeApiKey);
  if (!base.startsWith('https://') || !workerToken) throw new Error('Runtime bootstrap infrastructure is not configured.');
  const response = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ codespaceName: workspace.codespaceName, githubUserToken, bridgeUrl, bridgeToken: values.bridgeToken, workspaceId: workspace.id, sessionId: workspace.sessionId, userId: workspace.userId, connectionId: values.connectionId, openCodePassword: values.openCodePassword }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Runtime worker could not bootstrap the Codespace (HTTP ${response.status}).`);
}
