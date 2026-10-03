import { Agent, type AgentRuntimeEvent } from '@cline/agents';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export type PortableHost = {
  root: string;
  environment: () => NodeJS.ProcessEnv;
  emit: (type: string, payload: Record<string, unknown>) => void;
  command: (command: string, readOnly: boolean, signal?: AbortSignal) => Promise<{ output: string; returncode: number }>;
  changes: () => Array<Record<string, unknown>>;
};
const processes = new Map<string, { child: ChildProcess; stopped: Promise<void>; abort: AbortController }>();
const clineRuns = new Map<string, { agent: Agent; stopped: Promise<void> }>();
const runFile=promisify(execFile);
let pythonProbe: {binary: string; at: number} | undefined;

export function adapterProviderKey(id: string): string | undefined {
  const prefix=id==='cline' ? 'ORLYNX_CLINE' : 'ORLYNX_MINI_SWE';
  const own=process.env[`${prefix}_API_KEY`];
  const base=process.env[`${prefix}_API_BASE`] || '';
  return own || (/^https:\/\/openrouter\.ai(?:\/|$)/i.test(base) ? process.env.ORLYNX_OPENROUTER_API_KEY : undefined);
}

async function providerAuthentication(base: string, key?: string): Promise<boolean> {
  if (!/^https:\/\/openrouter\.ai(?:\/|$)/i.test(base)) return true;
  if (!key) return false;
  try { const response=await fetch(`${base.replace(/\/$/,'')}/auth/key`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(3000)});return response.ok; } catch { return false; }
}

const python = () => process.env.ORLYNX_MINI_SWE_PYTHON || (fs.existsSync('/opt/orlynx/mini-swe/bin/python') ? '/opt/orlynx/mini-swe/bin/python' : fileURLToPath(new URL('../../.runner-mini-swe/bin/python', import.meta.url)));
export function portableTaskIds(): string[] { return [...processes.keys(), ...clineRuns.keys()]; }

