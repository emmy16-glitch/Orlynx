import { assertLiveE2ESession } from './e2e-safety.js';
export const E2E_REPOSITORY = 'emmy16-glitch/Orlynx';
export function assertE2ECheckout(actual: {branch?: string; head?: string; porcelain?: string}, branch: string, head: string) {
  if (actual.branch !== branch || actual.head !== head) throw new Error('E2E checkout does not match the recorded branch and main SHA.');
  if (typeof actual.porcelain !== 'string' || actual.porcelain.trim()) throw new Error('E2E checkout must be clean before isolation.');
}
export function browserE2EPlan(now = Date.now()) {
  const branch = `orlynx-e2e/${now}`;
  assertLiveE2ESession(E2E_REPOSITORY, branch);
  return { branch, filename: `orlynx-e2e-${now}.txt`, clientId: `browser-e2e-${now}` };
}
export function verifyReplay(events: {sequence: number; eventId: string}[]) {
  if (!events.length) throw new Error('No durable events were persisted.');
  if (new Set(events.map(e => e.eventId)).size !== events.length || events.some((e,i) => !Number.isSafeInteger(e.sequence) || e.sequence <= (i ? events[i-1].sequence : 0))) throw new Error('Duplicate or out-of-order durable events.');
  return { count: events.length, lastSequence: events.at(-1)!.sequence };
}

export function browserE2EModel(value: unknown): string {
  const model = typeof value === 'string' ? value : '';
  if (!model || model.split('/').some(segment => segment === '.' || segment === '..') || !/^[\w.-]+\/[\w.:-]+(?:\/[\w.:-]+)*$/.test(model)) throw new Error('Choose an OpenCode model before running verification.');
  return model;
}

/** Create only the isolated ref, never a commit or a main/master ref. */
export async function ensureE2ERemoteBranch(project: string, branch: string, head: string, api: {
  read: () => Promise<string | null>; create: (branch: string, head: string) => Promise<string>;
}, env: NodeJS.ProcessEnv = process.env) {
  assertLiveE2ESession(project, branch, env);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Workspace HEAD is invalid.');
  const existing = await api.read();
  if (existing && existing !== head) throw new Error('E2E remote branch does not match the workspace HEAD.');
  const remote = existing || await api.create(branch, head);
  if (remote !== head) throw new Error('E2E remote ref did not preserve the workspace HEAD.');
}

export async function persistE2EIsolation(
  session: Parameters<import('./storage.js').ControlPlaneRepository['putSession']>[0],
  workspace: import('@orlynx/shared').WorkspaceRecord,
  branch: string,
  repository: Pick<import('./storage.js').ControlPlaneRepository, 'putSession' | 'setWorkspaceBranch'>,
  env: NodeJS.ProcessEnv = process.env,
) {
  assertLiveE2ESession(session.project, branch, env);
  if (workspace.sessionId !== session.id || workspace.userId !== session.userId || workspace.projectId !== session.projectId) throw new Error('E2E workspace ownership mismatch.');
  const updatedAt = new Date().toISOString();
  const isolated = { ...session, branch, updatedAt, checkpoint: { ...(session.checkpoint || { decisions: [], filesTouched: [], pendingIssues: [] }), branch, liveE2EBranch: branch, liveE2EBaseBranch: session.checkpoint?.liveE2EBaseBranch || session.branch, updatedAt } };
  if (!await repository.setWorkspaceBranch(workspace.id, session.id, session.userId, workspace.branch, branch)) throw new Error('Workspace branch changed during E2E isolation.');
  await repository.putSession(isolated);
  return isolated;
}
