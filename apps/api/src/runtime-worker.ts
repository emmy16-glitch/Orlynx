import type { WorkspaceRecord } from '@orlynx/shared';
import { githubUserAccessToken } from './github.js';
import { Sandbox } from '@vercel/sandbox';
import fs from 'node:fs';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';
import { fileURLToPath } from 'node:url';

type Values = { bridgeToken: string; connectionId: string; openCodePassword: string };
const bridgeBundle = fileURLToPath(new URL('../../../bridge/dist/index.js', import.meta.url));
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
if ! command -v opencode >/dev/null 2>&1; then npm install -g opencode-ai@latest --no-audit --no-fund >/dev/null; fi
repo_root="$(find /workspaces -mindepth 2 -maxdepth 3 -type d -name .git -printf '%h\\n' | head -n1)"
test -n "$repo_root"
: > "$runtime/workspace.env" && chmod 600 "$runtime/workspace.env"
for item in ${env}; do printf '%s\\n' "$item" | base64 -d >> "$runtime/workspace.env"; printf '\\n' >> "$runtime/workspace.env"; done
printf 'ORLYNX_REPO_ROOT=%s\\n' "$repo_root" >> "$runtime/workspace.env"
if test -f "$runtime/bridge.pid" && kill -0 "$(cat "$runtime/bridge.pid")" 2>/dev/null; then kill "$(cat "$runtime/bridge.pid")" || true; fi
set -a; . "$runtime/workspace.env"; set +a
nohup node "$runtime/index.js" >"$runtime/bridge.log" 2>&1 </dev/null &
printf '%s' "$!" > "$runtime/bridge.pid"
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
  if (!base && (process.env.VERCEL === '1' || process.env.ORLYNX_BOOTSTRAP_MODE === 'sandbox')) return bootstrapWithSandbox(workspace, values, githubUserToken, bridgeUrl, openCodeApiKey);
  if (!base.startsWith('https://') || !workerToken) throw new Error('Runtime bootstrap infrastructure is not configured.');
  const response = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ codespaceName: workspace.codespaceName, githubUserToken, bridgeUrl, bridgeToken: values.bridgeToken, workspaceId: workspace.id, sessionId: workspace.sessionId, userId: workspace.userId, connectionId: values.connectionId, openCodePassword: values.openCodePassword }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Runtime worker could not bootstrap the Codespace (HTTP ${response.status}).`);
}
