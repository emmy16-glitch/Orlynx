import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { ChangeSet, ChatMessage, OrlynxEvent, ProjectSession, TaskRecord, WorkspaceRecord } from '@orlynx/shared';

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

export interface ControlPlaneRepository {
  initialize(): Promise<void>;
  upsertGitHubConnection(value: GitHubConnectionRecord): Promise<void>;
  getGitHubConnectionByInstallation(installationId: number): Promise<GitHubConnectionRecord | null>;
  getGitHubConnectionByUser(userId: string): Promise<GitHubConnectionRecord | null>;
  deleteGitHubConnection(installationId: number): Promise<void>;
  upsertProject(value: { id: string; userId: string; installationId: number; repositoryId: number; fullName: string; defaultBranch: string }): Promise<void>;
  putSession(value: ProjectSession & { userId: string; projectId: string }): Promise<void>;
  getSession(id: string): Promise<(ProjectSession & { userId: string; projectId: string }) | null>;
  putMessage(value: ChatMessage): Promise<void>;
  listMessages(sessionId: string): Promise<ChatMessage[]>;
  putTask(value: TaskRecord): Promise<void>;
  listTasks(sessionId: string): Promise<TaskRecord[]>;
  getTask(id: string): Promise<TaskRecord | null>;
  putWorkspace(value: WorkspaceRecord): Promise<void>;
  getWorkspaceBySession(sessionId: string): Promise<WorkspaceRecord | null>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  appendEvent(value: Omit<OrlynxEvent, 'sequence'>): Promise<OrlynxEvent>;
  listEvents(sessionId: string, after?: number, limit?: number): Promise<OrlynxEvent[]>;
  queueCommand(value: BridgeCommand): Promise<void>;
  claimCommands(workspaceId: string, limit?: number): Promise<BridgeCommand[]>;
  completeCommand(id: string, status: 'completed' | 'failed', result: Record<string, unknown>): Promise<void>;
  getCommand(id: string): Promise<BridgeCommand | null>;
  putAttachment(value: { id: string; sessionId: string; filename: string; safeName: string; mime: string; size: number; hash?: string; blobUrl?: string; contentBase64?: string; createdAt: string }): Promise<void>;
  listAttachments(sessionId: string): Promise<Array<{ id: string; sessionId: string; filename: string; safeName: string; mime: string; size: number; hash?: string; createdAt: string }>>;
  putApproval(value: { id: string; sessionId: string; taskId?: string; action: string; state: string; context: Record<string, unknown>; createdAt: string; resolvedAt?: string }): Promise<void>;
  putChangeSet(value: ChangeSet): Promise<void>;
  listChangeSets(sessionId: string): Promise<ChangeSet[]>;
  getChangeSet(id: string): Promise<ChangeSet | null>;
  getEngineSession(sessionId: string): Promise<string | null>;
  putEngineSession(sessionId: string, engineSessionId: string): Promise<void>;
}

type Sql = NeonQueryFunction<false, false>;

