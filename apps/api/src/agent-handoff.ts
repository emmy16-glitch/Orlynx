import { randomUUID } from 'node:crypto';
import type { AgentHandoffCheckpoint, OrlynxEvent, TaskRecord } from '@orlynx/shared';
import { controlPlaneRepository } from './storage.js';
import { getAgentAdapter, listAgentAdapters } from './agent-runtime.js';
import { adapterEligible, compatibleCapabilities, taskCapabilities } from './adapter-policy.js';
import { bridgeRequest } from './bridge-rpc.js';
import { emitPersisted, redactEventString } from './events.js';

export function handoffCheckpoint(task: TaskRecord, repository: AgentHandoffCheckpoint['repository'], provider: string,
  files: Array<{ path: string; action: string }>, events: OrlynxEvent[], reason: AgentHandoffCheckpoint['reasonForHandoff']): AgentHandoffCheckpoint {
  const harness = task.harness;
  const bounded = (value: string) => redactEventString(value).slice(0, 2000);
  return { version: 1, taskId: task.id, conversationId: task.sessionId, investigationId: harness?.investigation?.id,
    objective: bounded(task.prompt), completedWork: (harness?.planItems || []).filter(x => x.status === 'completed').map(x => bounded(x.content)),
    pendingWork: [...(harness?.planItems || []).filter(x => x.status !== 'completed' && x.status !== 'cancelled').map(x => bounded(x.content)), ...(harness?.inbox || []).filter(item=>!item.appliedAt).map(item=>bounded(`User update: ${item.text}`))].slice(-40),
    currentHypothesis: harness?.investigation?.hypothesis ? bounded(harness.investigation.hypothesis) : undefined, evidence: (harness?.investigation?.evidence || []).map(bounded).slice(-30),
    nextCheck: harness?.investigation?.nextCheck ? bounded(harness.investigation.nextCheck) : undefined, repairActions: harness?.investigation?.repairAction ? [bounded(harness.investigation.repairAction)] : [],
    changedFiles: files.slice(0, 200), commandsExecuted: events.filter(e => ['tool.completed', 'tool.failed', 'terminal.exited', 'test.result', 'build.result'].includes(e.type))
      .slice(-40).map(e => ({ eventId: e.eventId, tool: String(e.payload.tool || ''), status: String(e.payload.status || e.type), summary: bounded(String(e.payload.summary || e.payload.title || '')) })),
    verification: harness?.verification, repository, workspace: { id: task.workspaceId, provider },
    constraints: ['Preserve existing edits. Reinspect the workspace before modifying it.', 'GitHub publication belongs exclusively to the Orlynx control plane.', 'Verify current repository state; old test results are historical evidence.'],
    memoryRefs: harness?.lessonsApplied || [], previousAdapter: task.adapterId || 'opencode', reasonForHandoff: reason, createdAt: new Date().toISOString() };
}

export async function failoverCandidate(task: TaskRecord): Promise<string | undefined> {
  const states = await controlPlaneRepository().listWorkspaceAgentAdapters(task.workspaceId);
  const attempted = new Set([task.adapterId || 'opencode', ...(task.harness?.adapterAttempts || [])]);
  return listAgentAdapters().find(adapter => !attempted.has(adapter.id)
    && compatibleCapabilities(adapter.capabilities, taskCapabilities(task))
    && (!adapter.supportsModel || adapter.supportsModel(task.modelId || ''))
    && adapterEligible(states.find(s => s.adapterId === adapter.id))
    && (!states.find(s => s.adapterId === adapter.id)?.supportedModels || states.find(s => s.adapterId === adapter.id)!.supportedModels!.includes(task.modelId || '')))?.id;
}

/** Persist intent before stopping the old writer. Fail closed on uncertain effects.
 * No new task, run, workspace, branch, or Investigation is allocated here. */
