import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { WorkspaceProviderId, WorkspaceRecord } from '@orlynx/shared';
import { createBridgeToken } from './bridge-auth.js';
import { bridgeRuntimeRevision } from './runtime-worker.js';
import { defaultWorkspaceProviderId, providerForWorkspace, runnerFallbackEnabled } from './workspace-providers.js';
import { controlPlaneRepository } from './storage.js';
import { emit } from './events.js';
import { computeTargetQuarantined, noteComputeFailure, noteComputeSuccess, selectWorkspaceProvider } from './compute-broker.js';
import { classifyWorkspaceFailure } from './workspace-failure.js';

type PreparationContext = { allowFallback: boolean; attemptedProviders: Set<WorkspaceProviderId>; onProviderAttempt?: (provider: WorkspaceProviderId) => Promise<void>; promise: Promise<WorkspaceRecord> };
const activePreparations = new Map<string, PreparationContext>();

async function rerouteWorkspace(workspace: WorkspaceRecord, provider: WorkspaceProviderId): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  await repository.archiveWorkspaceResource(workspace);
  const migrated: WorkspaceRecord = {
    ...workspace, provider, runnerId: undefined, runnerHostId: undefined, providerResourceId: undefined,
    codespaceName: undefined, state: 'creating', bridgeState: 'disconnected', connectionId: undefined,
    failureCode: undefined, runtimeState: 'connecting', capabilities: undefined, updatedAt: new Date().toISOString(),
  };
  await repository.putWorkspace(migrated);
  await repository.putWorkspaceAgentAdapter({ workspaceId: migrated.id, adapterId: 'opencode', state: 'not_installed', updatedAt: migrated.updatedAt });
  return migrated;
}

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

