// Workspace Bridge — outbound WS prototype, fail-closed until a remote
// execution bridge route exists on the API. Requires explicit ORLYNX_CONTROL,
// ORLYNX_WORKSPACE_TOKEN and ORLYNX_WORKSPACE_ID. No defaults, no dev-token.
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const CONTROL = process.env.ORLYNX_CONTROL || '';
const TOKEN = process.env.ORLYNX_WORKSPACE_TOKEN || '';
const WS_ID = process.env.ORLYNX_WORKSPACE_ID || '';

function hello(): Record<string, unknown> {
  return { workspaceId: WS_ID, bridgeVersion: '1.1.0', os: os.platform(), arch: os.arch(), capabilities: ['pty', 'exec', 'fs', 'ports', 'agent'] };
}

export function start() {
  if (!CONTROL || !TOKEN || !WS_ID) {
    console.error('[bridge] BLOCKED: set ORLYNX_CONTROL, ORLYNX_WORKSPACE_TOKEN and ORLYNX_WORKSPACE_ID. No automatic connection is attempted.');
    process.exitCode = 2;
    return;
  }
  console.log(`[bridge] dialing ${CONTROL} as ${WS_ID}`);
  const ws = new WebSocket(CONTROL);
  ws.on('open', () => {
    ws.send(JSON.stringify({ kind: 'HELLO', ...hello() }));
    ws.send(JSON.stringify({ kind: 'AUTH', token: TOKEN }));
    ws.send(JSON.stringify({ kind: 'READY', repoRoot: process.cwd(), headSha: 'local', branch: 'main' }));
    setInterval(() => ws.send(JSON.stringify({ kind: 'EVENT', type: 'heartbeat', workspaceId: WS_ID })), 15000);
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'process.exec') {
        const cmd = String(msg.cmd || '');
        const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
        if (!cmd || cmd.includes('/') || cmd === 'git') {
          ws.send(JSON.stringify({ kind: 'EVENT', type: 'process.exit', runId: msg.runId, code: 1, out: 'command denied by bridge policy' }));
          return;
        }
        try {
          const out = execFileSync(cmd, args, { timeout: msg.timeout || 20000, encoding: 'utf8' });
          ws.send(JSON.stringify({ kind: 'EVENT', type: 'process.exit', runId: msg.runId, code: 0, out: String(out).slice(0, 20000) }));
        } catch (e: unknown) {
          ws.send(JSON.stringify({ kind: 'EVENT', type: 'process.exit', runId: msg.runId, code: 1, out: String((e as Error).message).slice(0, 20000) }));
        }
      }
    } catch {}
  });
  ws.on('error', (e) => console.error('[bridge] ws error', (e as Error).message));
}

if (import.meta.url.endsWith(process.argv[1] || '')) start();
