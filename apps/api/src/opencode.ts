// OpenCode HTTP adapter. It never falls back to a local/simulated agent.
import path from 'node:path';
import { dataDir, store } from './store.js';
import { bridgeRequest } from './bridge-rpc.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';

// Env is read lazily: serverless runtimes may not have every variable
// populated when modules initialize.
function baseUrl(): string { return (process.env.OPENCODE_BASE_URL || '').replace(/\/$/, ''); }
function username(): string { return process.env.OPENCODE_SERVER_USERNAME || 'opencode'; }
function password(): string { return process.env.OPENCODE_SERVER_PASSWORD || ''; }
function agentName(): string { return process.env.OPENCODE_AGENT || ''; }
function defaultModel(): string { return process.env.OPENCODE_MODEL || ''; }
function requestTimeout(): number { return Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS || 15_000); }
function projectsRoot(): string { return path.resolve(process.env.OPENCODE_PROJECTS_ROOT || path.join(dataDir, 'repos')); }

export interface OpenCodeSession { id: string; directory: string; }
export interface OpenCodeMessage { info: Record<string, any>; parts: Record<string, any>[]; }

function configured(): boolean {
  if (process.env.VERCEL === '1') return false;
  if (!baseUrl()) return false;
  try {
    const url = new URL(baseUrl());
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return (local || url.protocol === 'https:') && (local || Boolean(password()));
  } catch { return false; }
}

export function openCodeConfigured(): boolean { return configured(); }

function directoryFor(project: string): string {
  return path.join(projectsRoot(), project.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

function headers(): Record<string, string> {
  const values: Record<string, string> = { Accept: 'application/json' };
  if (password()) values.Authorization = `Basic ${Buffer.from(`${username()}:${password()}`).toString('base64')}`;
  return values;
}

function sessionForProject(project?: string, sessionId?: string) {
  if (sessionId) {
    const exact = store.db.sessions[sessionId];
    if (exact && (!project || exact.project === project)) return exact;
  }
  if (!project) return undefined;
  return Object.values(store.db.sessions)
    .filter((item) => item.project === project)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))[0];
}

async function durableOpenCodeReady(workspace: { id: string; state: string; bridgeState: string } | null): Promise<boolean> {
  if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') return false;
  const adapter = await controlPlaneRepository().getWorkspaceAgentAdapter(workspace.id, 'opencode');
  return adapter?.state === 'ready';
}

