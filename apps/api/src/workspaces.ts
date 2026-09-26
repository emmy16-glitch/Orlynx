import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { WorkspaceRecord } from '@orlynx/shared';
import { createBridgeToken } from './bridge-auth.js';
import { bridgeRuntimeRevision } from './runtime-worker.js';
import { defaultWorkspaceProviderId, providerForWorkspace, runnerFallbackEnabled } from './workspace-providers.js';
import { controlPlaneRepository } from './storage.js';
import { emit } from './events.js';

type PreparationContext = { allowFallback: boolean; promise: Promise<WorkspaceRecord> };
const activePreparations = new Map<string, PreparationContext>();

export function workspaceNeedsSshRebuild(failureCode?: string): boolean {
  return /ssh server|error getting ssh server details|Codespace SSH did not become ready/i.test(failureCode || '');
}

export function workspaceNeedsCodespaceReplacement(failureCode?: string): boolean {
  const detail = failureCode || '';
  return workspaceNeedsSshRebuild(detail)
    || /getting full codespace details[\s\S]*404|GitHub Codespaces request failed \(HTTP 404|api\.github\.com\/user\/codespaces\//i.test(detail);
}

export function workspaceConnectionMatchesRevision(connectionId: string | undefined, revision: string): boolean {
  return Boolean(connectionId?.startsWith(`bridge-${revision}-`));
}

export function workspaceNeedsRuntimeRefresh(workspace: Pick<WorkspaceRecord, 'connectionId' | 'state' | 'bridgeState'>): boolean {
  if (workspace.state !== 'ready' || workspace.bridgeState !== 'ready') return false;
  return !workspaceConnectionMatchesRevision(workspace.connectionId, bridgeRuntimeRevision());
}

export function workspaceFullyReady(workspace: Pick<WorkspaceRecord, 'state' | 'bridgeState'>): boolean {
  return workspace.state === 'ready' && workspace.bridgeState === 'ready';
}

export function workspaceStartupPending(workspace: Pick<WorkspaceRecord, 'state' | 'bridgeState'>): boolean {
  if (workspaceFullyReady(workspace) || workspace.state === 'failed' || workspace.state === 'stopped' || workspace.state === 'stopping') return false;
  return ['creating', 'starting', 'bootstrapping', 'connecting'].includes(workspace.state) || workspace.bridgeState === 'connecting';
}

export function shouldRecoverTransientBridgeClose(authenticated: boolean, code: number): boolean {
  return authenticated && [1001, 1006, 1012].includes(code);
}

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
    provider: defaultWorkspaceProviderId(),
    repositoryId: input.repositoryId,
    branch: input.branch,
    state: 'creating',
    bridgeState: 'disconnected',
    createdAt: now,
    updatedAt: now,
  };
  await repository.putWorkspace(workspace);
  await repository.putWorkspaceAgentAdapter({ workspaceId: workspace.id, adapterId: 'opencode', state: 'not_installed', updatedAt: now });
  return workspace;
}

export async function prepareWorkspace(
  input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string },
  options: { allowFallback?: boolean } = {},
): Promise<WorkspaceRecord> {
  const running = activePreparations.get(input.sessionId);
  if (running) {
    if (options.allowFallback !== false) running.allowFallback = true;
    return running.promise;
  }
  const context = { allowFallback: options.allowFallback !== false, promise: Promise.resolve(null as unknown as WorkspaceRecord) };
  context.promise = prepareWorkspaceOnce(input, 0, context).finally(() => activePreparations.delete(input.sessionId));
  activePreparations.set(input.sessionId, context);
  return context.promise;
}

