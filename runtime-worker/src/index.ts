import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const WORKER_TOKEN = process.env.ORLYNX_RUNTIME_WORKER_TOKEN || '';
const BRIDGE_FILE = process.env.ORLYNX_BRIDGE_BUNDLE || path.resolve(process.cwd(), '../bridge/dist/index.js');
const OPENCODE_VERSION = '1.18.32';

type BootstrapRequest = { codespaceName: string; githubUserToken: string; bridgeUrl: string; bridgeToken: string; workspaceId: string; sessionId: string; userId: string; connectionId: string; openCodePassword: string };
function encoded(value: string): string { return Buffer.from(value).toString('base64'); }
function authorized(header: string | undefined): boolean {
  const candidate = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!WORKER_TOKEN || !candidate) return false;
  const expected = Buffer.from(WORKER_TOKEN); const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function valid(body: BootstrapRequest): boolean {
  return Boolean(body.codespaceName && /^[a-zA-Z0-9-]+$/.test(body.codespaceName) && body.githubUserToken && body.bridgeUrl.startsWith('wss://') && body.bridgeToken && body.workspaceId && body.sessionId && body.userId && body.connectionId && body.openCodePassword);
}
function bootstrapScript(body: BootstrapRequest, bridge: string): string {
  const env = [
    `ORLYNX_CONTROL=${body.bridgeUrl}`, `ORLYNX_WORKSPACE_TOKEN=${body.bridgeToken}`, `ORLYNX_WORKSPACE_ID=${body.workspaceId}`,
    `ORLYNX_SESSION_ID=${body.sessionId}`, `ORLYNX_USER_ID=${body.userId}`, `ORLYNX_CONNECTION_ID=${body.connectionId}`, `OPENCODE_SERVER_PASSWORD=${body.openCodePassword}`,
  ].map((line) => encoded(line)).join(' ');
  return `set -euo pipefail
runtime="$HOME/.orlynx/runtime"
mkdir -p "$runtime"
chmod 700 "$HOME/.orlynx" "$runtime"
printf '%s' '${encoded(bridge)}' | base64 -d > "$runtime/index.js"
printf '%s' '${encoded('{"type":"module","dependencies":{"node-pty":"1.1.0","ws":"^8.18.0"},"allowScripts":{"node-pty@1.1.0":true}}')}' | base64 -d > "$runtime/package.json"
cd "$runtime"
if ! test -d "$runtime/node_modules/ws" || ! test -d "$runtime/node_modules/node-pty"; then npm install --omit=dev --no-audit --no-fund >/dev/null; fi

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
# "gh codespace ports forward" to all interfaces. Use a private, checksum-
# verified current binary when the Codespace image ships an older CLI.
gh_bin=""
if command -v gh >/dev/null 2>&1; then
  gh_line="$(gh --version 2>/dev/null | head -n1 || true)"
  gh_major="$(printf '%s' "$gh_line" | sed -nE 's/^gh version ([0-9]+)\\..*/\\1/p')"
  gh_minor="$(printf '%s' "$gh_line" | sed -nE 's/^gh version [0-9]+\\.([0-9]+)\\..*/\\1/p')"
  if test -n "$gh_major" && test -n "$gh_minor" && { test "$gh_major" -gt 2 || { test "$gh_major" -eq 2 && test "$gh_minor" -ge 98; }; }; then
    gh_bin="$(command -v gh)"
  fi
fi
if test -z "$gh_bin"; then
  gh_bin="$runtime/gh"
  if ! test -x "$gh_bin" || ! "$gh_bin" --version 2>/dev/null | head -n1 | grep -q "gh version 2.101.0"; then
    archive="$runtime/gh_2.101.0_linux_\${gh_arch}.tar.gz"
    url="https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_\${gh_arch}.tar.gz"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 --connect-timeout 10 "$url" -o "$archive"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$archive" "$url"
    else
      echo "Codespace needs curl or wget to install the private GitHub CLI helper." >&2
      exit 1
    fi
    printf '%s  %s\\n' "$gh_sha" "$archive" | sha256sum -c - >/dev/null
    gh_tmp="$runtime/gh-install"
    rm -rf "$gh_tmp"
    mkdir -p "$gh_tmp"
    tar -xzf "$archive" -C "$gh_tmp"
    cp "$gh_tmp/gh_2.101.0_linux_\${gh_arch}/bin/gh" "$gh_bin"
    chmod 700 "$gh_bin"
    rm -rf "$gh_tmp" "$archive"
  fi
fi
"$gh_bin" --version >"$runtime/gh-version.txt" 2>"$runtime/gh-version.err" || {
  echo "Private GitHub CLI helper failed its startup smoke test." >&2
  tail -c 1000 "$runtime/gh-version.err" >&2 || true
  exit 1
}

repo_root="$(find /workspaces -mindepth 2 -maxdepth 3 -type d -name .git -printf '%h\\n' | head -n1)"
test -n "$repo_root"
# Reuse the password of an OpenCode server left running in this Codespace.
existing_password=""
if test -f "$runtime/workspace.env"; then existing_password="$(sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' "$runtime/workspace.env" | tail -n1)"; fi
: > "$runtime/workspace.env"
chmod 600 "$runtime/workspace.env"
for item in ${env}; do printf '%s\\n' "$item" | base64 -d >> "$runtime/workspace.env"; printf '\\n' >> "$runtime/workspace.env"; done
if test -n "$existing_password"; then
  sed -i '/^OPENCODE_SERVER_PASSWORD=/d' "$runtime/workspace.env"
  printf 'OPENCODE_SERVER_PASSWORD=%s\\n' "$existing_password" >> "$runtime/workspace.env"
fi
printf 'ORLYNX_REPO_ROOT=%s\\n' "$repo_root" >> "$runtime/workspace.env"
printf 'OPENCODE_BIN=%s\\n' "$opencode_bin" >> "$runtime/workspace.env"
printf 'ORLYNX_GH_BIN=%s\\n' "$gh_bin" >> "$runtime/workspace.env"
if test -f "$runtime/bridge.pid" && kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null; then kill "$(cat "$runtime/bridge.pid")" || true; fi
set -a
. "$runtime/workspace.env"
set +a
nohup node "$runtime/index.js" >"$runtime/bridge.log" 2>&1 </dev/null &
printf '%s' "$!" > "$runtime/bridge.pid"
sleep 2
kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null || { echo "Orlynx bridge exited during startup" >&2; exit 1; }
`;
}
function runBootstrap(body: BootstrapRequest): Promise<void> {
  const bridge = fs.readFileSync(BRIDGE_FILE, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['codespace', 'ssh', '-c', body.codespaceName, '--', 'bash', '-s'], { env: { PATH: process.env.PATH, GH_TOKEN: body.githubUserToken }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); }); child.stdout.resume();
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Codespace bootstrap failed (exit ${code}): ${stderr}`)));
    child.stdin.end(bootstrapScript(body, bridge));
  });
}

export const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/health') { res.statusCode = WORKER_TOKEN && fs.existsSync(BRIDGE_FILE) ? 200 : 503; res.end(JSON.stringify({ ok: res.statusCode === 200, service: 'orlynx-runtime-worker' })); return; }
  if (req.method !== 'POST' || req.url !== '/bootstrap') { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found.' })); return; }
  if (!authorized(req.headers.authorization)) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Unauthorized.' })); return; }
  const chunks: Buffer[] = []; let size = 0;
  req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 128_000) req.destroy(); else chunks.push(chunk); });
  req.on('end', async () => {
    let body: BootstrapRequest; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BootstrapRequest; } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON.' })); return; }
    if (!valid(body)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid bootstrap request.' })); return; }
    try { await runBootstrap(body); res.end(JSON.stringify({ ok: true })); }
    catch (error) { console.error('[runtime-worker] bootstrap failed', error instanceof Error ? error.message.replace(/gh[opsu]_[A-Za-z0-9_]+/g, '[redacted]') : 'unknown'); res.statusCode = 502; res.end(JSON.stringify({ error: 'Codespace bootstrap failed.' })); }
  });
});
if (import.meta.url.endsWith(process.argv[1] || '')) server.listen(PORT, '0.0.0.0', () => console.log(`[runtime-worker] listening on :${PORT}`));
