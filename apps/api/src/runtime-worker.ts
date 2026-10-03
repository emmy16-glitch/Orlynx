import type { WorkspaceRecord } from '@orlynx/shared';
import { githubUserAccessToken } from './github.js';
import { Sandbox } from '@vercel/sandbox';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export type WorkspaceBootstrapValues = { bridgeToken: string; connectionId: string; openCodePassword: string };
const bridgeRuntimeDir = fileURLToPath(new URL('../../../bridge/dist/', import.meta.url));
const OPENCODE_VERSION = '1.18.32';
const MINI_SWE_VERSION = '2.4.6';
const CLINE_SDK_VERSION = '0.0.90';
const BRIDGE_RUNTIME_PACKAGE = JSON.stringify({
  type: 'module',
  dependencies: { '@cline/agents': CLINE_SDK_VERSION, 'node-pty': '1.1.0', ws: '^8.18.0' },
  allowScripts: { 'node-pty@1.1.0': true },
});
type BridgeRuntimeAsset = { name: string; content: string };
function bridgeRuntimeAssets(): BridgeRuntimeAsset[] {
  return fs.readdirSync(bridgeRuntimeDir)
    .filter((name) => /^[A-Za-z0-9_.-]+\.(?:js|py)$/.test(name))
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(bridgeRuntimeDir, name), 'utf8') }));
}
let cachedBridgeRevision = '';
export function bridgeRuntimeRevision(): string {
  if (!cachedBridgeRevision) {
    const hash = createHash('sha256').update(BRIDGE_RUNTIME_PACKAGE).update(MINI_SWE_VERSION);
    for (const asset of bridgeRuntimeAssets()) hash.update(asset.name).update('\0').update(asset.content).update('\0');
    cachedBridgeRevision = hash.digest('hex').slice(0, 12);
  }
  return cachedBridgeRevision;
}
function encoded(value: string): string { return Buffer.from(value).toString('base64'); }
function sandboxCredentials() {
  return process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
    ? { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
    : {};
}
export function buildWorkspaceBootstrapScript(workspace: WorkspaceRecord, values: WorkspaceBootstrapValues, bridgeUrl: string, openCodeApiKey = '', openRouterApiKey = ''): string {
  const bridgeWrites = bridgeRuntimeAssets()
    .map((asset) => `printf '%s' '${encoded(asset.content)}' | base64 -d > "$runtime/${asset.name}"`)
    .join('\n');
  const envValues = [`ORLYNX_CONTROL=${bridgeUrl}`, `ORLYNX_WORKSPACE_TOKEN=${values.bridgeToken}`, `ORLYNX_WORKSPACE_ID=${workspace.id}`, `ORLYNX_SESSION_ID=${workspace.sessionId}`, `ORLYNX_USER_ID=${workspace.userId}`, `ORLYNX_CONNECTION_ID=${values.connectionId}`, `OPENCODE_SERVER_PASSWORD=${values.openCodePassword}`];
  if (openCodeApiKey) envValues.push(`OPENCODE_API_KEY=${openCodeApiKey}`);
  if (openRouterApiKey) envValues.push(`ORLYNX_OPENROUTER_API_KEY=${openRouterApiKey}`);
  for (const [key, value] of [
    ['ORLYNX_MINI_SWE_API_BASE', process.env.ORLYNX_MINI_SWE_API_BASE],
    ['ORLYNX_MINI_SWE_MODEL', process.env.ORLYNX_MINI_SWE_MODEL],
    ['ORLYNX_CLINE_API_BASE', process.env.ORLYNX_CLINE_API_BASE],
    ['ORLYNX_CLINE_MODEL', process.env.ORLYNX_CLINE_MODEL],
  ] as const) if (value) envValues.push(`${key}=${value}`);
  const env = envValues.map((line) => encoded(line)).join(' ');
  return `set -euo pipefail
runtime="$HOME/.orlynx/runtime"
mkdir -p "$runtime" && chmod 700 "$HOME/.orlynx" "$runtime"
${bridgeWrites}
printf '%s' '${encoded(BRIDGE_RUNTIME_PACKAGE)}' | base64 -d > "$runtime/package.json"
if ! test -d "$runtime/node_modules/ws" || ! test -d "$runtime/node_modules/node-pty" || ! test -d "$runtime/node_modules/@cline/agents"; then cd "$runtime" && npm install --omit=dev --no-audit --no-fund >/dev/null; fi

mini_swe_python="$runtime/mini-swe/bin/python"
mini_swe_ready=0
if test -x "$mini_swe_python" && "$mini_swe_python" -c 'import minisweagent; assert minisweagent.__version__ == "${MINI_SWE_VERSION}"' >/dev/null 2>&1; then
  mini_swe_ready=1
elif command -v python3 >/dev/null 2>&1; then
  rm -rf "$runtime/mini-swe"
  if python3 -m venv "$runtime/mini-swe" >/dev/null 2>&1 \
    && "$runtime/mini-swe/bin/pip" install --disable-pip-version-check --no-cache-dir "mini-swe-agent==${MINI_SWE_VERSION}" >/dev/null 2>&1 \
    && "$mini_swe_python" -c 'import minisweagent; assert minisweagent.__version__ == "${MINI_SWE_VERSION}"' >/dev/null 2>&1; then
    mini_swe_ready=1
  else
    rm -rf "$runtime/mini-swe"
    mini_swe_python=""
    echo "mini-SWE ${MINI_SWE_VERSION} preparation unavailable; other adapters remain usable." >&2
  fi
fi

# Install the exact native OpenCode binary instead of the opencode-ai launcher.
# The launcher can cache an AVX2 build on x64 machines that require the baseline binary.
machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) opencode_arch="x64"; gh_arch="amd64"; gh_sha="9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8" ;;
  aarch64|arm64) opencode_arch="arm64"; gh_arch="arm64"; gh_sha="b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f" ;;
  *) echo "Unsupported Codespace architecture: $machine" >&2; exit 1 ;;
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
# GitHub CLI versions before 2.98 bind the helper listener used by
# "gh codespace ports forward" to all interfaces. Prefer a private, checksum-
# verified current binary. Failure to install it degrades Preview safely rather
# than failing the whole workspace.
gh_bin="$(command -v gh 2>/dev/null || true)"
gh_safe=0
if test -n "$gh_bin"; then
  gh_line="$("$gh_bin" --version 2>/dev/null | head -n1 || true)"
  gh_major="$(printf '%s' "$gh_line" | sed -nE 's/^gh version ([0-9]+)\\..*/\\1/p')"
  gh_minor="$(printf '%s' "$gh_line" | sed -nE 's/^gh version [0-9]+\\.([0-9]+)\\..*/\\1/p')"
  if test -n "$gh_major" && test -n "$gh_minor" && { test "$gh_major" -gt 2 || { test "$gh_major" -eq 2 && test "$gh_minor" -ge 98; }; }; then gh_safe=1; fi
fi
if test "$gh_safe" -ne 1; then
  private_gh="$runtime/gh"
  if test -x "$private_gh" && "$private_gh" --version 2>/dev/null | head -n1 | grep -q "gh version 2.101.0"; then
    gh_bin="$private_gh"
  else
    archive="$runtime/gh_2.101.0_linux_\${gh_arch}.tar.gz"
    url="https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_\${gh_arch}.tar.gz"
    rm -f "$archive"
    downloaded=0
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 --connect-timeout 10 "$url" -o "$archive" && downloaded=1 || true
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$archive" "$url" && downloaded=1 || true
    fi
    if test "$downloaded" -eq 1 && printf '%s  %s\\n' "$gh_sha" "$archive" | sha256sum -c - >/dev/null 2>&1; then
      gh_tmp="$runtime/gh-install"
      rm -rf "$gh_tmp"
      mkdir -p "$gh_tmp"
      if tar -xzf "$archive" -C "$gh_tmp" >/dev/null 2>&1 && cp "$gh_tmp/gh_2.101.0_linux_\${gh_arch}/bin/gh" "$private_gh"; then
        chmod 700 "$private_gh"
        gh_bin="$private_gh"
      fi
      rm -rf "$gh_tmp"
    fi
    rm -f "$archive"
  fi
fi
repo_root="\${ORLYNX_REPO_ROOT_HINT:-}"
if test -z "$repo_root"; then
  repo_root="$(find /workspaces -mindepth 2 -maxdepth 3 -type d -name .git -printf '%h\\n' | head -n1)"
fi
test -n "$repo_root" && test -d "$repo_root/.git"

# Browser/E2E preparation belongs to workspace bootstrap, not the first test.
# Only Playwright repositories pay this cost, and each Playwright version is
# prepared once per persistent Codespace.
if test "\${ORLYNX_PREWARM_BROWSER_RUNTIME:-1}" != "0" && grep -Eq '"(playwright|@playwright/test|@axe-core/playwright)"' "$repo_root/package.json" "$repo_root/package-lock.json" 2>/dev/null; then
  playwright_version="$(cd "$repo_root" && node -e 'try { const p=require("./package-lock.json"); process.stdout.write(p.packages?.["node_modules/playwright"]?.version || p.packages?.["node_modules/playwright-core"]?.version || "") } catch {}' 2>/dev/null || true)"
  test -n "$playwright_version" || playwright_version="1.63.0"
  playwright_marker="$runtime/playwright-$playwright_version.ready"
  if ! test -f "$playwright_marker"; then
    if ! (
      set -e
      echo "Preparing Playwright Chromium runtime $playwright_version…" >&2
      playwright_root="$runtime/playwright-cli-$playwright_version"
      playwright_cli="$playwright_root/node_modules/.bin/playwright"
      if ! test -x "$playwright_cli"; then
        mkdir -p "$playwright_root"
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$playwright_root" --no-save --no-audit --no-fund "playwright@$playwright_version" >/dev/null
      fi

      # install-deps is idempotent. Codespaces provide sudo; skip the apt work
      # when the critical Chromium GTK/ATK dependency is already present.
      if ! (ldconfig -p 2>/dev/null || true) | grep -q 'libatk-1.0.so.0'; then
        "$playwright_cli" install-deps chromium
      fi
      "$playwright_cli" install chromium

      # Prove the exact browser/runtime combination can start before exposing the
      # browser capability. Workspace bootstrap itself must survive a temporary
      # third-party apt/npm mirror failure so non-browser Build work can proceed.
      PLAYWRIGHT_MODULE="$playwright_root/node_modules/playwright" node -e 'const { chromium }=require(process.env.PLAYWRIGHT_MODULE); (async()=>{const b=await chromium.launch({headless:true}); await b.close()})().catch(e=>{console.error(e);process.exit(1)})'
      touch "$playwright_marker"
    ); then
      echo "Playwright Chromium prewarm failed; continuing workspace bootstrap without browser E2E readiness." >&2
      rm -f "$playwright_marker"
    fi
  fi
fi

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
printf 'OPENCODE_VERSION=%s\\n' '${OPENCODE_VERSION}' >> "$runtime/workspace.env"
printf 'ORLYNX_GH_BIN=%s\\n' "$gh_bin" >> "$runtime/workspace.env"
if test "$mini_swe_ready" -eq 1; then printf 'ORLYNX_MINI_SWE_PYTHON=%s\\n' "$mini_swe_python" >> "$runtime/workspace.env"; fi
if test -f "$runtime/bridge.pid" && kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null; then kill "$(cat "$runtime/bridge.pid")" || true; fi
set -a; . "$runtime/workspace.env"; set +a
nohup node "$runtime/index.js" >"$runtime/bridge.log" 2>&1 </dev/null &
printf '%s' "$!" > "$runtime/bridge.pid"
sleep 2
kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null || { echo "Orlynx bridge exited during startup" >&2; exit 1; }
`;
}

async function bootstrapWithSandbox(workspace: WorkspaceRecord, values: WorkspaceBootstrapValues, githubUserToken: string, bridgeUrl: string, openCodeApiKey: string, openRouterApiKey: string): Promise<void> {
  const sandbox = await Sandbox.create({ ...sandboxCredentials(), runtime: 'node24', timeout: 5 * 60_000, resources: { vcpus: 2 } });
  try {
    const version = '2.80.0';
    const architecture = await sandbox.runCommand('uname', ['-m']);
    const arch = (await architecture.stdout()).trim() === 'aarch64' ? 'arm64' : 'amd64';
    const archive = `gh_${version}_linux_${arch}`;
    const install = await sandbox.runCommand('sh', ['-c', `curl -fsSL https://github.com/cli/cli/releases/download/v${version}/${archive}.tar.gz -o /tmp/gh.tgz && tar -xzf /tmp/gh.tgz -C /tmp`]);
    if (install.exitCode !== 0) throw new Error('Could not install the GitHub CLI in the bootstrap sandbox.');
    await sandbox.writeFiles([{ path: '/tmp/orlynx-bootstrap.sh', content: buildWorkspaceBootstrapScript(workspace, values, bridgeUrl, openCodeApiKey, openRouterApiKey), mode: 0o600 }]);
    const result = await sandbox.runCommand({ cmd: 'sh', args: ['-c', `cat /tmp/orlynx-bootstrap.sh | /tmp/${archive}/bin/gh codespace ssh -c "$ORLYNX_CODESPACE" -- bash -s`], env: { GH_TOKEN: githubUserToken, ORLYNX_CODESPACE: workspace.codespaceName || '' } });
    if (result.exitCode !== 0) throw new Error(`Codespace bootstrap failed: ${(await result.stderr()).slice(-1000)}`);
  } finally { await sandbox.stop().catch(() => {}); }
}


async function bootstrapWithLocalGh(workspace: WorkspaceRecord, values: WorkspaceBootstrapValues, githubUserToken: string, bridgeUrl: string, openCodeApiKey: string, openRouterApiKey: string): Promise<void> {
  const script = buildWorkspaceBootstrapScript(workspace, values, bridgeUrl, openCodeApiKey, openRouterApiKey);
  const totalTimeoutMs = Math.max(120_000, Number(process.env.ORLYNX_BOOTSTRAP_TIMEOUT_MS || 5 * 60_000));
  const attemptTimeoutMs = Math.min(
    180_000,
    Math.max(30_000, Number(process.env.ORLYNX_BOOTSTRAP_ATTEMPT_TIMEOUT_MS || 150_000)),
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

export async function bootstrapWorkspace(workspace: WorkspaceRecord, values: WorkspaceBootstrapValues): Promise<void> {
  const base = (process.env.ORLYNX_RUNTIME_WORKER_URL || '').replace(/\/$/, '');
  const workerToken = process.env.ORLYNX_RUNTIME_WORKER_TOKEN || '';
  const publicUrl = (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl.startsWith('https://') || !workspace.codespaceName) throw new Error('Runtime bootstrap infrastructure is not configured.');
  const githubUserToken = await githubUserAccessToken(workspace.userId);
  const openCodeConnection = await controlPlaneRepository().getProviderConnection(workspace.userId, 'opencode');
  const openCodeApiKey = openCodeConnection?.state === 'connected' && openCodeConnection.credential
    ? decryptCredential(openCodeConnection.credential)
    : '';
  const openRouterApiKey = process.env.ORLYNX_OPENROUTER_API_KEY || '';
  const bridgeUrl = `${publicUrl.replace(/^https:/, 'wss:')}/bridge`;
  if (!base && process.env.ORLYNX_BOOTSTRAP_MODE === 'local') return bootstrapWithLocalGh(workspace, values, githubUserToken, bridgeUrl, openCodeApiKey, openRouterApiKey);
  if (!base && (process.env.VERCEL === '1' || process.env.ORLYNX_BOOTSTRAP_MODE === 'sandbox')) return bootstrapWithSandbox(workspace, values, githubUserToken, bridgeUrl, openCodeApiKey, openRouterApiKey);
  if (!base.startsWith('https://') || !workerToken) throw new Error('Runtime bootstrap infrastructure is not configured.');
  const response = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ codespaceName: workspace.codespaceName, githubUserToken, bridgeUrl, bridgeToken: values.bridgeToken, workspaceId: workspace.id, sessionId: workspace.sessionId, userId: workspace.userId, connectionId: values.connectionId, openCodePassword: values.openCodePassword, openCodeApiKey, openRouterApiKey, miniSweApiBase: process.env.ORLYNX_MINI_SWE_API_BASE || '', miniSweModel: process.env.ORLYNX_MINI_SWE_MODEL || '', clineApiBase: process.env.ORLYNX_CLINE_API_BASE || '', clineModel: process.env.ORLYNX_CLINE_MODEL || '' }), signal: AbortSignal.timeout(Math.max(120_000, Number(process.env.ORLYNX_BOOTSTRAP_TIMEOUT_MS || 5 * 60_000))) });
  if (!response.ok) throw new Error(`Runtime worker could not bootstrap the Codespace (HTTP ${response.status}).`);
}
