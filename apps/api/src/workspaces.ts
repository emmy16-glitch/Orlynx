import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { WorkspaceRecord } from '@orlynx/shared';
import { createBridgeToken } from './bridge-auth.js';
import { GitHubCodespacesProvider } from './github-codespaces.js';
import { bootstrapWorkspace } from './runtime-worker.js';
import { controlPlaneRepository } from './storage.js';
import { emit } from './events.js';

const provider = new GitHubCodespacesProvider();
const activePreparations = new Map<string, Promise<WorkspaceRecord>>();

export async function getWorkspace(sessionId: string): Promise<WorkspaceRecord | null> {
  return controlPlaneRepository().getWorkspaceBySession(sessionId);
}

export async function ensureWorkspaceRecord(input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string }): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  const existing = await repository.getWorkspaceBySession(input.sessionId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const workspace: WorkspaceRecord = {
    id: `ws_${uuid()}`,
    sessionId: input.sessionId,
    userId: input.userId,
    projectId: input.projectId,
    provider: 'github-codespaces',
    repositoryId: input.repositoryId,
    branch: input.branch,
    state: 'creating',
    bridgeState: 'disconnected',
    openCodeState: 'not_installed',
    createdAt: now,
    updatedAt: now,
  };
  await repository.putWorkspace(workspace);
  return workspace;
}

export async function prepareWorkspace(input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string }): Promise<WorkspaceRecord> {
  const running = activePreparations.get(input.sessionId);
  if (running) return running;
  const preparation = prepareWorkspaceOnce(input).finally(() => activePreparations.delete(input.sessionId));
  activePreparations.set(input.sessionId, preparation);
  return preparation;
}