async function prepareWorkspaceOnce(
  input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string },
  replacementDepth = 0,
  context: { allowFallback: boolean } = { allowFallback: true },
): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  let workspace = await ensureWorkspaceRecord(input);
  let provider = providerForWorkspace(workspace);
  const hasProviderHandle = (value: WorkspaceRecord) => value.provider === 'orlynx-runner' ? Boolean(value.runnerId) : Boolean(value.codespaceName);
  let refreshFallback: WorkspaceRecord | null = null;
  let refreshAdapterFallback: Awaited<ReturnType<typeof repository.listWorkspaceAgentAdapters>> = [];
  try {
    if (workspace.state === 'creating' && !hasProviderHandle(workspace)) {
      emit(input.sessionId, 'workspace.preparing', { stage: 'workspace.create', provider: workspace.provider, message: workspace.provider === 'orlynx-runner' ? 'Preparing a fast Orlynx workspace…' : 'Starting a development environment on GitHub…' });
      workspace = await provider.create({ workspaceId: workspace.id, sessionId: input.sessionId, userId: input.userId, projectId: input.projectId, repositoryId: input.repositoryId, branch: input.branch });
      await repository.putWorkspace(workspace);
    } else if (workspace.state === 'failed') {
      // A failed workspace is retryable. This matters after the user approves
      // a newly requested GitHub Codespaces permission or after a transient
      // bootstrap failure.
      const previousFailure = workspace.failureCode || '';
      if (workspace.provider === 'github-codespaces' && workspace.codespaceName && workspaceNeedsCodespaceReplacement(previousFailure) && provider.replace) {
        emit(input.sessionId, 'workspace.preparing', {
          stage: 'codespace.replace',
          message: 'Replacing the broken development environment with a fresh Codespace…',
        });
        workspace = await provider.replace({
          workspaceId: workspace.id,
          sessionId: input.sessionId,
          userId: input.userId,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          branch: input.branch,
        }, workspace);
        await repository.putWorkspace(workspace);
      } else {
        workspace = { ...workspace, state: hasProviderHandle(workspace) ? 'starting' : 'creating', bridgeState: 'disconnected', connectionId: undefined, failureCode: undefined, updatedAt: new Date().toISOString() };
        await repository.putWorkspace(workspace);
        workspace = hasProviderHandle(workspace)
          ? await provider.get(workspace)
          : await provider.create({ workspaceId: workspace.id, sessionId: input.sessionId, userId: input.userId, projectId: input.projectId, repositoryId: input.repositoryId, branch: input.branch });
        await repository.putWorkspace(workspace);
      }
    }
    if (workspace.state === 'stopped') {
      emit(input.sessionId, 'workspace.preparing', { stage: 'workspace.start', provider: workspace.provider, message: workspace.provider === 'orlynx-runner' ? 'Waking the Orlynx workspace…' : 'Waking the existing GitHub Codespace…' });
      workspace = { ...(await provider.start(workspace)), state: 'starting' };
      await repository.putWorkspace(workspace);
    }

    // A bridge bundle can change while a Codespace remains alive for hours.
    // Encode the current bundle fingerprint in connectionId so the next Build
    // request can refresh only the private Orlynx bridge, without rebuilding
    // the Codespace or touching repository files.
    const bridgePrefix = `bridge-${bridgeRuntimeRevision()}-`;
    if (workspaceNeedsRuntimeRefresh(workspace)) {
      refreshFallback = workspace;
      refreshAdapterFallback = await repository.listWorkspaceAgentAdapters(workspace.id);
      emit(input.sessionId, 'workspace.preparing', {
        stage: 'agent.refresh',
        message: 'Updating the Orlynx workspace runtime…',
      });
      workspace = {
        ...workspace,
        state: 'connecting',
        bridgeState: 'disconnected',
        connectionId: undefined,
        updatedAt: new Date().toISOString(),
      };
      await repository.putWorkspace(workspace);
      await repository.putWorkspaceAgentAdapter({ workspaceId: workspace.id, adapterId: 'opencode', state: 'unavailable', reason: 'workspace_runtime_refresh', updatedAt: workspace.updatedAt });
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
        connectionId: undefined,
        updatedAt: new Date().toISOString(),
      };
      await repository.putWorkspace(workspace);
      await repository.putWorkspaceAgentAdapter({ workspaceId: workspace.id, adapterId: 'opencode', state: 'unavailable', reason: 'bridge_reconnecting', updatedAt: workspace.updatedAt });
    }

    if (['creating', 'starting'].includes(workspace.state)) {
      emit(input.sessionId, 'workspace.preparing', { stage: 'workspace.wait', provider: workspace.provider, message: workspace.provider === 'orlynx-runner' ? 'Preparing the Orlynx workspace…' : 'Waiting for GitHub to finish starting the Codespace…' });
      const readyTimeout = workspace.provider === 'orlynx-runner'
        ? Math.max(15_000, Number(process.env.ORLYNX_RUNNER_READY_TIMEOUT_MS || 60_000))
        : Math.max(90_000, Number(process.env.ORLYNX_CODESPACE_READY_TIMEOUT_MS || 4 * 60_000));
      const deadline = Date.now() + readyTimeout;
      let lastState = workspace.state;
      let lastProgressAt = 0;
      while (Date.now() < deadline) {
        try {
          workspace = await provider.get(workspace);
          await repository.putWorkspace(workspace);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const fatal = /HTTP\s+(?:401|403|404)|permission|forbidden|not found/i.test(detail);
          if (fatal) throw error;
          if (Date.now() - lastProgressAt > 15_000) {
            lastProgressAt = Date.now();
            emit(input.sessionId, 'workspace.preparing', {
              stage: 'workspace.wait',
              state: workspace.state,
              message: workspace.provider === 'orlynx-runner' ? 'Runner status is temporarily unavailable. Orlynx is still preparing the workspace.' : 'GitHub status is temporarily unavailable. Orlynx is still waiting for the development environment.',
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }

        if (workspace.state !== lastState) {
          lastState = workspace.state;
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'workspace.state',
            state: workspace.state,
            message: workspace.state === 'connecting'
              ? (workspace.provider === 'orlynx-runner' ? 'Runner is ready. Connecting Orlynx…' : 'Codespace is online. Connecting Orlynx…')
              : workspace.state === 'failed'
                ? (workspace.provider === 'orlynx-runner' ? 'The Orlynx runner could not prepare the workspace.' : 'GitHub could not start the Codespace.')
                : (workspace.provider === 'orlynx-runner' ? 'Orlynx is preparing the runner…' : 'GitHub is preparing the Codespace…'),
          });
        }
        if (workspace.state === 'connecting' || workspace.state === 'failed') break;
        if (Date.now() - lastProgressAt > 15_000) {
          lastProgressAt = Date.now();
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'workspace.wait',
            state: workspace.state,
            message: workspace.provider === 'orlynx-runner' ? 'The runner is still preparing. Your task is saved and will start automatically.' : 'GitHub is still preparing the development environment. Your task is saved and Orlynx will continue automatically.',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      if (['creating', 'starting'].includes(workspace.state)) {
        throw new Error(workspace.provider === 'orlynx-runner' ? 'Orlynx runner did not become ready before the startup timeout.' : 'GitHub Codespace did not become ready before the startup timeout.');
      }
    }
    const connectionAge = Date.now() - Date.parse(workspace.updatedAt);
    const staleBridge = Boolean(workspace.connectionId && workspace.bridgeState === 'disconnected' && connectionAge > 30_000);
    if (workspace.state === 'connecting' && workspace.bridgeState !== 'ready' && (!workspace.connectionId || staleBridge)) {
      const connectionId = `${bridgePrefix}${uuid()}`;
      workspace = { ...workspace, state: 'bootstrapping', bridgeState: 'connecting', connectionId, updatedAt: new Date().toISOString() };
      await repository.putWorkspace(workspace);
      await repository.putWorkspaceAgentAdapter({ workspaceId: workspace.id, adapterId: 'opencode', state: 'installing', updatedAt: workspace.updatedAt });
      const bridgeToken = createBridgeToken({ workspaceId: workspace.id, sessionId: workspace.sessionId, userId: workspace.userId, connectionId }, 600);
      emit(input.sessionId, 'workspace.preparing', { stage: 'agent.connect', message: 'Connecting Orlynx to the development environment…' });
      console.info(`[workspace] connecting runtime session=${workspace.sessionId} workspace=${workspace.id} provider=${workspace.provider}`);
      if (!provider.connect) throw new Error(`Workspace provider ${workspace.provider} cannot connect the Orlynx runtime.`);
      await provider.connect(workspace, { bridgeToken, connectionId, openCodePassword: crypto.randomBytes(32).toString('base64url') });
      console.info(`[workspace] runtime connect completed session=${workspace.sessionId} workspace=${workspace.id} provider=${workspace.provider}`);
      // The bridge can report READY before bootstrap returns. Read its state;
      // a post-bootstrap write would overwrite that newer READY transition.
      workspace = (await repository.getWorkspace(workspace.id)) || workspace;
    }
    let finalWorkspace = (await repository.getWorkspace(workspace.id)) || workspace;
    if (workspaceStartupPending(finalWorkspace)) {
      const bridgeDeadline = Date.now() + Math.max(30_000, Number(process.env.ORLYNX_BRIDGE_READY_TIMEOUT_MS || 60_000));
      let lastReadyProgressAt = 0;
      while (Date.now() < bridgeDeadline) {
        if (workspaceFullyReady(finalWorkspace) || finalWorkspace.state === 'failed') break;
        if (Date.now() - lastReadyProgressAt > 10_000) {
          lastReadyProgressAt = Date.now();
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'agent.ready',
            state: finalWorkspace.state,
            message: finalWorkspace.bridgeState === 'ready'
              ? 'Development environment connected. Preparing agent adapters…'
              : 'Connecting Orlynx to the development environment…',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        finalWorkspace = (await repository.getWorkspace(workspace.id)) || finalWorkspace;
      }
    }
    if (workspaceFullyReady(finalWorkspace)) {
      emit(input.sessionId, 'workspace.ready', { workspaceId: finalWorkspace.id, message: 'Development environment ready.' });
      return finalWorkspace;
    }
    if (finalWorkspace.state === 'failed') {
      throw new Error(finalWorkspace.failureCode || 'The development environment failed to start.');
    }
    throw new Error('Orlynx could not connect to the development environment after the workspace started.');
  } catch (error) {
    if (workspace) {
      const detail = error instanceof Error ? error.message : 'workspace_start_failed';

      // A bridge refresh is best-effort while a previously authenticated
      // workspace is still healthy. If gh codespace ssh cannot see the
      // Codespace but the REST API still can, restore the proven-good bridge
      // instead of turning a refresh problem into a workspace outage.
      if (workspace.provider === 'github-codespaces' && refreshFallback && workspaceNeedsCodespaceReplacement(detail)) {
        try {
          const verified = await provider.get(refreshFallback);
          if (workspaceFullyReady(verified)) {
            const restored = { ...refreshFallback, updatedAt: new Date().toISOString() };
            await repository.putWorkspace(restored);
            for (const adapter of refreshAdapterFallback) {
              await repository.putWorkspaceAgentAdapter({ ...adapter, updatedAt: restored.updatedAt });
            }
            console.warn(`[workspace] runtime refresh deferred after Codespace lookup/SSH mismatch session=${restored.sessionId} codespace=${restored.codespaceName || 'unknown'}`);
            emit(input.sessionId, 'workspace.ready', {
              workspaceId: restored.id,
              message: 'Development environment ready. Runtime refresh will retry later.',
            });
            return restored;
          }
        } catch {
          // The persisted Codespace name is genuinely stale or no longer
          // visible. Fall through to replacement recovery below.
        }

        try {
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'codespace.replace',
            message: 'The previous Codespace is no longer available. Starting a fresh development environment…',
          });
          if (!provider.replace) throw new Error('Workspace provider cannot replace this environment.');
          const replacement = await provider.replace({
            workspaceId: workspace.id,
            sessionId: input.sessionId,
            userId: input.userId,
            projectId: input.projectId,
            repositoryId: input.repositoryId,
            branch: input.branch,
          }, refreshFallback);
          await repository.putWorkspace(replacement);
          console.warn(`[workspace] replaced stale Codespace after refresh 404 session=${input.sessionId} old=${refreshFallback.codespaceName || 'unknown'} new=${replacement.codespaceName || 'unknown'}`);
          return prepareWorkspaceOnce(input, replacementDepth, context);
        } catch (replacementError) {
          console.warn(`[workspace] stale Codespace replacement failed session=${input.sessionId}: ${replacementError instanceof Error ? replacementError.message : 'unknown error'}`);
        }
      }

      if (workspace.provider === 'github-codespaces' && !refreshFallback && workspace.codespaceName && workspaceNeedsCodespaceReplacement(detail) && replacementDepth < 1 && provider.replace) {
        try {
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'codespace.replace',
            message: 'The development environment could not establish SSH. Replacing it with a fresh Codespace…',
          });
          const brokenName = workspace.codespaceName;
          const replacement = await provider.replace({
            workspaceId: workspace.id,
            sessionId: input.sessionId,
            userId: input.userId,
            projectId: input.projectId,
            repositoryId: input.repositoryId,
            branch: input.branch,
          }, workspace);
          await repository.putWorkspace(replacement);
          await repository.putWorkspaceAgentAdapter({
            workspaceId: workspace.id,
            adapterId: 'opencode',
            state: 'not_installed',
            updatedAt: replacement.updatedAt,
          });
          console.warn(`[workspace] replaced broken Codespace after SSH failure session=${input.sessionId} old=${brokenName} new=${replacement.codespaceName || 'unknown'}`);
          return prepareWorkspaceOnce(input, replacementDepth + 1, context);
        } catch (replacementError) {
          console.warn(`[workspace] automatic Codespace replacement failed session=${input.sessionId}: ${replacementError instanceof Error ? replacementError.message : 'unknown error'}`);
        }
      }

      if (workspace.provider === 'orlynx-runner' && runnerFallbackEnabled() && context.allowFallback) {
        console.warn(`[workspace] warm runner failed; falling back to Codespaces session=${input.sessionId}: ${detail}`);
        await provider.destroy(workspace).catch(() => {});
        const now = new Date().toISOString();
        workspace = {
          ...workspace,
          provider: 'github-codespaces',
          runnerId: undefined,
          codespaceName: undefined,
          state: 'creating',
          bridgeState: 'disconnected',
          connectionId: undefined,
          failureCode: undefined,
          updatedAt: now,
        };
        provider = providerForWorkspace(workspace);
        await repository.putWorkspace(workspace);
        await repository.putWorkspaceAgentAdapter({ workspaceId: workspace.id, adapterId: 'opencode', state: 'not_installed', updatedAt: now });
        emit(input.sessionId, 'workspace.preparing', {
          stage: 'workspace.fallback',
          provider: 'github-codespaces',
          message: 'Fast runner unavailable. Falling back to GitHub Codespaces automatically…',
        });
        return prepareWorkspaceOnce(input, replacementDepth, context);
      }

      // READY can race the final bootstrap read by a few seconds. Re-read the
      // durable row before persisting failure so a healthy late READY signal is
      // never overwritten by stale in-memory bootstrap state.
      const current = (await repository.getWorkspace(workspace.id)) || workspace;
      if (workspaceFullyReady(current)) {
        console.info(`[workspace] recovered late-ready race session=${current.sessionId} workspace=${current.id}`);
        emit(input.sessionId, 'workspace.ready', { workspaceId: current.id, message: 'Development environment ready.' });
        return current;
      }
      workspace = { ...current, state: 'failed', bridgeState: 'disconnected', failureCode: error instanceof Error ? error.message.slice(0, 160) : 'workspace_start_failed', updatedAt: new Date().toISOString() };
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
  const stopped = await providerForWorkspace(stopping).stop(stopping);
  await repository.putWorkspace(stopped);
  return stopped;
}
