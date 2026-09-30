import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hasDurableStorage = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const childEnv = {
  ...process.env,
  ...(hasDurableStorage ? { ORLYNX_ORCHESTRATOR_MODE: 'worker' } : {}),
};

const localRuntimeBinary = fileURLToPath(
  new URL('../../../.render-opencode/node_modules/.bin/opencode', import.meta.url),
);
const runtimePassword = String(
  process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD
  || process.env.OPENCODE_SERVER_PASSWORD
  || '',
);
const runtimeUsername = String(
  process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME
  || process.env.OPENCODE_SERVER_USERNAME
  || 'opencode',
);
const localRuntimeEnabled = process.env.ORLYNX_LOCAL_OPENCODE_RUNTIME !== '0'
  && Boolean(runtimePassword)
  && existsSync(localRuntimeBinary);

if (localRuntimeEnabled) {
  childEnv.ORLYNX_OPENCODE_RUNTIME_URL = 'http://127.0.0.1:4096';
  childEnv.ORLYNX_OPENCODE_RUNTIME_USERNAME = runtimeUsername;
  childEnv.ORLYNX_OPENCODE_RUNTIME_PASSWORD = runtimePassword;
  childEnv.OPENCODE_SERVER_USERNAME = runtimeUsername;
  childEnv.OPENCODE_SERVER_PASSWORD = runtimePassword;
}

const children = new Map();
const restartTimers = new Map();
const restartCounts = new Map();
let stopping = false;

function scheduleRestart(name, command, args, options, startedAt, detail) {
  if (stopping) return;
  const livedFor = Date.now() - startedAt;
  const previous = livedFor >= 60_000 ? 0 : (restartCounts.get(name) || 0);
  const attempt = previous + 1;
  restartCounts.set(name, attempt);
  const delay = Math.min(30_000, [1_000, 2_000, 5_000, 10_000][Math.min(attempt - 1, 3)] || 30_000);
  console.warn(`[production] ${name} exited (${detail}); restarting in ${delay}ms`);
  const timer = setTimeout(() => {
    restartTimers.delete(name);
    launch(name, command, args, options);
  }, delay);
  timer.unref?.();
  restartTimers.set(name, timer);
}

function launch(name, command, args, options = {}) {
  const { restart = false } = options;
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: 'inherit',
  });
  children.set(name, child);
  let handled = false;

  const handleFailure = (detail, exitCode = 1) => {
    if (handled) return;
    handled = true;
    if (children.get(name) === child) children.delete(name);
    if (stopping) return;
    if (restart) {
      scheduleRestart(name, command, args, options, startedAt, detail);
      return;
    }
    console.error(`[production] ${name} exited unexpectedly (${detail}); shutting down so the host can restart cleanly.`);
    shutdown(exitCode);
  };

  child.once('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    handleFailure(detail, code ?? 1);
  });

  child.once('error', (error) => {
    handleFailure(error.message, 1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();

  for (const child of children.values()) {
    try { child.kill('SIGTERM'); } catch {}
  }

  const force = setTimeout(() => {
    for (const child of children.values()) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(exitCode);
  }, 8_000);
  force.unref?.();

  Promise.all([...children.values()].map((child) => new Promise((resolve) => child.once('exit', resolve))))
    .finally(() => process.exit(exitCode));
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

if (localRuntimeEnabled) {
  launch('opencode-runtime', localRuntimeBinary, [
    'serve',
    '--hostname', '127.0.0.1',
    '--port', '4096',
  ], { restart: true });
  console.log('[production] local OpenCode runtime enabled at http://127.0.0.1:4096');
} else {
  const reason = process.env.ORLYNX_LOCAL_OPENCODE_RUNTIME === '0'
    ? 'disabled by ORLYNX_LOCAL_OPENCODE_RUNTIME=0'
    : !runtimePassword
      ? 'runtime password is not configured'
      : 'local runtime binary is not installed';
  console.warn(`[production] local OpenCode runtime unavailable (${reason}); using configured external runtime`);
}

launch('api', process.execPath, ['dist/index.js']);

if (hasDurableStorage) {
  launch('orchestrator', process.execPath, ['dist/orchestrator-worker.js']);
  console.log('[production] API + durable workspace orchestrator started');
} else {
  console.warn('[production] durable storage is not configured; starting API without orchestrator');
}
