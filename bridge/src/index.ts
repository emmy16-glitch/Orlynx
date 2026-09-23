// Workspace Bridge — PDF §7. Outbound WS: HELLO/AUTH/READY/EVENT/COMMAND.
// Runs inside remote runtime (Codespace/local), dials control plane.
import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import os from 'node:os';

const CONTROL = process.env.ORLYNX_CONTROL || 'ws://localhost:4000/v1/bridge';
const TOKEN = process.env.ORLYNX_WORKSPACE_TOKEN || 'dev-token';
const WS_ID = process.env.ORLYNX_WORKSPACE_ID || 'ws_local';

function hello(): Record<string, unknown> {
  return { workspaceId: WS_ID, bridgeVersion: '1.1.0', os: os.platform(), arch: os.arch(), capabilities: ['pty', 'exec', 'fs', 'ports', 'agent'] };
}

export function start() {
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
        try {
          const out = execSync(msg.cmd, { timeout: msg.timeout || 20000, encoding: 'utf8' });
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