const migrations = [
  `CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, github_login text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS github_connections (installation_id bigint PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), github_login text NOT NULL, access_token text NOT NULL, refresh_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), installation_id bigint NOT NULL, repository_id bigint NOT NULL, full_name text NOT NULL, default_branch text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, repository_id))`,
  `CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id), installation_id bigint, project text NOT NULL, owner text, branch text NOT NULL, mode text NOT NULL, workspace_id text, checkpoint jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role text NOT NULL, text text NOT NULL, created_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, workspace_id text NOT NULL, run_id text, state text NOT NULL, prompt text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id), provider text NOT NULL, codespace_name text, repository_id bigint NOT NULL, branch text NOT NULL, state text NOT NULL, bridge_state text NOT NULL, opencode_state text NOT NULL, connection_id text, repo_root text, failure_code text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS event_sequences (session_id text PRIMARY KEY, sequence bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS task_events (event_id text PRIMARY KEY, sequence bigint NOT NULL, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, task_id text, run_id text, workspace_id text, type text NOT NULL, payload jsonb NOT NULL, timestamp timestamptz NOT NULL, UNIQUE(session_id, sequence))`,
  `CREATE INDEX IF NOT EXISTS task_events_replay_idx ON task_events(session_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS provider_connections (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), provider text NOT NULL, credential text, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS approvals (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, task_id text, action text NOT NULL, state text NOT NULL, context jsonb NOT NULL, created_at timestamptz NOT NULL, resolved_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS attachments (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, filename text NOT NULL, safe_name text NOT NULL, mime text NOT NULL, size bigint NOT NULL, hash text, blob_url text, created_at timestamptz NOT NULL)`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content_base64 text`,
  `CREATE TABLE IF NOT EXISTS bridge_commands (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, kind text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, result jsonb, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS engine_sessions (session_id text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, engine_session_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS change_sets (id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, record jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS bridge_commands_delivery_idx ON bridge_commands(workspace_id, status, created_at)`,
];

function rows<T>(value: unknown): T[] { return value as T[]; }
function iso(value: unknown): string { return new Date(String(value)).toISOString(); }

function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id), sessionId: String(row.session_id), userId: String(row.user_id), projectId: String(row.project_id),
    provider: 'github-codespaces', codespaceName: row.codespace_name ? String(row.codespace_name) : undefined,
    repositoryId: Number(row.repository_id), branch: String(row.branch), state: row.state as WorkspaceRecord['state'],
    bridgeState: row.bridge_state as WorkspaceRecord['bridgeState'], openCodeState: row.opencode_state as WorkspaceRecord['openCodeState'],
    connectionId: row.connection_id ? String(row.connection_id) : undefined, repoRoot: row.repo_root ? String(row.repo_root) : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  private ready?: Promise<void>;
  constructor(private readonly sql: Sql) {}
  initialize(): Promise<void> {
    this.ready ||= (async () => { for (const statement of migrations) await this.sql.query(statement, []); })();
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
    if (!r) return null;
    return { id: String(r.id), userId: String(r.user_id), projectId: String(r.project_id), installationId: r.installation_id ? Number(r.installation_id) : undefined, project: String(r.project), owner: r.owner ? String(r.owner) : undefined, branch: String(r.branch), mode: r.mode as ProjectSession['mode'], workspaceId: r.workspace_id ? String(r.workspace_id) : null, checkpoint: (r.checkpoint || undefined) as ProjectSession['checkpoint'], createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
  }
  async putMessage(v: ChatMessage) { await this.initialize(); await this.sql`INSERT INTO messages (id,session_id,role,text,created_at) VALUES (${v.id},${v.sessionId},${v.role},${v.text},${v.createdAt}) ON CONFLICT (id) DO NOTHING`; }
  async listMessages(sessionId: string) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT * FROM messages WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => ({ id: String(r.id), sessionId: String(r.session_id), role: r.role as ChatMessage['role'], text: String(r.text), createdAt: iso(r.created_at) })); }
  async putTask(v: TaskRecord) { await this.initialize(); await this.sql`INSERT INTO tasks (id,session_id,workspace_id,run_id,state,prompt,created_at,updated_at) VALUES (${v.id},${v.sessionId},${v.workspaceId},${v.runId || null},${v.state},${v.prompt},${v.createdAt},${v.updatedAt}) ON CONFLICT (id) DO UPDATE SET run_id=EXCLUDED.run_id,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`; }
  async listTasks(sessionId: string) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT * FROM tasks WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => ({ id: String(r.id), sessionId: String(r.session_id), workspaceId: String(r.workspace_id), runId: r.run_id ? String(r.run_id) : undefined, state: r.state as TaskRecord['state'], prompt: String(r.prompt), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })); }
  async getTask(id: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM tasks WHERE id=${id}`)[0]; return r ? { id: String(r.id), sessionId: String(r.session_id), workspaceId: String(r.workspace_id), runId: r.run_id ? String(r.run_id) : undefined, state: r.state as TaskRecord['state'], prompt: String(r.prompt), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : null; }
  async putWorkspace(v: WorkspaceRecord) {
    await this.initialize();
    await this.sql`INSERT INTO workspaces (id,session_id,user_id,project_id,provider,codespace_name,repository_id,branch,state,bridge_state,opencode_state,connection_id,repo_root,failure_code,created_at,updated_at) VALUES (${v.id},${v.sessionId},${v.userId},${v.projectId},${v.provider},${v.codespaceName || null},${v.repositoryId},${v.branch},${v.state},${v.bridgeState},${v.openCodeState},${v.connectionId || null},${v.repoRoot || null},${v.failureCode || null},${v.createdAt},${v.updatedAt}) ON CONFLICT (id) DO UPDATE SET codespace_name=EXCLUDED.codespace_name,state=EXCLUDED.state,bridge_state=EXCLUDED.bridge_state,opencode_state=EXCLUDED.opencode_state,connection_id=EXCLUDED.connection_id,repo_root=EXCLUDED.repo_root,failure_code=EXCLUDED.failure_code,updated_at=EXCLUDED.updated_at`;
  }
  async getWorkspaceBySession(sessionId: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM workspaces WHERE session_id=${sessionId} ORDER BY created_at DESC LIMIT 1`)[0]; return r ? mapWorkspace(r) : null; }
  async getWorkspace(id: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM workspaces WHERE id=${id}`)[0]; return r ? mapWorkspace(r) : null; }
  async appendEvent(v: Omit<OrlynxEvent, 'sequence'>): Promise<OrlynxEvent> {
    await this.initialize();
    const seq = rows<{ sequence: string }>(await this.sql`INSERT INTO event_sequences (session_id,sequence) VALUES (${v.sessionId},1) ON CONFLICT (session_id) DO UPDATE SET sequence=event_sequences.sequence+1 RETURNING sequence`)[0];
    const event = { ...v, sequence: Number(seq.sequence) };
    await this.sql`INSERT INTO task_events (event_id,sequence,session_id,task_id,run_id,workspace_id,type,payload,timestamp) VALUES (${event.eventId},${event.sequence},${event.sessionId},${event.taskId || null},${event.runId || null},${event.workspaceId || null},${event.type},${JSON.stringify(event.payload)},${event.timestamp}) ON CONFLICT (event_id) DO NOTHING`;
    return event;
  }
  async listEvents(sessionId: string, after = 0, limit = 200) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT * FROM task_events WHERE session_id=${sessionId} AND sequence>${after} ORDER BY sequence LIMIT ${limit}`).map((r) => ({ eventId: String(r.event_id), sequence: Number(r.sequence), sessionId: String(r.session_id), taskId: r.task_id ? String(r.task_id) : undefined, runId: r.run_id ? String(r.run_id) : undefined, workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, type: r.type as OrlynxEvent['type'], payload: r.payload as Record<string, unknown>, timestamp: iso(r.timestamp) })); }
  async queueCommand(v: BridgeCommand) { await this.initialize(); await this.sql`INSERT INTO bridge_commands (id,workspace_id,kind,payload,status,result,expires_at,created_at,updated_at) VALUES (${v.id},${v.workspaceId},${v.kind},${JSON.stringify(v.payload)},${v.status},${JSON.stringify(v.result || null)},${v.expiresAt},${v.createdAt},${v.updatedAt})`; }
  async claimCommands(workspaceId: string, limit = 20) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`UPDATE bridge_commands SET status='sent',updated_at=now() WHERE id IN (SELECT id FROM bridge_commands WHERE workspace_id=${workspaceId} AND (status='queued' OR (status='sent' AND updated_at < now() - interval '15 seconds')) AND expires_at>now() ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING *`).map(mapCommand); }
  async completeCommand(id: string, status: 'completed' | 'failed', result: Record<string, unknown>) { await this.initialize(); await this.sql`UPDATE bridge_commands SET status=${status},result=${JSON.stringify(result)},updated_at=now() WHERE id=${id}`; }
  async getCommand(id: string) { await this.initialize(); const r = rows<Record<string, unknown>>(await this.sql`SELECT * FROM bridge_commands WHERE id=${id}`)[0]; return r ? mapCommand(r) : null; }
  async putAttachment(v: { id: string; sessionId: string; filename: string; safeName: string; mime: string; size: number; hash?: string; blobUrl?: string; contentBase64?: string; createdAt: string }) { await this.initialize(); await this.sql`INSERT INTO attachments (id,session_id,filename,safe_name,mime,size,hash,blob_url,content_base64,created_at) VALUES (${v.id},${v.sessionId},${v.filename},${v.safeName},${v.mime},${v.size},${v.hash || null},${v.blobUrl || null},${v.contentBase64 || null},${v.createdAt}) ON CONFLICT (id) DO NOTHING`; }
  async listAttachments(sessionId: string) { await this.initialize(); return rows<Record<string, unknown>>(await this.sql`SELECT id,session_id,filename,safe_name,mime,size,hash,created_at FROM attachments WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => ({ id: String(r.id), sessionId: String(r.session_id), filename: String(r.filename), safeName: String(r.safe_name), mime: String(r.mime), size: Number(r.size), hash: r.hash ? String(r.hash) : undefined, createdAt: iso(r.created_at) })); }
  async putApproval(v: { id: string; sessionId: string; taskId?: string; action: string; state: string; context: Record<string, unknown>; createdAt: string; resolvedAt?: string }) { await this.initialize(); await this.sql`INSERT INTO approvals (id,session_id,task_id,action,state,context,created_at,resolved_at) VALUES (${v.id},${v.sessionId},${v.taskId || null},${v.action},${v.state},${JSON.stringify(v.context)},${v.createdAt},${v.resolvedAt || null}) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,resolved_at=EXCLUDED.resolved_at`; }
  async putChangeSet(v: ChangeSet) { await this.initialize(); await this.sql`INSERT INTO change_sets (id,session_id,record,created_at) VALUES (${v.id},${v.sessionId},${JSON.stringify(v)},${v.createdAt}) ON CONFLICT (id) DO UPDATE SET record=EXCLUDED.record,updated_at=now()`; }
  async listChangeSets(sessionId: string) { await this.initialize(); return rows<{ record: ChangeSet }>(await this.sql`SELECT record FROM change_sets WHERE session_id=${sessionId} ORDER BY created_at`).map((r) => r.record); }
  async getChangeSet(id: string) { await this.initialize(); return rows<{ record: ChangeSet }>(await this.sql`SELECT record FROM change_sets WHERE id=${id}`)[0]?.record || null; }
  async getEngineSession(sessionId: string) { await this.initialize(); const r = rows<{ engine_session_id: string }>(await this.sql`SELECT engine_session_id FROM engine_sessions WHERE session_id=${sessionId}`)[0]; return r?.engine_session_id || null; }
  async putEngineSession(sessionId: string, engineSessionId: string) { await this.initialize(); await this.sql`INSERT INTO engine_sessions (session_id,engine_session_id) VALUES (${sessionId},${engineSessionId}) ON CONFLICT (session_id) DO UPDATE SET engine_session_id=EXCLUDED.engine_session_id,updated_at=now()`; }
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
