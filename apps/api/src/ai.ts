// Unified Orlynx AI layer. OpenCode is the engine; providers/models/modes/
// permissions merge into one experience. No demo fallbacks, no fake states.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMode, AIModel, AISessionPrefs, PermissionProfile } from '@orlynx/shared';
import { AGENT_MODES, PERMISSION_PROFILES } from '@orlynx/shared';
import { dataDir, store } from './store.js';
import { openCodeStatus } from './opencode.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';
import { encryptCredential } from './credentials.js';

export const MODES = AGENT_MODES;
export const PERMISSIONS = PERMISSION_PROFILES;

const SECRETS_FILE = path.join(dataDir, 'ai-secrets.json');

interface Secrets { providers: Record<string, { updatedAt: string }> ; keys: Record<string, string> }

function readSecrets(): Secrets {
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Secrets;
    return { providers: raw.providers || {}, keys: raw.keys || {} };
  } catch { return { providers: {}, keys: {} }; }
}

function writeSecrets(next: Secrets): void {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* best effort */ }
}

export function maskKey(key: string): string {
  const tail = key.replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return tail ? `…${tail}` : 'stored';
}

function titleCase(id: string): string {
  return id.split(/[-_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

const KNOWN_PROVIDERS: Record<string, string> = {
  opencode: 'OpenCode', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini', gemini: 'Google Gemini',
  openrouter: 'OpenRouter', azure: 'Azure OpenAI', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex',
  ollama: 'Ollama', lmstudio: 'LM Studio', deepseek: 'DeepSeek', mistral: 'Mistral',
  groq: 'Groq', xai: 'xAI', together: 'Together', fireworks: 'Fireworks',
};

export function providerDisplayName(id: string): string {
  return KNOWN_PROVIDERS[id.toLowerCase()] || titleCase(id);
}

function familyOf(modelId: string, providerId: string): string {
  const lower = `${providerId}/${modelId}`.toLowerCase();
  if (/gpt|o1|o3|o4/.test(lower)) return 'GPT';
  if (/claude/.test(lower)) return 'Claude';
  if (/gemini|gemma/.test(lower)) return 'Gemini';
  if (/llama/.test(lower)) return 'Llama';
  if (/mistral|mixtral/.test(lower)) return 'Mistral';
  if (/deepseek/.test(lower)) return 'DeepSeek';
  if (/qwen/.test(lower)) return 'Qwen';
  return titleCase(providerId);
}

interface RawCatalog { agents: Record<string, any>[]; providersAll: any[]; connectedIds: string[] }

async function catalog(status: Awaited<ReturnType<typeof openCodeStatus>>): Promise<RawCatalog> {
  const agents = Array.isArray(status.agents) ? status.agents : [];
  const rawProviders: unknown = status.providers;
  let providersAll: any[] = [];
  if (Array.isArray(rawProviders)) providersAll = rawProviders;
  const connectedRaw: unknown = status.connectedProviders;
  const connectedIds: string[] = Array.isArray(connectedRaw)
    ? connectedRaw.map((p) => String(typeof p === 'string' ? p : p?.id || p?.provider || '')).filter(Boolean)
    : [];
  return { agents, providersAll, connectedIds };
}

export function extractModels(providersAll: any[], connectedIds: string[]): AIModel[] {
  const models: AIModel[] = [];
  const connectedSet = new Set(connectedIds.map((id) => id.toLowerCase()));
  for (const provider of providersAll) {
    if (!provider || typeof provider !== 'object') continue;
    const providerId = String(provider.id || provider.provider || provider.name || '');
    if (!providerId) continue;
    const list = Array.isArray(provider.models) ? provider.models : provider.models && typeof provider.models === 'object'
      ? Object.entries(provider.models).map(([id, model]) => ({ id, name: (model as { name?: string })?.name || id }))
      : Array.isArray(provider.all) ? provider.all : [];
    const connected = connectedSet.has(providerId.toLowerCase());
    for (const entry of list) {
      const id = String(typeof entry === 'string' ? entry : entry?.id || entry?.model || entry?.name || '');
      if (!id) continue;
      models.push({
        id: `${providerId}/${id}`,
        providerId,
        providerName: providerDisplayName(providerId),
        displayName: String(typeof entry === 'object' && (entry.name || entry.displayName) ? (entry.name || entry.displayName) : id),
        family: familyOf(id, providerId),
        connected,
        status: connected ? 'available' : 'needs-connection',
      });
    }
    // Provider known but exposing no model list: surface the provider itself so
    // the user can connect it, without inventing model names.
    if (!list.length) {
      models.push({
        id: `${providerId}/default`, providerId, providerName: providerDisplayName(providerId),
        displayName: `${providerDisplayName(providerId)} default`, family: familyOf('', providerId),
        connected, status: connected ? 'available' : 'needs-connection',
      });
    }
  }
  return models;
}

export interface ProviderConnection {
  id: string; name: string;
  state: 'connected' | 'key-stored' | 'not-connected';
  modelsAvailable: number;
  keyEnding?: string;
  message: string;
}

export async function listProviderConnections(project = '', userId?: string): Promise<{ engine: { connected: boolean; message: string }; providers: ProviderConnection[]; models: AIModel[] }> {
  const status = await openCodeStatus(project || undefined);
  const localSecrets = durableStorageConfigured() ? { providers: {}, keys: {} } as Secrets : readSecrets();
  const durableRows = durableStorageConfigured() && userId ? await controlPlaneRepository().listProviderConnections(userId) : [];
  const durableIds = durableRows.filter((row) => row.state === 'connected').map((row) => row.provider);
  const locallyStored = Object.keys(localSecrets.keys);
  const accountIds = new Set([...durableIds, ...locallyStored]);

  if (!status.configured || !status.connected) {
    const providers: ProviderConnection[] = [...accountIds].map((id) => ({
      id,
      name: providerDisplayName(id),
      state: durableIds.includes(id) ? 'connected' as const : 'key-stored' as const,
      modelsAvailable: 0,
      keyEnding: localSecrets.keys[id] ? maskKey(localSecrets.keys[id]) : undefined,
      message: durableIds.includes(id)
        ? 'Connected to Orlynx. Start the workspace to load this provider in OpenCode.'
        : 'Credential is saved, but the AI engine is not ready yet.',
    }));
    return { engine: { connected: false, message: status.message }, providers, models: [] };
  }

  const { providersAll, connectedIds } = await catalog(status);
  const models = extractModels(providersAll, connectedIds);
  const byProvider = new Map<string, AIModel[]>();
  for (const model of models) {
    const rows = byProvider.get(model.providerId) || [];
    rows.push(model);
    byProvider.set(model.providerId, rows);
  }
  const ids = new Set([...byProvider.keys(), ...accountIds]);
  const providers: ProviderConnection[] = [...ids].map((id) => {
    const rows = byProvider.get(id) || [];
    const engineConnected = rows.some((m) => m.connected) || connectedIds.some((c) => c.toLowerCase() === id.toLowerCase());
    const durableConnected = durableIds.includes(id);
    const hasLocalKey = Boolean(localSecrets.keys[id]);
    if (engineConnected || durableConnected) return {
      id,
      name: providerDisplayName(id),
      state: 'connected',
      modelsAvailable: rows.length,
      keyEnding: hasLocalKey ? maskKey(localSecrets.keys[id]) : undefined,
      message: engineConnected ? 'Connected and ready.' : 'Connected. Restart or reconnect the workspace to refresh available models.',
    };
    if (hasLocalKey) return { id, name: providerDisplayName(id), state: 'key-stored', modelsAvailable: 0, keyEnding: maskKey(localSecrets.keys[id]), message: 'Credential is saved, but OpenCode has not loaded it yet.' };
    return { id, name: providerDisplayName(id), state: 'not-connected', modelsAvailable: rows.length, message: 'Not connected.' };
  });
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return { engine: { connected: true, message: status.message }, providers, models };
}

export function supportedProviderIds(): string[] {
  return Object.keys(KNOWN_PROVIDERS);
}

async function validateOpenCodeAccountKey(apiKey: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch('https://opencode.ai/zen/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error('OpenCode could not be reached. Check your connection and try again.');
  }
  if (response.status === 401 || response.status === 403) throw new Error('OpenCode rejected this key. Copy a fresh key from your OpenCode account and try again.');
  if (!response.ok) throw new Error(`OpenCode could not verify this account right now (HTTP ${response.status}). Try again shortly.`);
}

export async function connectProviderKey(providerId: string, apiKey: string, userId?: string): Promise<ProviderConnection> {
  const id = providerId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(id) || !supportedProviderIds().includes(id)) throw new Error('Unknown provider. Choose a supported AI provider.');
  if (!apiKey || apiKey.trim().length < 8) throw new Error('That API key looks incomplete. Check it and try again.');
  if (apiKey.length > 4096) throw new Error('That API key looks invalid. Check it and try again.');

  if (durableStorageConfigured()) {
    if (!userId) throw new Error('Reconnect GitHub before connecting an AI account.');
    if (id !== 'opencode') throw new Error('This provider connection is not available yet. Connect OpenCode for the current workspace.');
    await validateOpenCodeAccountKey(apiKey.trim());
    const now = new Date().toISOString();
    await controlPlaneRepository().upsertProviderConnection({
      id: `provider:${userId}:${id}`,
      userId,
      provider: id,
      credential: encryptCredential(apiKey.trim()),
      state: 'connected',
      createdAt: now,
      updatedAt: now,
    });
    return { id, name: providerDisplayName(id), state: 'connected', modelsAvailable: 0, message: 'Connected to Orlynx. Start or reconnect the workspace to load your OpenCode models.' };
  }

  const secrets = readSecrets();
  secrets.keys[id] = apiKey.trim();
  secrets.providers[id] = { updatedAt: new Date().toISOString() };
  writeSecrets(secrets);
  const { providers } = await listProviderConnections();
  const row = providers.find((p) => p.id === id);
  if (!row) throw new Error('The key was stored, but provider status could not be read. Check the AI engine and retry.');
  return row;
}

export async function disconnectProvider(providerId: string, userId?: string): Promise<void> {
  const id = providerId.trim().toLowerCase();
  if (durableStorageConfigured()) {
    if (!userId) throw new Error('Reconnect GitHub before managing AI connections.');
    await controlPlaneRepository().deleteProviderConnection(userId, id);
    return;
  }
  const secrets = readSecrets();
  delete secrets.keys[id];
  delete secrets.providers[id];
  writeSecrets(secrets);
}

export function providerHasKey(providerId: string): boolean {
  if (durableStorageConfigured()) return false;
  return Boolean(readSecrets().keys[providerId.trim().toLowerCase()]);
}

// ---- session / project / global preferences (server-side) ----

export function defaultPrefs(): { mode: AgentMode; permission: PermissionProfile; modelId?: string } {
  const mode = (process.env.ORLYNX_DEFAULT_MODE || 'build').toLowerCase();
  const permission = (process.env.ORLYNX_DEFAULT_PERMISSION || 'ask-first').toLowerCase();
  return {
    mode: (['build', 'plan', 'ask'] as AgentMode[]).includes(mode as AgentMode) ? (mode as AgentMode) : 'build',
    permission: (['full', 'ask-first', 'read-only'] as PermissionProfile[]).includes(permission as PermissionProfile) ? (permission as PermissionProfile) : 'ask-first',
    modelId: process.env.ORLYNX_DEFAULT_MODEL || undefined,
  };
}

export async function hydrateSessionPrefs(sessionId: string, project?: string): Promise<AISessionPrefs> {
  if (durableStorageConfigured()) {
    const durable = await controlPlaneRepository().getAISessionPrefs(sessionId);
    if (durable) {
      store.db.aiSessions ||= {};
      store.db.aiSessions[sessionId] = durable;
    }
  }
  return getSessionPrefs(sessionId, project);
}

export function getSessionPrefs(sessionId: string, project?: string): AISessionPrefs {
  const stored = store.db.aiSessions?.[sessionId];
  const projectDefaults = project ? store.db.aiProjectDefaults?.[project] : undefined;
  const defaults = defaultPrefs();
  return {
    sessionId,
    providerId: stored?.providerId || projectDefaults?.providerId,
    modelId: stored?.modelId || projectDefaults?.modelId || defaults.modelId,
    mode: stored?.mode || projectDefaults?.mode || defaults.mode,
    permission: stored?.permission || projectDefaults?.permission || defaults.permission,
    updatedAt: stored?.updatedAt || new Date().toISOString(),
  };
}

export function setSessionPrefs(sessionId: string, patch: { providerId?: string; modelId?: string; mode?: AgentMode; permission?: PermissionProfile }): AISessionPrefs {
  if (patch.mode && !['build', 'plan', 'ask'].includes(patch.mode)) throw new Error('Unknown agent mode.');
  if (patch.permission && !['full', 'ask-first', 'read-only'].includes(patch.permission)) throw new Error('Unknown permission profile.');
  if (patch.modelId !== undefined && patch.modelId !== '' && !/^[\w.-]+\/[\w.:-]+$/.test(patch.modelId)) throw new Error('Unknown model. Choose a model from the available list.');
  store.db.aiSessions ||= {};
  const current = store.db.aiSessions[sessionId] || { sessionId, mode: 'build' as AgentMode, permission: 'ask-first' as PermissionProfile, updatedAt: new Date().toISOString() };
  const next: AISessionPrefs = {
    ...current,
    ...(patch.providerId !== undefined ? { providerId: patch.providerId || undefined } : {}),
    ...(patch.modelId !== undefined ? { modelId: patch.modelId || undefined, providerId: patch.modelId ? patch.modelId.split('/')[0] : current.providerId } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.permission ? { permission: patch.permission } : {}),
    updatedAt: new Date().toISOString(),
  };
  store.db.aiSessions[sessionId] = next;
  store.save();
  return next;
}

export function setProjectDefaults(project: string, patch: { modelId?: string; mode?: AgentMode; permission?: PermissionProfile; providerId?: string }): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(project)) throw new Error('Unknown project.');
  store.db.aiProjectDefaults ||= {};
  store.db.aiProjectDefaults[project] = {
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.permission ? { permission: patch.permission } : {}),
  };
  store.save();
}