export async function portableHealth(id: string, root: string): Promise<{ state: string; reason?: string; supportedModels?: string[]; freeModels?: string[]; runtimeVersion?: string }> {
  if (!fs.existsSync(root)) return { state: 'unavailable', reason: 'workspace_unavailable' };
  if (id === 'cline') {
    if (!process.env.ORLYNX_CLINE_API_BASE || !process.env.ORLYNX_CLINE_MODEL) return { state: 'not_installed', reason: 'Configure a compatible local/free Cline model endpoint.' };
    if (!await providerAuthentication(process.env.ORLYNX_CLINE_API_BASE,adapterProviderKey('cline'))) return {state:'unavailable',reason:'provider_auth: Configure a valid OpenRouter key for Cline.'};
    try {
      const response = await fetch(`${process.env.ORLYNX_CLINE_API_BASE.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(3000), headers: adapterProviderKey('cline') ? { Authorization: `Bearer ${adapterProviderKey('cline')}` } : {} });
      const body = await response.json() as { data?: Array<{ id: string; pricing?: {prompt?: string; completion?: string} }> };
      const wanted = process.env.ORLYNX_CLINE_MODEL.split('/').slice(1).join('/');
      if (!response.ok || !body.data?.some(model => model.id === wanted)) return { state: 'unavailable', reason: 'Configured Cline model is unavailable.' };
      const free = body.data.find(model=>model.id===wanted)?.pricing;
      return { freeModels: free?.prompt==='0' && free.completion==='0' ? [process.env.ORLYNX_CLINE_MODEL!] : [], state: clineRuns.size ? 'busy' : 'ready', supportedModels: [process.env.ORLYNX_CLINE_MODEL!], runtimeVersion: '@cline/agents@0.0.90' };
    } catch { return { state: 'unavailable', reason: 'Cline model endpoint is unreachable.' }; }
  }
  if (!process.env.ORLYNX_MINI_SWE_API_BASE || !process.env.ORLYNX_MINI_SWE_MODEL) return { state: 'not_installed', reason: 'Configure a local/free compatible model endpoint and install mini-SWE 2.4.6.' };
  if (!await providerAuthentication(process.env.ORLYNX_MINI_SWE_API_BASE,adapterProviderKey('mini-swe'))) return {state:'unavailable',reason:'provider_auth: Configure a valid OpenRouter key for mini-SWE.'};
  if (!pythonProbe || pythonProbe.binary!==python() || Date.now()-pythonProbe.at>300000) {
    try {
      await runFile(python(), ['-c', 'import minisweagent; from minisweagent.agents.default import DefaultAgent; from minisweagent.models.litellm_model import LitellmModel; assert minisweagent.__version__ == "2.4.6"'], { timeout: 10000 });
      pythonProbe={binary:python(),at:Date.now()};
    } catch { return {state:'not_installed',reason:'mini-SWE 2.4.6 import probe failed.'}; }
  }
  try {
    const response = await fetch(`${process.env.ORLYNX_MINI_SWE_API_BASE.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(3000), headers: adapterProviderKey('mini-swe') ? { Authorization: `Bearer ${adapterProviderKey('mini-swe')}` } : {} });
    if (!response.ok) return { state: 'unavailable', reason: `Model endpoint returned ${response.status}.` };
    const body = await response.json() as { data?: Array<{ id: string; pricing?: {prompt?: string; completion?: string} }> };
    const wanted = process.env.ORLYNX_MINI_SWE_MODEL.split('/').slice(1).join('/');
    if (!body.data?.some(m => m.id === wanted)) return { state: 'unavailable', reason: 'Selected mini-SWE model is not available at the configured endpoint.' };
    const free = body.data.find(model=>model.id===wanted)?.pricing;
    return { freeModels: free?.prompt==='0' && free.completion==='0' ? [process.env.ORLYNX_MINI_SWE_MODEL!] : [], state: processes.size ? 'busy' : 'ready', supportedModels: [process.env.ORLYNX_MINI_SWE_MODEL!], runtimeVersion: 'mini-swe-agent@2.4.6' };
  } catch { return { state: 'unavailable', reason: 'Configured model endpoint is unreachable.' }; }
}

export async function cancelPortable(taskId: string): Promise<Record<string, unknown>> {
  const cline = clineRuns.get(taskId);
  if (cline) { cline.agent.abort('user_cancelled'); await cline.stopped; return { cancelled: true, reconciled: true }; }
  const active = processes.get(taskId);
  if (!active) return { cancelled: false, reconciled: true };
  active.abort.abort('user_cancelled');
  try { process.kill(-active.child.pid!, 'SIGTERM'); } catch {}
  const killTimer = setTimeout(() => { try { process.kill(-active.child.pid!, 'SIGKILL'); } catch {} }, 2000);
  try { await active.stopped; } finally { clearTimeout(killTimer); }
  return { cancelled: true, reconciled: true };
}

export async function runPortable(id: string, payload: Record<string, unknown>, host: PortableHost): Promise<Record<string, unknown>> {
  const taskId = String(payload.taskId || '');
  if (processes.size || clineRuns.size) throw new Error('workspace_conflict: another adapter is still running.');
  if (id === 'cline') return runCline(payload, host);
  const model = String(payload.modelId || '');
  if (model !== process.env.ORLYNX_MINI_SWE_MODEL) throw new Error('provider_unavailable: selected model differs from the configured mini-SWE model; no model substitution is allowed.');
  const env = host.environment();
  // Only the model runner receives optional provider configuration; command
  // execution happens in the Bridge with its separate stripped environment.
  env.ORLYNX_MINI_SWE_API_BASE = process.env.ORLYNX_MINI_SWE_API_BASE;
  env.ORLYNX_MINI_SWE_API_KEY = adapterProviderKey('mini-swe');
  const child = spawn(python(), ['-u', fileURLToPath(new URL('./mini-swe-runtime.py', import.meta.url))], { cwd: host.root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const abort = new AbortController();
  processes.set(taskId, { child, stopped, abort });
  let responseText = '';
  let failure = '';
  let queue = Promise.resolve();
  let stderr = '';
  let lastProgress = Date.now();
  const watchdog = setInterval(() => { if (Date.now() - lastProgress > 6 * 60_000) { failure = 'stream_stall'; void cancelPortable(taskId); } }, 5000);
  const readOnly = payload.mode !== 'build' || payload.permission !== 'full';
  const timer = setTimeout(() => { failure = 'runtime_timeout'; void cancelPortable(taskId); }, 30 * 60_000);
  const reader = createInterface({ input: child.stdout! });
  reader.on('line', line => {
    queue = queue.then(async () => {
      lastProgress = Date.now();
      let item: Record<string, unknown>;
      try { item = JSON.parse(line); } catch { throw new Error('adapter_protocol_error: invalid mini-SWE frame'); }
      if (item.kind === 'command') {
        const command = String(item.command || '');
        const toolCallId = randomUUID();
        const before = new Map(host.changes().map(file=>[String(file.path || file.file),JSON.stringify(file)]));
        host.emit('tool.started', { tool: 'bash', title: command, command, toolCallId, adapterId: id });
        const result = await host.command(command, readOnly, abort.signal);
        host.emit('tool.completed', { tool: 'bash', title: command, command, toolCallId, code: result.returncode, stdout: result.output, adapterId: id });
        child.stdin?.write(`${JSON.stringify(result)}\n`);
        const files = host.changes();
        const changed = files.filter(file=>before.get(String(file.path || file.file))!==JSON.stringify(file));
        if (changed.length) host.emit('files.changed', { files:changed, adapterId: id });
      } else if (item.kind === 'progress') {
        host.emit('activity.progress', { text: String(item.status), sourceType: 'agent.runtime', adapterId: id });
      } else if (item.kind === 'completed') {
        responseText = String(item.text || '');
        if (responseText) host.emit('message.delta', { delta: responseText, adapterId: id });
      } else if (item.kind === 'failed') failure = String(item.error || 'runtime_crash');
      else throw new Error('adapter_protocol_error: unsupported mini-SWE frame');
    }).catch(error => { failure = error.message; void cancelPortable(taskId); });
  });
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const task = [String(payload.system || ''), payload.handoff ? `Orlynx observable handoff:\n${JSON.stringify(payload.handoff)}` : '', String(payload.text || '')].filter(Boolean).join('\n\n');
  child.stdin?.write(`${JSON.stringify({ task, model })}\n`);
  try {
    const code = await exit;
    await queue;
    if (code !== 0 || failure) throw new Error(failure || (abort.signal.aborted ? 'user_cancelled' : 'runtime_crash: mini-SWE exited before completion.'));
    return { responseText, diff: host.changes() };
  } finally {
    clearTimeout(timer); clearInterval(watchdog); reader.close(); processes.delete(taskId); finish();
    // stderr may include private provider diagnostics; never export it.
    stderr = '';
  }
}


export async function runCline(payload: Record<string, unknown>, host: PortableHost): Promise<Record<string, unknown>> {
  if (processes.size || clineRuns.size) throw new Error('workspace_conflict: another adapter is still running.');
  const model = String(payload.modelId || '');
  if (!process.env.ORLYNX_CLINE_API_BASE || model !== process.env.ORLYNX_CLINE_MODEL) throw new Error('provider_unavailable: selected model is not configured for Cline; model substitution is forbidden.');
  const taskId = String(payload.taskId || '');
  const readOnly = payload.mode !== 'build' || payload.permission !== 'full';
  let lastProgress = Date.now();
  const agent = new Agent({ providerId: 'openai-compatible', modelId: model.split('/').slice(1).join('/'),
    baseUrl: process.env.ORLYNX_CLINE_API_BASE, apiKey: adapterProviderKey('cline') || 'local-endpoint',
    maxIterations: 60, toolPolicies: { '*': { autoApprove: true } },
    systemPrompt: String(payload.system || '') + '\nYou execute an Orlynx task. Use the command tool to inspect files, edit when allowed, and verify. Never push or publish. Return concise observable results, never private reasoning.',
    tools: [{ name: 'command', description: 'Run a repository command through Orlynx permission and publication policy.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async (input: unknown, context: { signal?: AbortSignal }) => {
        const command = String((input as {command?: string}).command || '');
        const toolCallId = randomUUID();
        const before = new Map(host.changes().map(file=>[String(file.path || file.file),JSON.stringify(file)]));
        host.emit('tool.started', { tool: 'bash', command, title: command, toolCallId, adapterId: 'cline' });
        const result = await host.command(command, readOnly, context.signal);
        host.emit('tool.completed', { tool: 'bash', command, title: command, toolCallId, code: result.returncode, stdout: result.output, adapterId: 'cline' });
        const files = host.changes();
        const changed = files.filter(file=>before.get(String(file.path || file.file))!==JSON.stringify(file));
        if (changed.length) host.emit('files.changed', { files:changed, adapterId: 'cline' });
        return result;
      } }],
    hooks: { onEvent: (event: AgentRuntimeEvent) => {
      if (event.type === 'assistant-text-delta') { lastProgress = Date.now(); host.emit('message.delta', { delta: event.text, adapterId: 'cline' }); }
      else if (event.type === 'turn-started') { lastProgress = Date.now(); host.emit('activity.progress', { text: 'Cline is requesting the selected model', sourceType: 'agent.runtime', adapterId: 'cline' }); }
      // Never export snapshots, messages or assistant-reasoning-delta.
    } },
  });
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  clineRuns.set(taskId, { agent, stopped });
  const deadline = setTimeout(() => agent.abort('runtime_timeout'), 30 * 60_000);
  const watchdog = setInterval(() => { if (Date.now() - lastProgress > 6 * 60_000) agent.abort('stream_stall'); }, 5000);
  try {
    const task = [payload.handoff ? `Orlynx observable checkpoint:\n${JSON.stringify(payload.handoff)}` : '', String(payload.text || '')].filter(Boolean).join('\n\n');
    const result = await agent.run(task);
    if (result.status !== 'completed') {
      const detail = JSON.stringify(result.error || result.status);
      const code = /rate.?limit|429/i.test(detail) ? 'provider_rate_limit' : /401|403|auth/i.test(detail) ? 'provider_auth' : /timeout/i.test(detail) ? 'runtime_timeout' : /abort|cancel/i.test(detail) ? 'user_cancelled' : /context.*limit/i.test(detail) ? 'context_limit' : /connect|503|502|unavailable/i.test(detail) ? 'provider_unavailable' : 'runtime_crash';
      throw new Error(code);
    }
    return { responseText: result.outputText, diff: host.changes() };
  } finally { clearTimeout(deadline); clearInterval(watchdog); clineRuns.delete(taskId); finish(); }
}