async function prepareWorkspaceOnce(input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string }): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  let workspace = await ensureWorkspaceRecord(input);
  try {
    if (workspace.state === 'creating' && !workspace.codespaceName) {
      emit(input.sessionId, 'workspace.preparing', { stage: 'codespace.create', message: 'Starting a development environment on GitHub…' });
      workspace = await provider.create({ workspaceId: workspace.id, sessionId: input.sessionId, userId: input.userId, projectId: input.projectId, repositoryId: input.repositoryId, branch: input.branch });
      await repository.putWorkspace(workspace);
    } else if (workspace.state === 'failed') {
      // A failed workspace is retryable. This matters after the user approves
      // a newly requested GitHub Codespaces permission or after a transient
      // bootstrap failure.
      workspace = { ...workspace, state: workspace.codespaceName ? 'starting' : 'creating', bridgeState: 'disconnected', openCodeState: 'not_installed', connectionId: undefined, failureCode: undefined, updatedAt: new Date().toISOString() };
      await repository.putWorkspace(workspace);
      workspace = workspace.codespaceName
        ? await provider.get(workspace)
        : await provider.create({ workspaceId: workspace.id, sessionId: input.sessionId, userId: input.userId, projectId: input.projectId, repositoryId: input.repositoryId, branch: input.branch });
      await repository.putWorkspace(workspace);
    }
    if (workspace.state === 'stopped') {
      emit(input.sessionId, 'workspace.preparing', { stage: 'codespace.start', message: 'Waking the existing GitHub Codespace…' });
      workspace = { ...(await provider.start(workspace)), state: 'starting' };
      await repository.putWorkspace(workspace);
    }

    // A host restart or hung SSH bootstrap must not strand a session forever.
    // Once a bootstrap has been silent for long enough, safely re-enter the
    // connecting path so the existing Codespace can be bootstrapped again.
    const workspaceAge = Date.now() - Date.parse(workspace.updatedAt);
    if (workspace.state === 'bootstrapping' && workspace.bridgeState !== 'ready' && workspaceAge > 120_000) {
      console.warn(`[workspace] recovering stale bootstrap session=${workspace.sessionId} workspace=${workspace.id} ageMs=${workspaceAge}`);
      workspace = {
        ...workspace,
        state: 'connecting',
        bridgeState: 'disconnected',
        openCodeState: 'unavailable',
        connectionId: undefined,
        updatedAt: new Date().toISOString(),
      };
      await repository.putWorkspace(workspace);
    }

    if (['creating', 'starting'].includes(workspace.state)) {
      emit(input.sessionId, 'workspace.preparing', { stage: 'codespace.wait', message: 'Waiting for GitHub to finish starting the Codespace…' });
      const deadline = Date.now() + Math.max(90_000, Number(process.env.ORLYNX_CODESPACE_READY_TIMEOUT_MS || 4 * 60_000));
      let lastState = workspace.state;
      let lastProgressAt = 0;
      while (Date.now() < deadline) {
        workspace = await provider.get(workspace);
        await repository.putWorkspace(workspace);
        if (workspace.state !== lastState) {
          lastState = workspace.state;
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'codespace.state',
            state: workspace.state,
            message: workspace.state === 'connecting'
              ? 'Codespace is online. Connecting Orlynx…'
              : workspace.state === 'failed'
                ? 'GitHub could not start the Codespace.'
                : 'GitHub is preparing the Codespace…',
          });
        }
        if (workspace.state === 'connecting' || workspace.state === 'failed') break;
        if (Date.now() - lastProgressAt > 15_000) {
          lastProgressAt = Date.now();
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'codespace.wait',
            state: workspace.state,
            message: 'GitHub is still preparing the development environment. Your task is saved and Orlynx will continue automatically.',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      if (['creating', 'starting'].includes(workspace.state)) {
        throw new Error('GitHub Codespace did not become ready before the startup timeout.');
      }
    }
    const connectionAge = Date.now() - Date.parse(workspace.updatedAt);
    const staleBridge = Boolean(workspace.connectionId && workspace.bridgeState === 'disconnected' && connectionAge > 30_000);
    if (workspace.state === 'connecting' && workspace.bridgeState !== 'ready' && (!workspace.connectionId || staleBridge)) {
      const connectionId = uuid();
      workspace = { ...workspace, state: 'bootstrapping', bridgeState: 'connecting', openCodeState: 'installing', connectionId, updatedAt: new Date().toISOString() };
      await repository.putWorkspace(workspace);
      const bridgeToken = createBridgeToken({ workspaceId: workspace.id, sessionId: workspace.sessionId, userId: workspace.userId, connectionId }, 600);
      emit(input.sessionId, 'workspace.preparing', { stage: 'agent.connect', message: 'Connecting Orlynx to the development environment…' });
      console.info(`[workspace] bootstrapping session=${workspace.sessionId} workspace=${workspace.id} codespace=${workspace.codespaceName || 'unknown'}`);
      await bootstrapWorkspace(workspace, { bridgeToken, connectionId, openCodePassword: crypto.randomBytes(32).toString('base64url') });
      console.info(`[workspace] bootstrap command completed session=${workspace.sessionId} workspace=${workspace.id}`);
      // The bridge can report READY before bootstrap returns. Read its state;
      // a post-bootstrap write would overwrite that newer READY transition.
      workspace = (await repository.getWorkspace(workspace.id)) || workspace;
    }
    let finalWorkspace = (await repository.getWorkspace(workspace.id)) || workspace;
    if (finalWorkspace.state === 'bootstrapping' && finalWorkspace.bridgeState !== 'ready') {
      const bridgeDeadline = Date.now() + Math.max(10_000, Number(process.env.ORLYNX_BRIDGE_READY_TIMEOUT_MS || 30_000));
      while (Date.now() < bridgeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        finalWorkspace = (await repository.getWorkspace(workspace.id)) || finalWorkspace;
        if (finalWorkspace.state === 'ready' && finalWorkspace.bridgeState === 'ready') break;
        if (finalWorkspace.state === 'failed') break;
      }
    }
    if (finalWorkspace.state === 'ready' && finalWorkspace.bridgeState === 'ready') {
      emit(input.sessionId, 'workspace.ready', { workspaceId: finalWorkspace.id, message: 'Development environment ready.' });
      return finalWorkspace;
    }
    if (finalWorkspace.state === 'failed') {
      throw new Error(finalWorkspace.failureCode || 'The development environment failed to start.');
    }
    throw new Error('Orlynx could not connect to the development environment after the Codespace started.');
  } catch (error) {
    if (workspace) {
      workspace = { ...workspace, state: 'failed', bridgeState: 'disconnected', openCodeState: workspace.openCodeState === 'starting' ? 'failed' : workspace.openCodeState, failureCode: error instanceof Error ? error.message.slice(0, 160) : 'workspace_start_failed', updatedAt: new Date().toISOString() };
      await repository.putWorkspace(workspace);
      emit(input.sessionId, 'workspace.preparing', {
        stage: 'failed',
        state: 'failed',
        message: error instanceof Error ? error.message : 'Development environment could not start.',
      });
    }
    throw error;
  }
}

export async function markWorkspaceConnectionLost(workspaceId: string): Promise<WorkspaceRecord | null> {
  const repository = controlPlaneRepository();
  const workspace = await repository.getWorkspace(workspaceId);
  if (!workspace) return null;
  const next: WorkspaceRecord = {
    ...workspace,
    state: 'connecting',
    bridgeState: 'disconnected',
    openCodeState: 'unavailable',
    connectionId: undefined,
    updatedAt: new Date().toISOString(),
  };
  await repository.putWorkspace(next);
  return next;
}

export async function stopWorkspace(sessionId: string): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  const workspace = await repository.getWorkspaceBySession(sessionId);
  if (!workspace) throw new Error('This project does not have a cloud workspace.');
  const stopping = { ...workspace, state: 'stopping' as const, updatedAt: new Date().toISOString() };
  await repository.putWorkspace(stopping);
  const stopped = await provider.stop(stopping);
  await repository.putWorkspace(stopped);
  return stopped;
}