// ---- modes → engine agents (verified against the live agent list) ----

const MODE_AGENT: Record<AgentMode, string> = { build: '', plan: 'plan', ask: 'explore' };

export async function resolveAgentForMode(mode: AgentMode, configuredAgent: string, project = ''): Promise<{ agent?: string; note?: string }> {
  if (mode === 'build') return configuredAgent ? { agent: configuredAgent } : {};
  const wanted = MODE_AGENT[mode];
  try {
    const { agents } = await catalog(await openCodeStatus(project || undefined));
    const names = agents.map((a) => String(a?.name || a?.id || '').toLowerCase());
    if (names.includes(wanted)) return { agent: wanted };
    return { agent: configuredAgent || undefined, note: `The engine does not offer a ${wanted} agent, so this task uses the default agent with ${mode} instructions instead.` };
  } catch {
    return { agent: configuredAgent || undefined, note: 'Agent capabilities could not be verified; using the default agent.' };
  }
}

export function readOnlyInstruction(): string {
  return '[Orlynx access: READ ONLY. Inspect, search and explain only. Do NOT create, modify or delete files, run mutating commands, install packages, commit or push. If the task needs changes, explain what you would do and stop.]';
}

export function planInstruction(): string {
  return '[Orlynx mode: PLAN. Inspect the project and produce a concrete plan. Do NOT modify files, run mutating commands, commit or push unless the user explicitly asks you to proceed.]';
}

