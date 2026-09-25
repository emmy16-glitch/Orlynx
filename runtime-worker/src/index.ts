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
  x86_64|amd64) opencode_arch="x64" ;;
  aarch64|arm64) opencode_arch="arm64" ;;
  *) echo "Unsupported Codespace architecture for OpenCode: $machine" >&2; exit 1 ;;
esac
opencode_libc=""
if test -f /etc/alpine-release || (ldd --version 2>&1 || true) | grep -qi musl; then opencode_libc="-musl"; fi
if test "$opencode_arch" = "x64"; then
  if grep -qi -m1 '\\<avx2\\>' /proc/cpuinfo 2>/dev/null; then
    opencode_pkg="opencode-linux-x64${opencode_libc}"
  else
    opencode_pkg="opencode-linux-x64-baseline${opencode_libc}"
  fi
else
  opencode_pkg="opencode-linux-arm64${opencode_libc}"
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
    opencode_pkg="opencode-linux-x64-baseline${opencode_libc}"
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
: > "$runtime/workspace.env"
chmod 600 "$runtime/workspace.env"
for item in ${env}; do printf '%s\\n' "$item" | base64 -d >> "$runtime/workspace.env"; printf '\\n' >> "$runtime/workspace.env"; done
if test -n "$existing_password"; then
  sed -i '/^OPENCODE_SERVER_PASSWORD=/d' "$runtime/workspace.env"
  printf 'OPENCODE_SERVER_PASSWORD=%s\\n' "$existing_password" >> "$runtime/workspace.env"
fi
printf 'ORLYNX_REPO_ROOT=%s\\n' "$repo_root" >> "$runtime/workspace.env"
printf 'OPENCODE_BIN=%s\\n' "$opencode_bin" >> "$runtime/workspace.env"
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