async function request<T>(project: string, apiPath: string, init: RequestInit = {}, sessionId?: string): Promise<T> {
  if (durableStorageConfigured()) {
    const session = sessionForProject(project, sessionId);
    if (!session) throw new Error('No project session is available for this OpenCode request.');
    const workspace = await controlPlaneRepository().getWorkspaceBySession(session.id);
    if (!workspace || !(await durableOpenCodeReady(workspace))) throw new Error('OpenCode adapter is not ready in this workspace.');
    const result = await bridgeRequest<{ status: number; body: T }>(workspace.id, 'opencode.request', { path: apiPath.split('?')[0], method: init.method || 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, timeoutMs: requestTimeout() });
    return result.body;
  }
  if (!configured()) throw new Error('OpenCode server is not configured. Set OPENCODE_BASE_URL and OPENCODE_SERVER_PASSWORD.');
  const directory = directoryFor(project);
  const url = new URL(apiPath, baseUrl());
  url.searchParams.set('directory', directory);
  const requestHeaders = { ...headers(), ...(init.headers as Record<string, string> || {}) };
  requestHeaders['x-opencode-directory'] = directory;
  if (init.body && !requestHeaders['Content-Type']) requestHeaders['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: requestHeaders, signal: init.signal || AbortSignal.timeout(requestTimeout()) });
  } catch {
    throw new Error('Could not reach the configured OpenCode server. Check its URL, network, and authentication.');
  }
  if (!response.ok) {
    const details = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`OpenCode request failed (HTTP ${response.status})${details ? `: ${details}` : ''}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function openCodeReadiness(project?: string, sessionId?: string): Promise<{ connected: boolean; message: string }> {
  if (durableStorageConfigured()) {
    if (!project) return { connected: false, message: 'Open a project with a ready cloud workspace to use AI.' };
    const session = sessionForProject(project, sessionId);
    const workspace = session ? await controlPlaneRepository().getWorkspaceBySession(session.id) : null;
    if (!workspace || !(await durableOpenCodeReady(workspace))) {
      return { connected: false, message: 'OpenCode adapter is not ready in this workspace.' };
    }
    try {
      const health = await bridgeRequest<{ bridge?: string; openCode?: string }>(workspace.id, 'health');
      return health.openCode === 'ready'
        ? { connected: true, message: 'OpenCode in this workspace is ready.' }
        : { connected: false, message: 'AI is not ready in this cloud workspace.' };
    } catch {
      return { connected: false, message: 'Workspace connection interrupted.' };
    }
  }
  const status = await openCodeStatus(project, sessionId);
  return { connected: status.connected, message: status.message };
}

export async function openCodeStatus(project?: string, sessionId?: string) {
  if (durableStorageConfigured()) {
    if (!project) return { configured: true, connected: false, url: null, agents: [], providers: [], connectedProviders: [], message: 'Open a project with a ready cloud workspace to use AI.' };
    const session = sessionForProject(project, sessionId);
    const workspace = session ? await controlPlaneRepository().getWorkspaceBySession(session.id) : null;
    if (!workspace || !(await durableOpenCodeReady(workspace))) return { configured: true, connected: false, url: null, agents: [], providers: [], connectedProviders: [], message: 'OpenCode adapter is not ready in this workspace.' };
    try {
      const health = await bridgeRequest<{ bridge?: string; openCode?: string }>(workspace.id, 'health');
      if (health.openCode !== 'ready') throw new Error('OpenCode is unhealthy.');
      const [agents, providerData] = await Promise.all([
        request<Record<string, any>[]>(project, '/agent', {}, sessionId).catch(() => []),
        request<any>(project, '/provider', {}, sessionId).catch(() => ({ all: [], connected: [] })),
      ]);
      return { configured: true, connected: true, url: null, directory: workspace.repoRoot, agents, providers: Array.isArray(providerData) ? providerData : providerData.all || [], connectedProviders: providerData.connected || [], message: 'OpenCode in this workspace is ready.' };
    } catch { return { configured: true, connected: false, url: null, agents: [], providers: [], connectedProviders: [], message: 'Workspace connection interrupted.' }; }
  }
  if (!configured()) return { configured: false, connected: false, url: null, agents: [], providers: [], message: 'Configure an authenticated OpenCode server to enable agent work.' };
  try {
    const directory = project ? directoryFor(project) : projectsRoot();
    const url = new URL('/global/health', baseUrl());
    const healthResponse = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(requestTimeout()) });
    if (!healthResponse.ok) throw new Error(`health HTTP ${healthResponse.status}`);
    const health = await healthResponse.json() as { healthy?: boolean; version?: string };
    let agents: Record<string, any>[] = [];
    let providers: any = { connected: [], all: [] };
    try { agents = await request(project || '', '/agent'); } catch {}
    try { providers = await request(project || '', '/provider'); } catch {}
    const all = Array.isArray(providers) ? providers : providers.all || [];
    return { configured: true, connected: Boolean(health.healthy), url: new URL(baseUrl()).origin, version: health.version, directory, agents, providers: all, connectedProviders: providers.connected || [], message: health.healthy ? 'OpenCode server is ready.' : 'OpenCode server reported unhealthy.' };
  } catch {
    return { configured: true, connected: false, url: safeOrigin(), agents: [], providers: [], connectedProviders: [], message: 'Could not reach OpenCode. Verify server health and credentials.' };
  }
}

function safeOrigin(): string | null {
  try { return new URL(baseUrl()).origin; } catch { return null; }
}

export async function getOrCreateOpenCodeSession(lynxSessionId: string, project: string): Promise<OpenCodeSession> {
  const directory = durableStorageConfigured() ? '' : directoryFor(project);
  const durableRepository = durableStorageConfigured() ? controlPlaneRepository() : null;
  const existingId = durableRepository ? await durableRepository.getAgentSession(lynxSessionId, 'opencode') || undefined : store.db.openCodeSessions[lynxSessionId];
  if (existingId) {
    try {
      const existing = await request<Record<string, any>>(project, `/session/${encodeURIComponent(existingId)}`, {}, lynxSessionId);
      if (existing.id === existingId) return { id: existingId, directory };
    } catch {
      if (!durableRepository) { delete store.db.openCodeSessions[lynxSessionId]; store.save(); }
    }
  }
  const created = await request<Record<string, any>>(project, '/session', { method: 'POST', body: JSON.stringify({ title: project }) }, lynxSessionId);
  if (!created?.id) throw new Error('OpenCode did not return a session id.');
  if (durableRepository) await durableRepository.putAgentSession(lynxSessionId, 'opencode', created.id);
  else { store.db.openCodeSessions[lynxSessionId] = created.id; store.save(); }
  return { id: created.id, directory };
}

export function getOpenCodeSessionId(lynxSessionId: string): string | undefined { return store.db.openCodeSessions[lynxSessionId]; }

export interface PromptOptions {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

function parseModel(value: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = value.split('/');
  if (!providerID || !rest.length) throw new Error('Model must use provider/model format.');
  return { providerID, modelID: rest.join('/') };
}

export async function promptOpenCode(project: string, openCodeSessionId: string, text: string, options: PromptOptions = {}): Promise<void> {
  const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
  const agent = options.agent || agentName();
  if (agent) body.agent = agent;
  const model = options.model || (defaultModel() ? parseModel(defaultModel()) : undefined);
  if (model) body.model = model;
  await request(project, `/session/${encodeURIComponent(openCodeSessionId)}/prompt_async`, { method: 'POST', body: JSON.stringify(body) });
}

export async function openCodeMessages(project: string, openCodeSessionId: string): Promise<OpenCodeMessage[]> {
  return request(project, `/session/${encodeURIComponent(openCodeSessionId)}/message?limit=12`);
}

export async function openCodeSessionStatus(project: string, openCodeSessionId: string): Promise<Record<string, any>> {
  const data = await request<Record<string, any>>(project, '/session/status');
  return data[openCodeSessionId] || { type: 'unknown' };
}

export async function openCodeDiff(project: string, openCodeSessionId: string): Promise<Record<string, any>[]> {
  return request(project, `/session/${encodeURIComponent(openCodeSessionId)}/diff`);
}

export async function abortOpenCodeSession(project: string, openCodeSessionId: string): Promise<void> {
  await request(project, `/session/${encodeURIComponent(openCodeSessionId)}/abort`, { method: 'POST' });
}

export async function runOpenCodeShell(project: string, openCodeSessionId: string, command: string, options: PromptOptions = {}): Promise<Record<string, any>> {
  const body: Record<string, unknown> = { command, agent: options.agent || agentName() || 'build' };
  const model = options.model || (defaultModel() ? parseModel(defaultModel()) : undefined);
  if (model) body.model = model;
  return request(project, `/session/${encodeURIComponent(openCodeSessionId)}/shell`, { method: 'POST', body: JSON.stringify(body) });
}

export function openCodeDefaultAgent(): string { return agentName(); }