// ---- centralized permission enforcement (UI is not the boundary) ----

export type AIAction = 'terminal.exec' | 'git.commit' | 'git.push' | 'agent.task' | 'cloud.action';

const DESTRUCTIVE = [/rm\s+-rf?\s+\/(?:\s|$|\*)/, /mkfs(\s|$)/, /:\(\)\s*{\s*:\|:\s*&\s*}\s*;?\s*:/, /dd\s+.*of=\/dev\//];

export function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE.some((pattern) => pattern.test(cmd));
}

export function canPerform(sessionId: string, action: AIAction, detail?: { cmd?: string }): { allowed: boolean; reason?: string; needsApproval?: boolean } {
  const session = store.db.sessions[sessionId];
  const project = session?.project;
  const prefs = getSessionPrefs(sessionId, project);
  // Temporary per-task elevation applies only while its run is active.
  const temp = (store.db.runs[sessionId] || []).some((run) => run.state === 'running' && run.tempPermission === 'full')
    ? 'full' as PermissionProfile
    : undefined;
  const effective = temp || prefs.permission;
  if (action === 'cloud.action') return { allowed: false, reason: 'Cloud execution is not configured.' };
  if (effective === 'read-only') {
    if (action === 'terminal.exec' || action === 'git.commit' || action === 'git.push') {
      return { allowed: false, reason: 'This project is Read only. Switch access level to run commands, commit or push.' };
    }
    return { allowed: true };
  }
  if (action === 'terminal.exec' && detail?.cmd && isDestructiveCommand(detail.cmd)) {
    return { allowed: false, reason: 'This command is blocked by Orlynx safety policy, even with Full access.' };
  }
  if (effective === 'ask-first' && action === 'terminal.exec') {
    return { allowed: true, needsApproval: true };
  }
  return { allowed: true };
}

