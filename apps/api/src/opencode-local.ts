import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCodeAccountKey } from './zen.js';

const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.ORLYNX_LOCAL_OPENCODE_RUN_TIMEOUT_MS || 10 * 60_000));

function freeModel(modelId: string): boolean {
  const id = modelId.replace(/^opencode\//, '').toLowerCase();
  return id.endsWith('-free') || id.includes('-contributor-free') || id === 'big-pickle';
}

function userScope(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
}

function eventError(event: any): string {
  return String(
    event?.error?.data?.message
      || event?.error?.message
      || event?.error?.name
      || event?.message
      || '',
  ).trim();
}

function textFromEvent(event: any): string {
  if (event?.type !== 'text') return '';
  const part = event?.part;
  if (part?.type !== 'text') return '';
  return typeof part.text === 'string' ? part.text : '';
}

export async function streamWithOfficialOpenCode(input: {
  runtimeKey: string;
  userId: string;
  modelId: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
}): Promise<string> {
  input.onStatus?.('Starting OpenCode…');

  const scope = userScope(input.userId);
  const root = path.join(os.tmpdir(), 'orlynx-opencode-run', scope);
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const cacheDir = path.join(root, 'cache');
  await Promise.all([
    fs.mkdir(projectDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(configDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
  ]);

  const normalizedModel = input.modelId.startsWith('opencode/')
    ? input.modelId
    : `opencode/${input.modelId}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: projectDir,
    XDG_DATA_HOME: dataDir,
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: cacheDir,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    NO_COLOR: '1',
    CI: '1',
  };

  // OpenCode intentionally uses its own public-key path for free Zen models
  // when no account auth is configured. Do not override that behavior.
  if (!freeModel(normalizedModel)) {
    const key = await openCodeAccountKey(input.userId);
    env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      opencode: { type: 'api', key },
    });
  } else {
    delete env.OPENCODE_AUTH_CONTENT;
  }

  const combinedPrompt = [
    input.system,
    input.prompt,
  ].filter(Boolean).join('\n\n');

  const child = spawn('opencode', [
    'run',
    '--format', 'json',
    '--model', normalizedModel,
    '--agent', 'plan',
    '--title', `Orlynx ${input.runtimeKey}`,
    '--dir', projectDir,
  ], {
    cwd: projectDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrTail = '';
  let full = '';
  let parsedError = '';
  let sawEvent = false;
  let settled = false;

  const timeout = setTimeout(() => {
    if (settled || child.exitCode !== null) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2_000).unref?.();
  }, RUN_TIMEOUT_MS);
  timeout.unref?.();

  const abort = () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000).unref?.();
    }
  };
  input.signal.addEventListener('abort', abort, { once: true });

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      // JSON mode should normally keep stdout machine-readable. Preserve any
      // unexpected text for diagnostics instead of showing it as model output.
      stderrTail = (stderrTail + '\n' + line).slice(-8_000);
      return;
    }

    sawEvent = true;
    if (event.type === 'error') {
      parsedError = eventError(event) || parsedError;
      return;
    }

    if (event.type === 'tool_use') {
      const tool = event?.part?.tool;
      if (tool) input.onStatus?.(`OpenCode is using ${String(tool)}…`);
      return;
    }

    if (event.type === 'step_start') {
      input.onStatus?.('OpenCode is working…');
      return;
    }

    const text = textFromEvent(event);
    if (text) {
      full += text;
      input.onDelta(text);
    }
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (!sawEvent) input.onStatus?.('OpenCode connected — generating response…');
    stdoutBuffer += String(chunk);
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      handleLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-8_000);
  });

  const result = new Promise<string>((resolve, reject) => {
    child.once('error', (error) => reject(error));
    child.once('close', (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

      if (input.signal.aborted) {
        reject(input.signal.reason instanceof Error ? input.signal.reason : new Error('Cancelled by user.'));
        return;
      }

      if (full.trim()) {
        resolve(full);
        return;
      }

      const detail = parsedError || stderrTail.trim();
      if (code !== 0) {
        reject(new Error(detail || `OpenCode exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`));
        return;
      }

      reject(new Error(detail || 'OpenCode completed without returning visible text.'));
    });
  });

  child.stdin?.end(combinedPrompt);
  return result;
}
