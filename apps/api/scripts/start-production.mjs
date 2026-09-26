import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../.opencode-runtime/node_modules/.bin/opencode', import.meta.url));
const port = Number(process.env.ORLYNX_LOCAL_OPENCODE_PORT || 4107);
const username = 'opencode';
const password = randomBytes(24).toString('hex');
const baseURL = `http://127.0.0.1:${port}`;
const workdir = process.env.ORLYNX_LOCAL_OPENCODE_DIRECTORY || '/tmp/orlynx-opencode';

if (!existsSync(binary)) {
  console.error('[opencode-local] binary missing. Run the Render build script before starting production.');
  process.exit(1);
}

mkdirSync(workdir, { recursive: true });
process.env.ORLYNX_OPENCODE_RUNTIME_URL = baseURL;
process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME = username;
process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD = password;

let shuttingDown = false;
let child;

function startSidecar() {
  console.log(`[opencode-local] starting on ${baseURL}`);
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: workdir,
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) console.log(`[opencode-local] ${line}`);
  });
  child.stderr?.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) console.error(`[opencode-local] ${line}`);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[opencode-local] exited code=${code ?? '-'} signal=${signal ?? '-'}; restarting`);
    setTimeout(startSidecar, 1000).unref();
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { child?.kill(signal); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => { try { child?.kill('SIGTERM'); } catch {} });

startSidecar();

async function waitForSidecar() {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const deadline = Date.now() + 30_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/global/health`, {
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.log('[opencode-local] ready');
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`[opencode-local] failed readiness check: ${lastError || 'timeout'}`);
  try { child?.kill('SIGTERM'); } catch {}
  process.exit(1);
}

await waitForSidecar();
await import('../dist/index.js');