export function classifyError(message: string): 'rate_limit' | 'quota' | 'auth' | 'engine' | 'model' | 'permission' | 'unknown' {
  const text = message.toLowerCase();
  if (/429|rate.?limit|too many requests/.test(text)) return 'rate_limit';
  if (/quota|insufficient|credit|balance|billing|payment/.test(text)) return 'quota';
  if (/401|unauthorized|invalid.*(key|token)|expired|forbidden/.test(text)) return 'auth';
  if (/could not reach|unavailable|offline|econn|timeout|timed out/.test(text)) return 'engine';
  if (/model.*(not found|unavailable|unknown)|unknown model/.test(text)) return 'model';
  if (/read only|permission|denied|approval/.test(text)) return 'permission';
  return 'unknown';
}

// ---- unified status ----

export type AIState = 'disconnected' | 'ready' | 'working' | 'needs_attention' | 'error';

export type ProviderConnectionSnapshot = Awaited<ReturnType<typeof listProviderConnections>>;

export async function aiStatus(sessionId?: string, project?: string, userId?: string, snapshot?: ProviderConnectionSnapshot): Promise<{
  state: AIState; engine: string; engineConnected: boolean; message: string;
  model?: AIModel; mode: AgentMode; permission: PermissionProfile;
  providers: { connected: number; total: number };
}> {
  const prefs = sessionId ? await hydrateSessionPrefs(sessionId, project) : { mode: defaultPrefs().mode, permission: defaultPrefs().permission, modelId: defaultPrefs().modelId };
  const { engine, models, providers } = snapshot || await listProviderConnections(project, userId);
  const running = sessionId
    ? durableStorageConfigured()
      ? (await controlPlaneRepository().listTasks(sessionId)).some((r) => r.state === 'running' || r.state === 'queued')
      : (store.db.runs[sessionId] || []).some((r) => r.state === 'running')
    : false;
  if (!engine.connected) {
    return { state: 'error', engine: 'OpenCode', engineConnected: false, message: engine.message, mode: prefs.mode, permission: prefs.permission, providers: { connected: 0, total: 0 } };
  }
  const available = models.filter((m) => m.status === 'available');
  const model = prefs.modelId ? models.find((m) => m.id.toLowerCase() === prefs.modelId!.toLowerCase()) : undefined;
  const keyStoredOnly = providers.some((p) => p.state === 'key-stored');
  if (!available.length) {
    return { state: keyStoredOnly ? 'needs_attention' : 'disconnected', engine: 'OpenCode', engineConnected: true, message: keyStoredOnly ? 'A stored key has not been picked up by the engine yet.' : 'Connect an AI account to start working.', mode: prefs.mode, permission: prefs.permission, providers: { connected: 0, total: models.length } };
  }
  const effectiveModel = model && model.status === 'available' ? model : available[0];
  if (running) return { state: 'working', engine: 'OpenCode', engineConnected: true, message: 'Working.', model: effectiveModel, mode: prefs.mode, permission: prefs.permission, providers: { connected: 1, total: models.length } };
  if (prefs.modelId && (!model || model.status !== 'available')) {
    return { state: 'needs_attention', engine: 'OpenCode', engineConnected: true, message: 'The selected model is not available. Choose another model to continue.', mode: prefs.mode, permission: prefs.permission, providers: { connected: 1, total: models.length } };
  }
  return { state: 'ready', engine: 'OpenCode', engineConnected: true, message: 'Ready.', model: effectiveModel, mode: prefs.mode, permission: prefs.permission, providers: { connected: 1, total: models.length } };
}