export function workspaceNeedsRuntimeRefresh(workspace: Pick<WorkspaceRecord, 'connectionId' | 'state' | 'bridgeState'> & Partial<Pick<WorkspaceRecord, 'provider'>>): boolean {
  if (workspace.state !== 'ready' || workspace.bridgeState !== 'ready') return false;
  // Codespaces receive the current bridge bundle during bootstrap. Warm runners
  // use a bridge baked into their versioned runtime image, so they are upgraded
  // by replacing/redeploying that image rather than pretending an API refresh
  // changed the already-running container.
  if (workspace.provider === 'orlynx-runner') return false;
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

export function workspaceShouldAdoptPreferredProvider(
  workspace: Pick<WorkspaceRecord, 'provider' | 'state' | 'bridgeState' | 'codespaceName' | 'failureCode'>,
  preferredProvider: WorkspaceProviderId = defaultWorkspaceProviderId(),
  adapterState?: 'not_installed' | 'installing' | 'starting' | 'ready' | 'busy' | 'unavailable' | 'failed',
): boolean {
  if (workspace.provider === preferredProvider) return false;

  // Never migrate an environment while it is provisioning, stopping, or while
  // the coding adapter is actively executing work.
  if (workspace.state === 'stopping' || workspaceStartupPending(workspace) || adapterState === 'busy') return false;

  // Idle legacy or fallback workspaces adopt the configured primary provider
  // on the next Build admission. Healthy Codespaces remain stable unless the
  // operator explicitly selected another provider.
  if (preferredProvider === 'github-codespaces') return workspace.provider !== 'github-codespaces';
  if (preferredProvider === 'e2b') return workspace.provider !== 'e2b';

  if (preferredProvider !== 'orlynx-runner') return false;
  if (workspaceFullyReady(workspace)) {
    return adapterState === 'unavailable' || adapterState === 'failed';
  }
  return true;
}

// Backward-compatible export used by existing admission/recovery callers.
export const workspaceShouldAdoptPreferredRunner = workspaceShouldAdoptPreferredProvider;

export async function getWorkspace(sessionId: string): Promise<WorkspaceRecord | null> {
  return controlPlaneRepository().getWorkspaceBySession(sessionId);
}

export async function migrateRunnerWorkspaceToCodespacesForCapability(
  workspace: WorkspaceRecord,
  capability: string,
): Promise<WorkspaceRecord> {
  if (workspace.provider !== 'orlynx-runner') return workspace;
  const repository = controlPlaneRepository();
  const runnerProvider = providerForWorkspace(workspace);
  await runnerProvider.destroy?.(workspace).catch((error) => {
    console.warn(`[workspace] browser-capability runner cleanup deferred workspace=${workspace.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
  });

  const now = new Date().toISOString();
  const migrated: WorkspaceRecord = {
    ...workspace,
    provider: 'github-codespaces',
    runnerId: undefined,
    runnerHostId: undefined,
    providerResourceId: undefined,
    codespaceName: undefined,
    state: 'creating',
    bridgeState: 'disconnected',
    connectionId: undefined,
    failureCode: undefined,
    updatedAt: now,
  };
  await repository.putWorkspace(migrated);
  await repository.putWorkspaceAgentAdapter({
    workspaceId: migrated.id,
    adapterId: 'opencode',
    state: 'not_installed',
    reason: `capability_required:${capability}`,
    updatedAt: now,
  });
  emit(workspace.sessionId, 'workspace.preparing', {
    stage: 'workspace.capability',
    provider: 'github-codespaces',
    capability,
    message: capability === 'browserE2e'
      ? 'This task needs a browser-ready runtime · switching environments automatically…'
      : `Switching environments for required capability: ${capability}…`,
  });
  console.warn(`[workspace] migrating runner workspace to Codespaces for capability session=${workspace.sessionId} workspace=${workspace.id} capability=${capability}`);
  return migrated;
}

export async function ensureWorkspaceRecord(
  input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string },
  options: { preferredProvider?: WorkspaceProviderId; taskText?: string; preserveHealthyExisting?: boolean } = {},
): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  const existing = await repository.getWorkspaceBySession(input.sessionId);
  if (existing) {
    const adapterState = await repository.getWorkspaceAgentAdapter(existing.id, 'opencode');
    if (
      options.preserveHealthyExisting
      && workspaceFullyReady(existing)
      && (adapterState?.state === 'ready' || adapterState?.state === 'busy')
    ) return existing;
    const preferredProvider = options.preferredProvider || defaultWorkspaceProviderId();
    if (!workspaceShouldAdoptPreferredProvider(existing, preferredProvider, adapterState?.state)) return existing;

    const now = new Date().toISOString();
    const migrated: WorkspaceRecord = {
      ...existing,
      provider: preferredProvider,
      runnerId: undefined,
      runnerHostId: undefined,
      providerResourceId: undefined,
      codespaceName: undefined,
      state: 'creating',
      bridgeState: 'disconnected',
      connectionId: undefined,
      failureCode: undefined,
      runtimeState: 'connecting',
      capabilities: undefined,
      updatedAt: now,
    };
    await repository.putWorkspace(migrated);
    await repository.putWorkspaceAgentAdapter({
      workspaceId: migrated.id,
      adapterId: 'opencode',
      state: 'not_installed',
      updatedAt: now,
    });
    console.info(`[workspace] migrated workspace to preferred provider session=${migrated.sessionId} workspace=${migrated.id} provider=${preferredProvider}`);
    emit(input.sessionId, 'workspace.preparing', {
      stage: 'workspace.migrate',
      provider: preferredProvider,
      message: preferredProvider === 'github-codespaces'
        ? 'Moving this project to its persistent GitHub Codespace…'
        : preferredProvider === 'e2b'
          ? 'Moving this project to an isolated E2B workspace…'
          : 'Switching to the warm Orlynx runner…',
    });
    return migrated;
  }
  const now = new Date().toISOString();
  const brokerProvider = options.preferredProvider
    || await selectWorkspaceProvider({ taskText: options.taskText }).catch(() => null)
    || defaultWorkspaceProviderId();
  const workspace: WorkspaceRecord = {
    id: `ws_${uuid()}`,
    sessionId: input.sessionId,
    userId: input.userId,
    projectId: input.projectId,
    provider: brokerProvider,
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
  options: { allowFallback?: boolean; onProviderAttempt?: (provider: WorkspaceProviderId) => Promise<void> } = {},
): Promise<WorkspaceRecord> {
  const running = activePreparations.get(input.sessionId);
  if (running) {
    if (options.allowFallback !== false) running.allowFallback = true;
    return running.promise;
  }
  const context = {
    allowFallback: options.allowFallback !== false,
    onProviderAttempt: options.onProviderAttempt,
    attemptedProviders: new Set<WorkspaceProviderId>(),
    promise: Promise.resolve(null as unknown as WorkspaceRecord),
  };
  context.promise = prepareWorkspaceOnce(input, 0, context).finally(() => activePreparations.delete(input.sessionId));
  activePreparations.set(input.sessionId, context);
  return context.promise;
}

async function prepareWorkspaceOnce(
  input: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string },
  replacementDepth = 0,
  context: PreparationContext = { allowFallback: true, attemptedProviders: new Set<WorkspaceProviderId>(), promise: Promise.resolve(null as unknown as WorkspaceRecord) },
): Promise<WorkspaceRecord> {
  const repository = controlPlaneRepository();
  const preparationStartedAt = Date.now();
  let workspace = await ensureWorkspaceRecord(input);
  if (!workspaceFullyReady(workspace) && computeTargetQuarantined(workspace.provider)) {
    context.attemptedProviders.add(workspace.provider);
    const alternate = context.allowFallback ? await selectWorkspaceProvider({ attempted: context.attemptedProviders }) : null;
    if (!alternate) throw new Error('All eligible workspace compute is temporarily quarantined. Recovery will retry within its bounded budget.');
    workspace = await rerouteWorkspace(workspace, alternate);
    emit(input.sessionId, 'workspace.preparing', { stage: 'workspace.fallback', provider: alternate, message: 'Switching compute…' });
  }
  let provider = providerForWorkspace(workspace);
  void runnerFallbackEnabled;
  context.attemptedProviders.add(workspace.provider);
  await context.onProviderAttempt?.(workspace.provider);
  const hasProviderHandle = (value: WorkspaceRecord) => value.provider === 'orlynx-runner'
    ? Boolean(value.runnerId)
    : value.provider === 'e2b'
      ? Boolean(value.providerResourceId)
      : Boolean(value.codespaceName);
  const providerLabel = (value: WorkspaceRecord['provider']) => value === 'github-codespaces' ? 'GitHub Codespace' : value === 'e2b' ? 'E2B workspace' : 'Orlynx runner';
  let refreshFallback: WorkspaceRecord | null = null;
  let refreshAdapterFallback: Awaited<ReturnType<typeof repository.listWorkspaceAgentAdapters>> = [];
  try {
    if (workspace.state === 'creating' && !hasProviderHandle(workspace)) {
      emit(input.sessionId, 'workspace.preparing', {
        stage: 'workspace.create',
        provider: workspace.provider,
        message: workspace.provider === 'github-codespaces'
          ? 'Starting Codespace…'
          : workspace.provider === 'e2b'
            ? 'Starting E2B workspace…'
            : 'Starting Orlynx workspace…',
      });
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
          message: 'Restarting with a fresh Codespace…',
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
      emit(input.sessionId, 'workspace.preparing', { stage: 'workspace.start', provider: workspace.provider, message: `Waking the existing ${providerLabel(workspace.provider)}…` });
      workspace = { ...(await provider.start(workspace)), state: 'starting' };
      await repository.putWorkspace(workspace);
    }

    // A bridge bundle can change while a Codespace remains alive for hours.
    // Encode the current bundle fingerprint in connectionId so the next Build
    // request can refresh only the private Orlynx bridge, without rebuilding
    // the Codespace or touching repository files.
    const bridgePrefix = workspace.provider === 'orlynx-runner' ? 'bridge-runner-' : `bridge-${bridgeRuntimeRevision()}-`;
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
      emit(input.sessionId, 'workspace.preparing', {
        stage: 'workspace.wait',
        provider: workspace.provider,
        message: workspace.provider === 'github-codespaces'
          ? 'Waiting for GitHub…'
          : workspace.provider === 'e2b'
            ? 'Waiting for E2B…'
            : 'Waiting for runner…',
      });
      const readyTimeout = workspace.provider === 'orlynx-runner'
        ? Math.max(15_000, Number(process.env.ORLYNX_RUNNER_READY_TIMEOUT_MS || 60_000))
        : workspace.provider === 'e2b'
          ? Math.max(30_000, Number(process.env.ORLYNX_E2B_READY_TIMEOUT_MS || 90_000))
          : Math.max(90_000, Number(process.env.ORLYNX_CODESPACE_READY_TIMEOUT_MS || 4 * 60_000));
      const deadline = Date.now() + readyTimeout;
      let lastState = workspace.state;
      let lastProgressAt = 0;
      while (Date.now() < deadline) {
        try {
          workspace = await provider.get(workspace);
          await repository.putWorkspace(workspace);
          await repository.touchWorkspaceRuntime(workspace.id, { providerHeartbeatAt: new Date().toISOString() });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const fatal = /HTTP\s+(?:401|403|404)|permission|forbidden|not found/i.test(detail);
          if (fatal) throw error;
          if (Date.now() - lastProgressAt > 15_000) {
            lastProgressAt = Date.now();
            emit(input.sessionId, 'workspace.preparing', {
              stage: 'workspace.wait',
              state: workspace.state,
              message: workspace.provider === 'github-codespaces'
                ? 'Checking GitHub status again…'
                : workspace.provider === 'e2b'
                  ? 'Checking E2B status again…'
                  : 'Checking runner status again…',
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
              ? workspace.provider === 'github-codespaces'
                ? 'Codespace online. Starting SSH…'
                : workspace.provider === 'e2b'
                  ? 'E2B workspace online. Starting bridge…'
                  : 'Runner ready. Starting bridge…'
              : workspace.state === 'failed'
                ? `${providerLabel(workspace.provider)} start failed. Preparing recovery…`
                : workspace.provider === 'github-codespaces'
                  ? 'Starting Codespace…'
                  : workspace.provider === 'e2b'
                    ? 'Starting E2B workspace…'
                    : 'Starting runner…',
          });
        }
        if (workspace.state === 'connecting' || workspace.state === 'failed') break;
        if (Date.now() - lastProgressAt > 15_000) {
          lastProgressAt = Date.now();
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'workspace.wait',
            state: workspace.state,
            message: workspace.provider === 'github-codespaces'
              ? 'Waiting for GitHub…'
              : workspace.provider === 'e2b'
                ? 'Waiting for E2B…'
                : 'Waiting for runner…',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      if (['creating', 'starting'].includes(workspace.state)) {
        if (workspace.provider === 'github-codespaces') {
          const alternate = context.allowFallback ? await selectWorkspaceProvider({ attempted: context.attemptedProviders }) : null;
          if (!alternate) {
            await repository.putWorkspace(workspace);
            emit(input.sessionId, 'workspace.preparing', {
              stage: 'workspace.provisioning',
              provider: 'github-codespaces',
              state: workspace.state,
              message: 'GitHub is still starting this Codespace · your Build remains queued and will continue automatically.',
            });
            return workspace;
          }
          throw new Error('GitHub Codespace provisioning exceeded the primary startup window.');
        }
        throw new Error(`${providerLabel(workspace.provider)} did not become ready before the startup timeout.`);
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
      emit(input.sessionId, 'workspace.preparing', {
        stage: 'agent.connect',
        message: workspace.provider === 'github-codespaces'
          ? 'Starting SSH and Orlynx bridge…'
          : workspace.provider === 'e2b'
            ? 'Starting Orlynx bridge in E2B…'
            : 'Starting Orlynx bridge…',
      });
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
              ? 'Starting OpenCode…'
              : 'Connecting Orlynx bridge…',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        finalWorkspace = (await repository.getWorkspace(workspace.id)) || finalWorkspace;
      }
    }
    if (workspaceFullyReady(finalWorkspace)) {
      noteComputeSuccess(finalWorkspace.provider, Date.now() - preparationStartedAt);
      emit(input.sessionId, 'workspace.ready', { workspaceId: finalWorkspace.id, message: 'Workspace ready.' });
      return finalWorkspace;
    }
    if (finalWorkspace.state === 'failed') {
      throw new Error(finalWorkspace.failureCode || 'The development environment failed to start.');
    }
    throw new Error('Orlynx could not connect to the development environment after the workspace started.');
  } catch (error) {
    if (workspace) {
      const detail = error instanceof Error ? error.message : 'workspace_start_failed';
      noteComputeFailure(workspace.provider, detail, Date.now() - preparationStartedAt);

      // A bridge refresh is best-effort while a previously authenticated
      // workspace is still healthy. If gh codespace ssh cannot see the
      // Codespace but the REST API still can, restore the proven-good bridge
      // instead of turning a refresh problem into a workspace outage.
      if (workspace.provider === 'github-codespaces' && refreshFallback && workspaceNeedsCodespaceReplacement(detail) && replacementDepth < 1) {
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
            message: 'Codespace unavailable — starting a fresh Codespace…',
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
          return prepareWorkspaceOnce(input, replacementDepth + 1, context);
        } catch (replacementError) {
          console.warn(`[workspace] stale Codespace replacement failed session=${input.sessionId}: ${replacementError instanceof Error ? replacementError.message : 'unknown error'}`);
        }
      }

      const permanentProviderFailure = classifyWorkspaceFailure(error) !== 'transient';
      const fallbackProvider = context.allowFallback && !permanentProviderFailure
        ? await selectWorkspaceProvider({
            attempted: context.attemptedProviders,
            preferredProvider: workspace.provider,
          }).catch(() => null)
        : null;
      if (fallbackProvider) {
        console.warn(`[workspace] provider failover session=${input.sessionId} from=${workspace.provider} to=${fallbackProvider}: ${detail}`);
        // Failure does not prove an existing checkout is disposable. Retain
        // the provider resource and its scoped metadata for safe recovery.
        workspace = await rerouteWorkspace(workspace, fallbackProvider);
        context.attemptedProviders.add(fallbackProvider);
        provider = providerForWorkspace(workspace);
        emit(input.sessionId, 'workspace.preparing', {
          stage: 'workspace.fallback',
          provider: fallbackProvider,
          message: 'Switching compute…',
        });
        return prepareWorkspaceOnce(input, replacementDepth, context);
      }

      if (workspace.provider === 'github-codespaces' && !refreshFallback && workspace.codespaceName && workspaceNeedsCodespaceReplacement(detail) && replacementDepth < 1 && provider.replace) {
        try {
          emit(input.sessionId, 'workspace.preparing', {
            stage: 'codespace.replace',
            message: 'SSH unavailable — restarting with a fresh Codespace…',
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
    runtimeState: 'recovering',
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
