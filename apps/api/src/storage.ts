import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { AISessionPrefs, ChangeSet, ChatMessage, OrlynxEvent, ProjectSession, TaskRecord, WorkspaceRecord } from '@orlynx/shared';

export interface GitHubConnectionRecord {
  userId: string;
  installationId: number;
  login: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConnectionRecord {
  id: string;
  userId: string;
  provider: string;
  credential: string;
  state: 'connected' | 'needs_attention' | 'disconnected';
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentAdapterRecord {
  workspaceId: string;
  adapterId: string;
  state: 'not_installed' | 'installing' | 'starting' | 'ready' | 'busy' | 'unavailable' | 'failed';
  reason?: string;
  updatedAt: string;
}

export interface BridgeCommand {
  id: string;
  workspaceId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'sent' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceJobRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: 'prepare';
  state: 'queued' | 'leased' | 'completed' | 'failed';
  allowFallback: boolean;
  reason?: string;
  workerId?: string;
  leaseUntil?: string;
  availableAt?: string;
  attempt: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlPlaneRepository {
  initialize(): Promise<void>;
  upsertGitHubConnection(value: GitHubConnectionRecord): Promise<void>;
  getGitHubConnectionByInstallation(installationId: number): Promise<GitHubConnectionRecord | null>;
  getGitHubConnectionByUser(userId: string): Promise<GitHubConnectionRecord | null>;
  deleteGitHubConnection(installationId: number): Promise<void>;
  upsertProviderConnection(value: ProviderConnectionRecord): Promise<void>;
  getProviderConnection(userId: string, provider: string): Promise<ProviderConnectionRecord | null>;
  listProviderConnections(userId: string): Promise<ProviderConnectionRecord[]>;
  deleteProviderConnection(userId: string, provider: string): Promise<void>;
  upsertProject(value: { id: string; userId: string; installationId: number; repositoryId: number; fullName: string; defaultBranch: string }): Promise<void>;
  putSession(value: ProjectSession & { userId: string; projectId: string }): Promise<void>;
  getSession(id: string): Promise<(ProjectSession & { userId: string; projectId: string }) | null>;
  listSessionsByUser(userId: string, limit?: number): Promise<Array<ProjectSession & { userId: string; projectId: string }>>;
  getAISessionPrefs(sessionId: string): Promise<AISessionPrefs | null>;
  putAISessionPrefs(value: AISessionPrefs): Promise<void>;
  putMessage(value: ChatMessage): Promise<void>;
  deleteMessage(id: string, sessionId: string): Promise<void>;
  listMessages(sessionId: string): Promise<ChatMessage[]>;
  putTask(value: TaskRecord): Promise<void>;
  listTasks(sessionId: string): Promise<TaskRecord[]>;
  getTask(id: string): Promise<TaskRecord | null>;
  claimNextQueuedTask(sessionId: string): Promise<TaskRecord | null>;
  claimQueuedTask(sessionId: string, taskId: string): Promise<TaskRecord | null>;
  putWorkspace(value: WorkspaceRecord): Promise<void>;
  getWorkspaceBySession(sessionId: string): Promise<WorkspaceRecord | null>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  enqueueWorkspaceJob(value: WorkspaceJobRecord): Promise<boolean>;
  claimWorkspaceJobs(workerId: string, limit?: number, leaseSeconds?: number): Promise<WorkspaceJobRecord[]>;
  completeWorkspaceJob(id: string): Promise<void>;
  renewWorkspaceJobLease(id: string, workerId: string, leaseSeconds?: number): Promise<boolean>;
  retryWorkspaceJob(id: string, error: string, delaySeconds?: number): Promise<void>;
  failWorkspaceJob(id: string, error: string): Promise<void>;
  putWorkspaceAgentAdapter(value: WorkspaceAgentAdapterRecord): Promise<void>;
  getWorkspaceAgentAdapter(workspaceId: string, adapterId: string): Promise<WorkspaceAgentAdapterRecord | null>;
  listWorkspaceAgentAdapters(workspaceId: string): Promise<WorkspaceAgentAdapterRecord[]>;
  appendEvent(value: Omit<OrlynxEvent, 'sequence'>): Promise<OrlynxEvent>;
  listEvents(sessionId: string, after?: number, limit?: number): Promise<OrlynxEvent[]>;
  listRecentEvents(sessionId: string, limit?: number): Promise<OrlynxEvent[]>;
  queueCommand(value: BridgeCommand): Promise<void>;
  claimCommands(workspaceId: string, limit?: number): Promise<BridgeCommand[]>;
  completeCommand(id: string, status: 'completed' | 'failed', result: Record<string, unknown>): Promise<void>;
  getCommand(id: string): Promise<BridgeCommand | null>;
  putAttachment(value: { id: string; sessionId: string; filename: string; safeName: string; mime: string; size: number; hash?: string; blobUrl?: string; contentBase64?: string; createdAt: string }): Promise<void>;
  listAttachments(sessionId: string): Promise<Array<{ id: string; sessionId: string; filename: string; safeName: string; mime: string; size: number; hash?: string; createdAt: string }>>;
  listAttachmentPayloads(sessionId: string): Promise<Array<{ id: string; safeName: string; contentBase64: string }>>;
  putApproval(value: { id: string; sessionId: string; taskId?: string; action: string; state: string; context: Record<string, unknown>; createdAt: string; resolvedAt?: string }): Promise<void>;
  putChangeSet(value: ChangeSet): Promise<void>;
  listChangeSets(sessionId: string): Promise<ChangeSet[]>;
  getChangeSet(id: string): Promise<ChangeSet | null>;
  getAgentSession(sessionId: string, adapterId: string): Promise<string | null>;
  putAgentSession(sessionId: string, adapterId: string, engineSessionId: string): Promise<void>;
  recordWebhookDelivery(deliveryId: string, event: string): Promise<boolean>;
  recordAudit(value: { id: string; userId: string; sessionId?: string; projectId?: string; action: string; outcome: string; detail?: Record<string, unknown>; createdAt: string }): Promise<void>;
  listAudit(sessionId: string, limit?: number): Promise<Array<{ id: string; userId: string; sessionId?: string; projectId?: string; action: string; outcome: string; detail: Record<string, unknown>; createdAt: string }>>;
  pruneOperationalData(now?: Date): Promise<void>;
}

type Sql = NeonQueryFunction<false, false>;

const migrations = [
  `CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, github_login text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS github_connections (installation_id bigint PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), github_login text NOT NULL, access_token text NOT NULL, refresh_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), installation_id bigint NOT NULL, repository_id bigint NOT NULL, full_name text NOT NULL, default_branch text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, repository_id))`,
  `CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id), installation_id bigint, project text NOT NULL, owner text, branch text NOT NULL, mode text NOT NULL, workspace_id text, checkpoint jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role text NOT NULL, text text NOT NULL, created_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, workspace_id text NOT NULL, run_id text, state text NOT NULL, prompt text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS message_id text`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_id text`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mode text`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS permission text`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS temp_permission text`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_plane text NOT NULL DEFAULT 'workspace'`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS partial_text text`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS adapter_id text NOT NULL DEFAULT 'opencode'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tasks_session_message_idx ON tasks(session_id, message_id) WHERE message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS tasks_session_state_created_idx ON tasks(session_id, state, created_at)`,
  `CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id), provider text NOT NULL, codespace_name text, runner_id text, repository_id bigint NOT NULL, branch text NOT NULL, state text NOT NULL, bridge_state text NOT NULL, connection_id text, repo_root text, failure_code text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS runner_id text`,
  `CREATE TABLE IF NOT EXISTS workspace_jobs (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind text NOT NULL, state text NOT NULL, allow_fallback boolean NOT NULL DEFAULT true, reason text, worker_id text, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(), attempt integer NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `ALTER TABLE workspace_jobs ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_jobs_active_idx ON workspace_jobs(workspace_id,kind) WHERE state IN ('queued','leased')`,
  `CREATE INDEX IF NOT EXISTS workspace_jobs_claim_idx ON workspace_jobs(state,lease_until,created_at)`,
  `CREATE TABLE IF NOT EXISTS event_sequences (session_id text PRIMARY KEY, sequence bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS task_events (event_id text PRIMARY KEY, sequence bigint NOT NULL, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, task_id text, run_id text, workspace_id text, type text NOT NULL, payload jsonb NOT NULL, timestamp timestamptz NOT NULL, UNIQUE(session_id, sequence))`,
  `CREATE INDEX IF NOT EXISTS task_events_replay_idx ON task_events(session_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS ai_session_prefs (session_id text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, provider_id text, model_id text, mode text NOT NULL, permission text NOT NULL, updated_at timestamptz NOT NULL)`,
  `ALTER TABLE ai_session_prefs ADD COLUMN IF NOT EXISTS adapter_id text NOT NULL DEFAULT 'opencode'`,
  `CREATE TABLE IF NOT EXISTS provider_connections (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), provider text NOT NULL, credential text, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS approvals (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, task_id text, action text NOT NULL, state text NOT NULL, context jsonb NOT NULL, created_at timestamptz NOT NULL, resolved_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS attachments (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, filename text NOT NULL, safe_name text NOT NULL, mime text NOT NULL, size bigint NOT NULL, hash text, blob_url text, created_at timestamptz NOT NULL)`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content_base64 text`,
  `CREATE TABLE IF NOT EXISTS bridge_commands (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, kind text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, result jsonb, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, adapter_id text NOT NULL, engine_session_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,adapter_id))`,
  `CREATE TABLE IF NOT EXISTS workspace_agent_adapters (workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, adapter_id text NOT NULL, state text NOT NULL, reason text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,adapter_id))`,
  `CREATE TABLE IF NOT EXISTS change_sets (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, record jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id text PRIMARY KEY, event text NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS audit_log (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), session_id text REFERENCES sessions(id) ON DELETE SET NULL, project_id text REFERENCES projects(id) ON DELETE SET NULL, action text NOT NULL, outcome text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS audit_log_session_idx ON audit_log(session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx ON webhook_deliveries(received_at)`,
  `CREATE INDEX IF NOT EXISTS bridge_commands_delivery_idx ON bridge_commands(workspace_id, status, created_at)`,
];

async function migrateLegacyAdapterStorage(sql: Sql): Promise<void> {
  const legacyEngineTable = rows<{ exists: boolean }>(await sql.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='engine_sessions') AS exists",
    [],
  ))[0]?.exists === true;

  if (legacyEngineTable) {
    await sql.query(
      "INSERT INTO agent_sessions (session_id,adapter_id,engine_session_id,updated_at) SELECT session_id,'opencode',engine_session_id,updated_at FROM engine_sessions ON CONFLICT (session_id,adapter_id) DO NOTHING",
      [],
    );
    await sql.query('DROP TABLE engine_sessions', []);
  }

  const legacyOpenCodeColumn = rows<{ exists: boolean }>(await sql.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspaces' AND column_name='opencode_state') AS exists",
    [],
  ))[0]?.exists === true;

  if (legacyOpenCodeColumn) {
    await sql.query(
      "INSERT INTO workspace_agent_adapters (workspace_id,adapter_id,state,updated_at) SELECT id,'opencode',opencode_state,updated_at FROM workspaces ON CONFLICT (workspace_id,adapter_id) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at",
      [],
    );
    await sql.query('ALTER TABLE workspaces DROP COLUMN opencode_state', []);
  }
}

function rows<T>(value: unknown): T[] { return value as T[]; }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }

function mapSession(r: Record<string, unknown>): ProjectSession & { userId: string; projectId: string } {
  return {
    id: String(r.id), userId: String(r.user_id), projectId: String(r.project_id),
    installationId: r.installation_id ? Number(r.installation_id) : undefined,
    project: String(r.project), owner: r.owner ? String(r.owner) : undefined,
    branch: String(r.branch), mode: r.mode as ProjectSession['mode'],
    workspaceId: r.workspace_id ? String(r.workspace_id) : null,
    checkpoint: (r.checkpoint || undefined) as ProjectSession['checkpoint'],
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id), sessionId: String(row.session_id), userId: String(row.user_id), projectId: String(row.project_id),
    provider: row.provider === 'orlynx-runner' ? 'orlynx-runner' : 'github-codespaces', codespaceName: row.codespace_name ? String(row.codespace_name) : undefined, runnerId: row.runner_id ? String(row.runner_id) : undefined,
    repositoryId: Number(row.repository_id), branch: String(row.branch), state: row.state as WorkspaceRecord['state'],
    bridgeState: row.bridge_state as WorkspaceRecord['bridgeState'],
    connectionId: row.connection_id ? String(row.connection_id) : undefined, repoRoot: row.repo_root ? String(row.repo_root) : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function mapWorkspaceJob(row: Record<string, unknown>): WorkspaceJobRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    kind: 'prepare',
    state: String(row.state) as WorkspaceJobRecord['state'],
    allowFallback: row.allow_fallback !== false,
    reason: row.reason ? String(row.reason) : undefined,
    workerId: row.worker_id ? String(row.worker_id) : undefined,
    leaseUntil: row.lease_until ? iso(row.lease_until) : undefined,
    availableAt: row.available_at ? iso(row.available_at) : undefined,
    attempt: Number(row.attempt || 0),
    error: row.error ? String(row.error) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    workspaceId: String(row.workspace_id),
    plane: row.execution_plane === 'direct' ? 'direct' : 'workspace',
    runId: row.run_id ? String(row.run_id) : undefined,
    messageId: row.message_id ? String(row.message_id) : undefined,
    state: row.state as TaskRecord['state'],
    prompt: String(row.prompt),
    modelId: row.model_id ? String(row.model_id) : undefined,
    adapterId: row.adapter_id ? String(row.adapter_id) : 'opencode',
    mode: row.mode ? row.mode as TaskRecord['mode'] : undefined,
    permission: row.permission ? row.permission as TaskRecord['permission'] : undefined,
    tempPermission: row.temp_permission ? row.temp_permission as TaskRecord['tempPermission'] : undefined,
    partialText: row.partial_text ? String(row.partial_text) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  private ready?: Promise<void>;
  constructor(private readonly sql: Sql) {}
  initialize(): Promise<void> {
    this.ready ||= (async () => {
      for (const statement of migrations) await this.sql.query(statement, []);
      await migrateLegacyAdapterStorage(this.sql);
    })();
    return this.ready;
  }
  async upsertGitHubConnection(v: GitHubConnectionRecord) {
    await this.initialize();
    await this.sql`INSERT INTO users (id, github_login, created_at, updated_at) VALUES (${v.userId}, ${v.login}, ${v.createdAt}, ${v.updatedAt}) ON CONFLICT (id) DO UPDATE SET github_login=EXCLUDED.github_login, updated_at=EXCLUDED.updated_at`;
    await this.sql`INSERT INTO github_connections (installation_id,user_id,github_login,access_token,refresh_token,access_token_expires_at,refresh_token_expires_at,created_at,updated_at) VALUES (${v.installationId},${v.userId},${v.login},${v.accessToken},${v.refreshToken || null},${v.accessTokenExpiresAt || null},${v.refreshTokenExpiresAt || null},${v.createdAt},${v.updatedAt}) ON CONFLICT (installation_id) DO UPDATE SET user_id=EXCLUDED.user_id,github_login=EXCLUDED.github_login,access_token=EXCLUDED.access_token,refresh_token=EXCLUDED.refresh_token,access_token_expires_at=EXCLUDED.access_token_expires_at,refresh_token_expires_at=EXCLUDED.refresh_token_expires_at,updated_at=EXCLUDED.updated_at`;
  }
  async getGitHubConnectionByInstallation(installationId: number) {
    await this.initialize();
    const result = rows<Record<string, unknown>>(await this.sql`SELECT * FROM github_connections WHERE installation_id=${installationId}`)[0];
    if (!result) return null;
    return { userId: String(result.user_id), installationId: Number(result.installation_id), login: String(result.github_login), accessToken: String(result.access_token), refreshToken: result.refresh_token ? String(result.refresh_token) : undefined, accessTokenExpiresAt: result.access_token_expires_at ? iso(result.access_token_expires_at) : undefined, refreshTokenExpiresAt: result.refresh_token_expires_at ? iso(result.refresh_token_expires_at) : undefined, createdAt: iso(result.created_at), updatedAt: iso(result.updated_at) };
  }
  async getGitHubConnectionByUser(userId: string) {
    await this.initialize();
    const result = rows<Record<string, unknown>>(await this.sql`SELECT * FROM github_connections WHERE user_id=${userId} ORDER BY updated_at DESC LIMIT 1`)[0];
    if (!result) return null;
    return { userId: String(result.user_id), installationId: Number(result.installation_id), login: String(result.github_login), accessToken: String(result.access_token), refreshToken: result.refresh_token ? String(result.refresh_token) : undefined, accessTokenExpiresAt: result.access_token_expires_at ? iso(result.access_token_expires_at) : undefined, refreshTokenExpiresAt: result.refresh_token_expires_at ? iso(result.refresh_token_expires_at) : undefined, createdAt: iso(result.created_at), updatedAt: iso(result.updated_at) };
  }
  async deleteGitHubConnection(installationId: number) { await this.initialize(); await this.sql`DELETE FROM github_connections WHERE installation_id=${installationId}`; }
  async upsertProviderConnection(v: ProviderConnectionRecord) {
    await this.initialize();
    await this.sql`INSERT INTO provider_connections (id,user_id,provider,credential,state,created_at,updated_at) VALUES (${v.id},${v.userId},${v.provider},${v.credential},${v.state},${v.createdAt},${v.updatedAt}) ON CONFLICT (id) DO UPDATE SET credential=EXCLUDED.credential,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`;
  }
  async getProviderConnection(userId: string, provider: string) {
    await this.initialize();
    const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM provider_connections WHERE user_id=${userId} AND provider=${provider} ORDER BY updated_at DESC LIMIT 1`)[0];
    return r ? { id: String(r.id), userId: String(r.user_id), provider: String(r.provider), credential: String(r.credential || ''), state: String(r.state) as ProviderConnectionRecord['state'], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : null;
  }
  async listProviderConnections(userId: string) {
    await this.initialize();
    return rows<Record<string, unknown>>(await this.sql`SELECT * FROM provider_connections WHERE user_id=${userId} ORDER BY updated_at DESC`).map((r) => ({ id: String(r.id), userId: String(r.user_id), provider: String(r.provider), credential: String(r.credential || ''), state: String(r.state) as ProviderConnectionRecord['state'], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  }
  async deleteProviderConnection(userId: string, provider: string) {
    await this.initialize();
    await this.sql`DELETE FROM provider_connections WHERE user_id=${userId} AND provider=${provider}`;
  }
  async upsertProject(v: { id: string; userId: string; installationId: number; repositoryId: number; fullName: string; defaultBranch: string }) {
    await this.initialize();
    await this.sql`INSERT INTO projects (id,user_id,installation_id,repository_id,full_name,default_branch) VALUES (${v.id},${v.userId},${v.installationId},${v.repositoryId},${v.fullName},${v.defaultBranch}) ON CONFLICT (id) DO UPDATE SET full_name=EXCLUDED.full_name,default_branch=EXCLUDED.default_branch,updated_at=now()`;
  }
  async putSession(v: ProjectSession & { userId: string; projectId: string }) {
    await this.initialize();
    await this.sql`INSERT INTO sessions (id,user_id,project_id,installation_id,project,owner,branch,mode,workspace_id,checkpoint,created_at,updated_at) VALUES (${v.id},${v.userId},${v.projectId},${v.installationId || null},${v.project},${v.owner || null},${v.branch},${v.mode},${v.workspaceId},${JSON.stringify(v.checkpoint || null)},${v.createdAt},${v.updatedAt}) ON CONFLICT (id) DO UPDATE SET mode=EXCLUDED.mode,workspace_id=EXCLUDED.workspace_id,checkpoint=EXCLUDED.checkpoint,updated_at=EXCLUDED.updated_at`;
  }
  async getSession(id: string) {
    await this.initialize();
    const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM sessions WHERE id=${id}`)[0];
    return r ? mapSession(r) : null;
  }
  async listSessionsByUser(userId: string, limit = 20) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    return rows<Record<string, unknown>>(await this.sql.query('SELECT * FROM sessions WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2', [userId, safeLimit])).map(mapSession);
  }
  async getAISessionPrefs(sessionId: string) {
    await this.initialize();
    const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM ai_session_prefs WHERE session_id=${sessionId}`)[0];
    return r ? { sessionId: String(r.session_id), adapterId: r.adapter_id ? String(r.adapter_id) : 'opencode', providerId: r.provider_id ? String(r.provider_id) : undefined, modelId: r.model_id ? String(r.model_id) : undefined, mode: String(r.mode) as AISessionPrefs['mode'], permission: String(r.permission) as AISessionPrefs['permission'], updatedAt: iso(r.updated_at) } : null;
  }
  async putAISessionPrefs(v: AISessionPrefs) {
    await this.initialize();
    await this.sql`INSERT INTO ai_session_prefs (session_id,adapter_id,provider_id,model_id,mode,permission,updated_at) VALUES (${v.sessionId},${v.adapterId || 'opencode'},${v.providerId || null},${v.modelId || null},${v.mode},${v.permission},${v.updatedAt}) ON CONFLICT (session_id) DO UPDATE SET adapter_id=EXCLUDED.adapter_id,provider_id=EXCLUDED.provider_id,model_id=EXCLUDED.model_id,mode=EXCLUDED.mode,permission=EXCLUDED.permission,updated_at=EXCLUDED.updated_at`;
  }
  async putMessage(v: ChatMessage) { await this.initialize(); await this.sql`INSERT INTO messages (id,session_id,role,text,created_at) VALUES (${v.id},${v.sessionId},${v.role},${v.text},${v.createdAt}) ON CONFLICT (id) DO NOTHING`; }
  async deleteMessage(id: string, sessionId: string) { await this.initialize(); await this.sql`DELETE FROM messages WHERE id=${id} AND session_id=${sessionId}`; }
  async listMessages(sessionId: string) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT * FROM messages WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => ({ id: String(r.id), sessionId: String(r.session_id), role: r.role as ChatMessage['role'], text: String(r.text), createdAt: iso(r.created_at) })); }
  async putTask(v: TaskRecord) {
    await this.initialize();
    await this.sql`INSERT INTO tasks (id,session_id,workspace_id,execution_plane,adapter_id,run_id,message_id,state,prompt,model_id,mode,permission,temp_permission,partial_text,created_at,updated_at)
      VALUES (${v.id},${v.sessionId},${v.workspaceId},${v.plane || 'workspace'},${v.adapterId || 'opencode'},${v.runId || null},${v.messageId || null},${v.state},${v.prompt},${v.modelId || null},${v.mode || null},${v.permission || null},${v.tempPermission || null},${v.partialText || null},${v.createdAt},${v.updatedAt})
      ON CONFLICT (id) DO UPDATE SET adapter_id=EXCLUDED.adapter_id,run_id=EXCLUDED.run_id,message_id=EXCLUDED.message_id,state=EXCLUDED.state,prompt=EXCLUDED.prompt,model_id=EXCLUDED.model_id,mode=EXCLUDED.mode,permission=EXCLUDED.permission,temp_permission=EXCLUDED.temp_permission,execution_plane=EXCLUDED.execution_plane,partial_text=EXCLUDED.partial_text,updated_at=EXCLUDED.updated_at`;
  }
  async listTasks(sessionId: string) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT * FROM tasks WHERE session_id=${sessionId} ORDER BY created_at,id`).map(mapTask); }
  async getTask(id: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM tasks WHERE id=${id}`)[0]; return r ? mapTask(r) : null; }
  async claimNextQueuedTask(sessionId: string) {
    await this.initialize();
    const row = rows<Record<string, unknown>>(await this.sql`
      WITH candidate AS (
        SELECT queued.id
        FROM tasks queued
        WHERE queued.session_id=${sessionId}
          AND queued.state='queued'
          AND NOT EXISTS (
            SELECT 1 FROM tasks active
            WHERE active.session_id=${sessionId} AND active.state='running'
          )
        ORDER BY queued.created_at, queued.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
      SET state='running', updated_at=now()
      WHERE id IN (SELECT id FROM candidate)
      RETURNING *
    `)[0];
    return row ? mapTask(row) : null;
  }
  async claimQueuedTask(sessionId: string, taskId: string) {
    await this.initialize();
    const row = rows<Record<string, unknown>>(await this.sql`
      UPDATE tasks queued
      SET state='running', updated_at=now()
      WHERE queued.id=${taskId}
        AND queued.session_id=${sessionId}
        AND queued.state='queued'
        AND NOT EXISTS (
          SELECT 1 FROM tasks active
          WHERE active.session_id=${sessionId} AND active.state='running'
        )
      RETURNING queued.*
    `)[0];
    return row ? mapTask(row) : null;
  }
  async putWorkspace(v: WorkspaceRecord) {
    await this.initialize();
    await this.sql`INSERT INTO workspaces (id,session_id,user_id,project_id,provider,codespace_name,runner_id,repository_id,branch,state,bridge_state,connection_id,repo_root,failure_code,created_at,updated_at) VALUES (${v.id},${v.sessionId},${v.userId},${v.projectId},${v.provider},${v.codespaceName || null},${v.runnerId || null},${v.repositoryId},${v.branch},${v.state},${v.bridgeState},${v.connectionId || null},${v.repoRoot || null},${v.failureCode || null},${v.createdAt},${v.updatedAt}) ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider,codespace_name=EXCLUDED.codespace_name,runner_id=EXCLUDED.runner_id,state=EXCLUDED.state,bridge_state=EXCLUDED.bridge_state,connection_id=EXCLUDED.connection_id,repo_root=EXCLUDED.repo_root,failure_code=EXCLUDED.failure_code,updated_at=EXCLUDED.updated_at`;
  }
  async getWorkspaceBySession(sessionId: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM workspaces WHERE session_id=${sessionId} ORDER BY created_at DESC LIMIT 1`)[0]; return r ? mapWorkspace(r) : null; }
  async getWorkspace(id: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM workspaces WHERE id=${id}`)[0]; return r ? mapWorkspace(r) : null; }
  async enqueueWorkspaceJob(v: WorkspaceJobRecord) {
    await this.initialize();
    const result = await this.sql.query(
      `INSERT INTO workspace_jobs (id,workspace_id,session_id,kind,state,allow_fallback,reason,available_at,attempt,error,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,now(),0,NULL,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [v.id, v.workspaceId, v.sessionId, v.kind, v.allowFallback, v.reason || null, v.createdAt, v.updatedAt],
    );
    const inserted = rows<Record<string, unknown>>(result).length > 0;
    if (!inserted && v.allowFallback) {
      await this.sql.query(
        `UPDATE workspace_jobs
         SET allow_fallback=true, reason=COALESCE(reason,$3), updated_at=now()
         WHERE workspace_id=$1 AND kind=$2 AND state IN ('queued','leased')`,
        [v.workspaceId, v.kind, v.reason || null],
      );
    }
    return inserted;
  }
  async claimWorkspaceJobs(workerId: string, limit = 4, leaseSeconds = 90) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 4, 20));
    const safeLease = Math.max(30, Math.min(Number(leaseSeconds) || 90, 600));
    const result = await this.sql.query(
      `WITH candidate AS (
         SELECT id FROM workspace_jobs
         WHERE (state='queued' AND available_at <= now()) OR (state='leased' AND lease_until < now())
         ORDER BY created_at,id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE workspace_jobs
       SET state='leased', worker_id=$2, lease_until=now() + ($3 * interval '1 second'), attempt=attempt+1, updated_at=now()
       WHERE id IN (SELECT id FROM candidate)
       RETURNING *`,
      [safeLimit, workerId, safeLease],
    );
    return rows<Record<string, unknown>>(result).map(mapWorkspaceJob);
  }
  async completeWorkspaceJob(id: string) {
    await this.initialize();
    await this.sql`UPDATE workspace_jobs SET state='completed',worker_id=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE id=${id}`;
  }
  async renewWorkspaceJobLease(id: string, workerId: string, leaseSeconds = 90) {
    await this.initialize();
    const safeLease = Math.max(30, Math.min(Number(leaseSeconds) || 90, 600));
    const result = await this.sql.query(
      `UPDATE workspace_jobs SET lease_until=now() + ($3 * interval '1 second'),updated_at=now()
       WHERE id=$1 AND state='leased' AND worker_id=$2 RETURNING id`,
      [id, workerId, safeLease],
    );
    return rows<Record<string, unknown>>(result).length > 0;
  }
  async retryWorkspaceJob(id: string, error: string, delaySeconds = 3) {
    await this.initialize();
    const safeDelay = Math.max(1, Math.min(Number(delaySeconds) || 3, 300));
    await this.sql.query(
      `UPDATE workspace_jobs SET state='queued',worker_id=NULL,lease_until=NULL,available_at=now() + ($3 * interval '1 second'),error=$2,updated_at=now() WHERE id=$1`,
      [id, error.slice(0,1000), safeDelay],
    );
  }
  async failWorkspaceJob(id: string, error: string) {
    await this.initialize();
    await this.sql`UPDATE workspace_jobs SET state='failed',worker_id=NULL,lease_until=NULL,error=${error.slice(0,1000)},updated_at=now() WHERE id=${id}`;
  }
  async putWorkspaceAgentAdapter(v: WorkspaceAgentAdapterRecord) {
    await this.initialize();
    await this.sql`INSERT INTO workspace_agent_adapters (workspace_id,adapter_id,state,reason,updated_at) VALUES (${v.workspaceId},${v.adapterId},${v.state},${v.reason || null},${v.updatedAt}) ON CONFLICT (workspace_id,adapter_id) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`;
  }
  async getWorkspaceAgentAdapter(workspaceId: string, adapterId: string) {
    await this.initialize();
    const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM workspace_agent_adapters WHERE workspace_id=${workspaceId} AND adapter_id=${adapterId}`)[0];
    return r ? { workspaceId: String(r.workspace_id), adapterId: String(r.adapter_id), state: String(r.state) as WorkspaceAgentAdapterRecord['state'], reason: r.reason ? String(r.reason) : undefined, updatedAt: iso(r.updated_at) } : null;
  }
  async listWorkspaceAgentAdapters(workspaceId: string) {
    await this.initialize();
    return rows<Record<string, unknown>>(await this.sql`SELECT * FROM workspace_agent_adapters WHERE workspace_id=${workspaceId} ORDER BY adapter_id`).map((r) => ({ workspaceId: String(r.workspace_id), adapterId: String(r.adapter_id), state: String(r.state) as WorkspaceAgentAdapterRecord['state'], reason: r.reason ? String(r.reason) : undefined, updatedAt: iso(r.updated_at) }));
  }
  async appendEvent(v: Omit<OrlynxEvent, 'sequence'>): Promise<OrlynxEvent> {
    await this.initialize();
    const seq = rows<{ sequence: string }>(await this.sql`INSERT INTO event_sequences (session_id,sequence) VALUES (${v.sessionId},1) ON CONFLICT (session_id) DO UPDATE SET sequence=event_sequences.sequence+1 RETURNING sequence`)[0];
    const event = { ...v, sequence: Number(seq.sequence) };
    await this.sql`INSERT INTO task_events (event_id,sequence,session_id,task_id,run_id,workspace_id,type,payload,timestamp) VALUES (${event.eventId},${event.sequence},${event.sessionId},${event.taskId || null},${event.runId || null},${event.workspaceId || null},${event.type},${JSON.stringify(event.payload)},${event.timestamp}) ON CONFLICT (event_id) DO NOTHING`;
    return event;
  }
  async listEvents(sessionId: string, after = 0, limit = 200) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT * FROM task_events WHERE session_id=${sessionId} AND sequence>${after} ORDER BY sequence LIMIT ${limit}`).map((r) => ({ eventId: String(r.event_id), sequence: Number(r.sequence), sessionId: String(r.session_id), taskId: r.task_id ? String(r.task_id) : undefined, runId: r.run_id ? String(r.run_id) : undefined, workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, type: r.type as OrlynxEvent['type'], payload: r.payload as Record<string, unknown>, timestamp: iso(r.timestamp) })); }
  async listRecentEvents(sessionId: string, limit = 300) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 500));
    const recent = rows<Record<string, unknown>>(await this.sql.query(
      'SELECT * FROM task_events WHERE session_id=$1 ORDER BY sequence DESC LIMIT $2',
      [sessionId, safeLimit],
    ));
    return recent.reverse().map((r) => ({ eventId: String(r.event_id), sequence: Number(r.sequence), sessionId: String(r.session_id), taskId: r.task_id ? String(r.task_id) : undefined, runId: r.run_id ? String(r.run_id) : undefined, workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, type: r.type as OrlynxEvent['type'], payload: r.payload as Record<string, unknown>, timestamp: iso(r.timestamp) }));
  }
  async queueCommand(v: BridgeCommand) { await this.initialize(); await this.sql`INSERT INTO bridge_commands (id,workspace_id,kind,payload,status,result,expires_at,created_at,updated_at) VALUES (${v.id},${v.workspaceId},${v.kind},${JSON.stringify(v.payload)},${v.status},${JSON.stringify(v.result || null)},${v.expiresAt},${v.createdAt},${v.updatedAt})`; }
  async claimCommands(workspaceId: string, limit = 20) {
    await this.initialize();
    // Expired commands must not stay in queued/sent forever. A lost bridge
    // result can otherwise leave durable state looking active indefinitely.
    await this.sql`UPDATE bridge_commands SET status='failed',result=${JSON.stringify({ error: 'Workspace command expired before completion.' })},updated_at=now() WHERE workspace_id=${workspaceId} AND status IN ('queued','sent') AND expires_at<=now()`;
    return rows<Record<string, unknown>>(await this.sql`UPDATE bridge_commands SET status='sent',updated_at=now() WHERE id IN (SELECT id FROM bridge_commands WHERE workspace_id=${workspaceId} AND (status='queued' OR (status='sent' AND updated_at < now() - interval '15 seconds')) AND expires_at>now() ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING *`).map(mapCommand);
  }
  async completeCommand(id: string, status: 'completed' | 'failed', result: Record<string, unknown>) { await this.initialize(); await this.sql`UPDATE bridge_commands SET status=${status},result=${JSON.stringify(result)},updated_at=now() WHERE id=${id}`; }
  async getCommand(id: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM bridge_commands WHERE id=${id}`)[0]; return r ? mapCommand(r) : null; }
  async putAttachment(v: { id: string; sessionId: string; filename: string; safeName: string; mime: string; size: number; hash?: string; blobUrl?: string; contentBase64?: string; createdAt: string }) { await this.initialize(); await this.sql`INSERT INTO attachments (id,session_id,filename,safe_name,mime,size,hash,blob_url,content_base64,created_at) VALUES (${v.id},${v.sessionId},${v.filename},${v.safeName},${v.mime},${v.size},${v.hash || null},${v.blobUrl || null},${v.contentBase64 || null},${v.createdAt}) ON CONFLICT (id) DO NOTHING`; }
  async listAttachments(sessionId: string) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT id,session_id,filename,safe_name,mime,size,hash,created_at FROM attachments WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => ({ id: String(r.id), sessionId: String(r.session_id), filename: String(r.filename), safeName: String(r.safe_name), mime: String(r.mime), size: Number(r.size), hash: r.hash ? String(r.hash) : undefined, createdAt: iso(r.created_at) })); }
  async listAttachmentPayloads(sessionId: string) {
    await this.initialize();
    return rows<Record<string, unknown>>(await this.sql`SELECT id,safe_name,content_base64 FROM attachments WHERE session_id=${sessionId} AND content_base64 IS NOT NULL ORDER BY created_at`).map((r) => ({ id: String(r.id), safeName: String(r.safe_name), contentBase64: String(r.content_base64) }));
  }
  async putApproval(v: { id: string; sessionId: string; taskId?: string; action: string; state: string; context: Record<string, unknown>; createdAt: string; resolvedAt?: string }) { await this.initialize(); await this.sql`INSERT INTO approvals (id,session_id,task_id,action,state,context,created_at,resolved_at) VALUES (${v.id},${v.sessionId},${v.taskId || null},${v.action},${v.state},${JSON.stringify(v.context)},${v.createdAt},${v.resolvedAt || null}) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,resolved_at=EXCLUDED.resolved_at`; }
  async putChangeSet(v: ChangeSet) { await this.initialize(); await this.sql`INSERT INTO change_sets (id,session_id,record,created_at) VALUES (${v.id},${v.sessionId},${JSON.stringify(v)},${v.createdAt}) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record,updated_at=now()`; }
  async listChangeSets(sessionId: string) { await this.initialize(); return rows<{ record: ChangeSet }>(await this.sql`SELECT record FROM change_sets WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => r.record); }
  async getChangeSet(id: string) { await this.initialize(); return rows<{ record: ChangeSet }>(await this.sql`SELECT record FROM change_sets WHERE id=${id}`)[0]?.record || null; }
  async getAgentSession(sessionId: string, adapterId: string) {
    await this.initialize();
    const r = rows<{ engine_session_id: string }>(await this.sql`SELECT engine_session_id FROM agent_sessions WHERE session_id=${sessionId} AND adapter_id=${adapterId}`)[0];
    return r?.engine_session_id || null;
  }
  async putAgentSession(sessionId: string, adapterId: string, engineSessionId: string) {
    await this.initialize();
    await this.sql`INSERT INTO agent_sessions (session_id,adapter_id,engine_session_id) VALUES (${sessionId},${adapterId},${engineSessionId}) ON CONFLICT (session_id,adapter_id) DO UPDATE SET engine_session_id=EXCLUDED.engine_session_id,updated_at=now()`;
  }
  async recordWebhookDelivery(deliveryId: string, event: string) {
    await this.initialize();
    const result = rows<{ delivery_id: string }>(await this.sql`INSERT INTO webhook_deliveries (delivery_id,event) VALUES (${deliveryId},${event}) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`);
    return result.length === 1;
  }
  async recordAudit(v: { id: string; userId: string; sessionId?: string; projectId?: string; action: string; outcome: string; detail?: Record<string, unknown>; createdAt: string }) {
    await this.initialize();
    await this.sql`INSERT INTO audit_log (id,user_id,session_id,project_id,action,outcome,detail,created_at) VALUES (${v.id},${v.userId},${v.sessionId || null},${v.projectId || null},${v.action},${v.outcome},${JSON.stringify(v.detail || {})},${v.createdAt}) ON CONFLICT (id) DO NOTHING`;
  }
  async listAudit(sessionId: string, limit = 100) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return rows<Record<string, unknown>>(await this.sql.query('SELECT * FROM audit_log WHERE session_id=$1 ORDER BY created_at DESC LIMIT $2', [sessionId, safeLimit])).map((r) => ({
      id: String(r.id), userId: String(r.user_id), sessionId: r.session_id ? String(r.session_id) : undefined,
      projectId: r.project_id ? String(r.project_id) : undefined, action: String(r.action), outcome: String(r.outcome),
      detail: (r.detail || {}) as Record<string, unknown>, createdAt: iso(r.created_at),
    }));
  }
  async pruneOperationalData(now = new Date()) {
    await this.initialize();
    await this.sql.query("DELETE FROM webhook_deliveries WHERE received_at < $1::timestamptz - interval '30 days'", [now.toISOString()]);
    await this.sql.query("DELETE FROM bridge_commands WHERE status IN ('completed','failed') AND updated_at < $1::timestamptz - interval '7 days'", [now.toISOString()]);
  }
}

function mapCommand(r: Record<string, unknown>): BridgeCommand { return { id: String(r.id), workspaceId: String(r.workspace_id), kind: String(r.kind), payload: r.payload as Record<string, unknown>, status: r.status as BridgeCommand['status'], result: (r.result || undefined) as Record<string, unknown> | undefined, expiresAt: iso(r.expires_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }; }

let repository: ControlPlaneRepository | undefined;
export function controlPlaneRepository(): ControlPlaneRepository {
  if (repository) return repository;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('Durable Postgres is not configured. Set DATABASE_URL.');
  repository = new PostgresControlPlaneRepository(neon(url));
  return repository;
}

export function durableStorageConfigured(): boolean { return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL); }
export function setControlPlaneRepositoryForTests(value: ControlPlaneRepository | undefined): void { repository = value; }