export async function switchTaskAdapter(taskId: string, target: string, reason: AgentHandoffCheckpoint['reasonForHandoff'] = 'manual-switch'): Promise<TaskRecord> {
  const repository = controlPlaneRepository();
  const initial = await repository.getTask(taskId);
  if (!initial) throw new Error('Task not found.');
  const adapter = getAgentAdapter(target);
  const direct = (initial.plane || 'workspace') === 'direct';
  const destination = direct ? await repository.getWorkspaceBySession(initial.sessionId) : undefined;
  if (direct && !destination) throw new Error('The selected adapter needs a prepared controlled workspace. Your direct task is preserved.');
  const workspaceId = destination?.id || initial.workspaceId;
  if (!compatibleCapabilities(adapter.capabilities, taskCapabilities(initial))) throw new Error(`${adapter.displayName} cannot satisfy this task's required capabilities.`);
  if (adapter.supportsModel && !adapter.supportsModel(initial.modelId || '')) throw new Error(`${adapter.displayName} cannot use the selected model. Select a compatible model explicitly.`);
  const state = await repository.getWorkspaceAgentAdapter(workspaceId, target);
  if (state?.supportedModels && !state.supportedModels.includes(initial.modelId || '')) throw new Error(`${adapter.displayName} does not have the selected model configured in this workspace.`);
  if (!adapterEligible(state || undefined)) throw new Error(`${adapter.displayName} is not healthy and configured in this workspace${state?.reason ? `: ${state.reason}` : '.'}`);
  const owner = randomUUID();
  const generation = await repository.claimAdapterTransition(workspaceId, owner);
  if (generation === null) throw new Error('Another adapter transition holds the workspace lease.');
  try {
    if (direct) {
      const { pauseDirectTaskForSwitch } = await import('./agents.js');
      await pauseDirectTaskForSwitch(initial);
      const stopped = await repository.getTask(taskId);
      if (!stopped || !['queued','running','waiting_input'].includes(stopped.state)) throw new Error('The direct task finished before the switch.');
      stopped.plane='workspace'; stopped.workspaceId=workspaceId;
      if (stopped.harness) stopped.harness.phase='routing';
      await repository.putTask(stopped);
    }
    const task = await repository.getTask(taskId);
    if (!task || !['queued','running','waiting_input'].includes(task.state)) throw new Error('Task is no longer switchable.');
    if (!task.harness) throw new Error('Task has no durable harness checkpoint.');
    if (['verifying','finalizing','completed'].includes(task.harness.phase)) throw new Error('Verification/publication must reconcile before an adapter can switch.');
    const session = await repository.getSession(task.sessionId);
    const workspace = await repository.getWorkspace(task.workspaceId);
    if (!session || !workspace || session.userId !== workspace.userId || session.projectId !== workspace.projectId || workspace.sessionId !== task.sessionId) throw new Error('Workspace ownership mismatch.');
    task.harness.adapterTransition = { target, reason, startedAt: new Date().toISOString() };
    task.harness.executionGeneration = generation;
    if (!await repository.beginAdapterTransition(task.id, target, reason, generation)) throw new Error('The task entered verification/publication before switching could begin.');
    await emitPersisted(task.sessionId, 'activity.progress', { taskId, sourceType: 'adapter.failover.started', text: `Saving the task and switching to ${adapter.displayName}…`, adapterId: target }, task.runId);
    const reconciled = await bridgeRequest(task.workspaceId, 'agent.reconcile', { taskId, executionGeneration: generation, workspaceBaseHead: task.harness.workspaceBaseHead }, 20_000) as Record<string, unknown>;
    if (reconciled.reconciled !== true) throw new Error('workspace_conflict: previous writer was not reconciled.');
    if (String(reconciled.branch) !== session.branch) throw new Error('workspace_conflict: branch changed during execution.');
    const files = Array.isArray(reconciled.files) ? reconciled.files as Array<Record<string, unknown>> : [];
    const events = task.runId ? await repository.listRunEvents(task.sessionId, task.runId, 1000) : [];
    task.harness.agentHandoff = handoffCheckpoint(task, { repo: session.project, branch: session.branch, headSha: String(reconciled.head || ''), dirtyState: reconciled.dirtyState === true }, workspace.provider,
      files.map(f => ({ path: String(f.path || f.file), action: String(f.status || 'modify') })), events, reason);
    task.harness.adapterAttempts = [...new Set([...(task.harness.adapterAttempts || []), task.adapterId || 'opencode'])];
    task.harness.verification = { ...task.harness.verification, status: 'pending', satisfied: [], missing: [...task.harness.verification.required] };
    task.harness.verifiedWorkspaceHead = undefined;
    task.harness.verifiedWorkspaceFingerprint = undefined;
    task.harness.modelReviewCompletedAt = undefined;
    task.harness.modelReviewAttempts = 0;
    task.harness.phase = 'routing';
    task.harness.adapterTransition = undefined;
    task.adapterId = target; task.state = 'queued'; task.updatedAt = new Date().toISOString();
    await repository.putTask(task);
    const saved = await repository.getTask(task.id);
    if (saved?.harness?.executionGeneration !== generation || saved.adapterId !== target) throw new Error('workspace_conflict: a newer transition superseded this handoff.');
    await emitPersisted(task.sessionId, 'activity.progress', { taskId, sourceType: 'handoff.created', text: `Checkpoint saved. ${adapter.displayName} will continue the same task.`, adapterId: target, executionGeneration: generation, investigationId: task.harness.investigation?.id }, task.runId);
    return task;
  } catch (error) {
    const task = await repository.getTask(taskId);
    if (task?.harness?.adapterTransition) {
      task.state = 'waiting_input';
      task.updatedAt = new Date().toISOString();
      if (task.harness.investigation) task.harness.investigation = { ...task.harness.investigation, stage: 'blocked', outcome: 'Prior execution could not be safely reconciled.', updatedAt: task.updatedAt };
      await repository.putTask(task);
      await emitPersisted(task.sessionId, 'run.state', { taskId, state: 'waiting_input', recoverable: true,
        message: 'Agent switching is paused because the previous execution could not be safely reconciled. Your task and workspace edits are preserved.' }, task.runId);
    }
    throw error;
  } finally { await repository.releaseAdapterTransition(workspaceId, owner); }
}

export async function resolvePreferredAdapter(preference: string, sessionId: string, modelId: string, mode: TaskRecord['mode'], permission: TaskRecord['permission']): Promise<string> {
  if (preference !== 'auto') return getAgentAdapter(preference).id;
  const repository = controlPlaneRepository();
  const workspace = await repository.getWorkspaceBySession(sessionId);
  if (!workspace) return 'opencode'; // Preserve the existing direct/compute startup lane.
  const states = await repository.listWorkspaceAgentAdapters(workspace.id);
  const required = taskCapabilities({ mode, permission });
  const candidate = listAgentAdapters().find(adapter => compatibleCapabilities(adapter.capabilities, required)
    && (!adapter.supportsModel || adapter.supportsModel(modelId))
    && states.some(state => state.adapterId === adapter.id && adapterEligible(state) && (!state.supportedModels || state.supportedModels.includes(modelId))));
  if (!candidate) throw new Error('No healthy compatible agent is available for the selected model in this workspace.');
  return candidate.id;
}
