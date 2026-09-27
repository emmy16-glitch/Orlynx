import { spawn } from 'node:child_process';

const hasDurableStorage = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const childEnv = {
  ...process.env,
  ...(hasDurableStorage ? { ORLYNX_ORCHESTRATOR_MODE: 'worker' } : {}),
};

const children = new Map();
let stopping = false;

function launch(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: 'inherit',
  });
  children.set(name, child);

  child.once('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    console.error(`[production] ${name} exited unexpectedly (${detail}); shutting down so the host can restart cleanly.`);
    shutdown(code ?? 1);
  });

  child.once('error', (error) => {
    console.error(`[production] failed to start ${name}: ${error.message}`);
    shutdown(1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
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

launch('api', ['dist/index.js']);

if (hasDurableStorage) {
  launch('orchestrator', ['dist/orchestrator-worker.js']);
  console.log('[production] API + durable workspace orchestrator started');
} else {
  console.warn('[production] durable storage is not configured; starting API without orchestrator');
}
