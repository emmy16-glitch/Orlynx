import os from 'node:os';
import { v4 as uuid } from 'uuid';
import type { WorkspaceRecord } from '@orlynx/shared';
import { emit } from './events.js';
import { controlPlaneRepository, durableStorageConfigured, type WorkspaceJobRecord } from './storage.js';
import { ensureWorkspaceRecord, prepareWorkspace } from './workspaces.js';

export interface WorkspacePreparationInput {
  sessionId: string;
  userId: string;
  projectId: string;
  repositoryId: number;
  branch: string;
}

export interface WorkspacePreparationOptions {
  allowFallback?: boolean;
  reason?: string;
}

function orchestratorMode(): 'worker' | 'inline' {
  return process.env.ORLYNX_ORCHESTRATOR_MODE === 'worker' ? 'worker' : 'inline';
}

function workerId(prefix = 'worker'): string {
  return `${prefix}-${process.env.RENDER_INSTANCE_ID || os.hostname()}-${process.pid}`;
}

function retryable(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error || '');
  return !/(?:HTTP\s*(?:401|403)|forbidden|permission.*(?:required|denied)|authorization expired|not configured|invalid .*configuration)/i.test(detail);
}

async function promoteSession(sessionId: string): Promise<void> {
  // Dynamic import avoids making agents.ts <-> workspace-jobs.ts a static
  // module cycle while still recovering durable tasks after a cold process
  // restart. Direct responses that died with the old process are closed once,
  // then the next queued task can continue automatically.
  const { promoteNextQueuedRun, recoverInterruptedDirectRuns } = await import('./agents.js');
  await recoverInterruptedDirectRuns(sessionId);
  await promoteNextQueuedRun(sessionId);
}

export async function recoverDurableTaskSessionsOnce(limit = Number(process.env.ORLYNX_RECOVERY_SWEEP_LIMIT || 100)): Promise<string[]> {
  if (!durableStorageConfigured()) return [];
  const repository = controlPlaneRepository();
  if (!repository.listActiveTaskSessionIds) return [];
  const sessionIds = await repository.listActiveTaskSessionIds(limit);
  for (let offset = 0; offset < sessionIds.length; offset += 4) {
    const batch = sessionIds.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(promoteSession));
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.warn(`[orchestrator] session recovery failed session=${batch[index]}: ${result.reason instanceof Error ? result.reason.message : 'unknown error'}`);
    });
  }
  return sessionIds;
}

let inlineKick: Promise<void> | null = null;
function kickInlineOrchestrator(): void {
  if (orchestratorMode() === 'worker' || inlineKick || !durableStorageConfigured()) return;
  let shouldRecheck = false;
  inlineKick = (async () => {
    const sessions = await runWorkspaceOrchestratorOnce(workerId('inline'), 2);
    shouldRecheck = sessions.length > 0;
    for (const sessionId of sessions) await promoteSession(sessionId);
  })().catch((error) => {
    console.warn(`[orchestrator] inline pass failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }).finally(() => {
    inlineKick = null;
    // Inline compatibility mode still recovers retry-delayed durable jobs.
    // Production worker mode uses the persistent loop instead.
    if (shouldRecheck) {
      const timer = setTimeout(kickInlineOrchestrator, 10_000);
      timer.unref?.();
    }
  });
}

export async function scheduleWorkspacePreparation(
  input: WorkspacePreparationInput,
  options: WorkspacePreparationOptions = {},
): Promise<WorkspaceRecord> {
  const workspace = await ensureWorkspaceRecord(input);
  if (!durableStorageConfigured()) {
    // Local/test compatibility. Hosted production requires durable storage.
    void prepareWorkspace(input, { allowFallback: options.allowFallback }).catch(() => {});
    return workspace;
  }

  const repository = controlPlaneRepository();
  const now = new Date().toISOString();
  const job: WorkspaceJobRecord = {
    id: `wjob_${uuid()}`,
    workspaceId: workspace.id,
    sessionId: workspace.sessionId,
    kind: 'prepare',
    state: 'queued',
    allowFallback: options.allowFallback !== false,
    reason: options.reason,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await repository.enqueueWorkspaceJob(job);
  if (inserted) {
    emit(input.sessionId, 'workspace.preparing', {
      stage: 'orchestrator.queued',
      workspaceId: workspace.id,
      provider: workspace.provider,
      reason: options.reason || 'workspace_prepare',
      message: options.reason === 'prewarm'
        ? 'Preparing the development environment in the background…'
        : 'Development environment task queued.',
    });
  }

  // Inline mode preserves single-service deployments while still writing the
  // durable job first. Production can switch to a dedicated worker by setting
  // ORLYNX_ORCHESTRATOR_MODE=worker without changing request handlers.
  kickInlineOrchestrator();
  return workspace;
}

export async function runWorkspaceOrchestratorOnce(
  id = workerId(),
  limit = Number(process.env.ORLYNX_ORCHESTRATOR_BATCH_SIZE || 4),
): Promise<string[]> {
  if (!durableStorageConfigured()) return [];
  const repository = controlPlaneRepository();
  const leaseSeconds = Math.max(60, Number(process.env.ORLYNX_ORCHESTRATOR_LEASE_SECONDS || 180));
  // Infrastructure recovery is intentionally patient. A Build task is durable,
  // so transient runner/Codespaces outages should get several bounded retries
  // instead of exhausting the orchestrator while the user's task is still queued.
  const maxAttempts = Math.max(1, Number(process.env.ORLYNX_ORCHESTRATOR_MAX_ATTEMPTS || 12));
  const jobs = await repository.claimWorkspaceJobs(id, limit, leaseSeconds);
  const touchedSessions = new Set<string>();

  // Every claimed job starts immediately, with its own renewal. Claiming a
  // batch and processing it sequentially lets the later leases expire unseen.
  await Promise.all(jobs.map(async (job) => {
    touchedSessions.add(job.sessionId);
    const heartbeat = setInterval(() => {
      void repository.renewWorkspaceJobLease(job.id, id, leaseSeconds, job.attempt).catch(() => false);
    }, Math.max(10_000, Math.floor(leaseSeconds * 1000 / 3)));
    heartbeat.unref?.();

    try {
      const workspace = await repository.getWorkspace(job.workspaceId);
      if (!workspace) {
        await repository.failWorkspaceJob(job.id, 'Workspace no longer exists.', job);
        return;
      }

      emit(job.sessionId, 'workspace.preparing', {
        stage: 'orchestrator.claimed',
        workspaceId: workspace.id,
        attempt: job.attempt,
        workerId: id,
        message: 'Preparing the development environment…',
      });

      const prepared = await prepareWorkspace({
        sessionId: workspace.sessionId,
        userId: workspace.userId,
        projectId: workspace.projectId,
        repositoryId: workspace.repositoryId,
        branch: workspace.branch,
      }, { allowFallback: job.allowFallback, onProviderAttempt: async provider => {
        if (!await repository.noteWorkspaceJobProviderAttempt(job.id, provider, job)) throw new Error('Workspace preparation lease or provider-attempt budget was exhausted.');
      } });

      if (prepared.state === 'ready' && prepared.bridgeState === 'ready') {
        await repository.completeWorkspaceJob(job.id, job);
      } else if (prepared.provider === 'github-codespaces' && ['creating', 'starting', 'connecting', 'bootstrapping'].includes(prepared.state)) {
        throw new Error('Codespace provisioning is still pending.');
      } else {
        throw new Error(prepared.failureCode || 'Workspace preparation ended before the bridge became ready.');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Workspace orchestration failed.';
      const provisioningPending = /Codespace provisioning is still pending/i.test(detail);
      if (job.attempt < maxAttempts && retryable(error)) {
        const delaySeconds = provisioningPending
          ? Math.min(30, Math.max(5, 5 + job.attempt * 2))
          : Math.min(60, Math.max(3, 2 ** Math.max(1, job.attempt)));
        if (!await repository.retryWorkspaceJob(job.id, detail, delaySeconds, job)) return;
        emit(job.sessionId, 'workspace.preparing', {
          stage: provisioningPending ? 'orchestrator.provisioning' : 'orchestrator.retry',
          attempt: job.attempt,
          retryInSeconds: delaySeconds,
          message: provisioningPending
            ? 'Codespace is still provisioning · Build remains queued and Orlynx will keep checking.'
            : 'Development environment preparation will retry automatically.',
        });
      } else {
        if (!await repository.failWorkspaceJob(job.id, detail, job)) return;
        emit(job.sessionId, 'workspace.preparing', {
          stage: 'orchestrator.failed',
          state: 'failed',
          attempt: job.attempt,
          message: detail,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }));

  return [...touchedSessions];
}

export async function runWorkspaceOrchestratorLoop(): Promise<never> {
  if (!durableStorageConfigured()) throw new Error('Workspace orchestrator requires durable Postgres storage.');
  const id = workerId();
  const idleMs = Math.max(250, Number(process.env.ORLYNX_ORCHESTRATOR_POLL_MS || 1000));
  const recoverySweepMs = Math.max(5_000, Number(process.env.ORLYNX_RECOVERY_SWEEP_MS || 30_000));
  let nextRecoverySweepAt = 0;
  let recoverySweep: Promise<void> | undefined;
  console.log(`[orchestrator] started worker=${id}`);

  for (;;) {
    const sessions = await runWorkspaceOrchestratorOnce(id);
    for (const sessionId of sessions) await promoteSession(sessionId);

    const now = Date.now();
    if (now >= nextRecoverySweepAt && !recoverySweep) {
      // A session preflight must not stop the durable job poller from claiming
      // or renewing other work while its bridge is unavailable.
      recoverySweep = recoverDurableTaskSessionsOnce().then(recoveredSessions => {
        if (recoveredSessions.length) {
          console.log(`[orchestrator] recovery sweep activeSessions=${recoveredSessions.length}`);
        }
      }).catch(error => {
        console.warn(`[orchestrator] recovery sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }).finally(() => { recoverySweep = undefined; });
      nextRecoverySweepAt = now + recoverySweepMs;
    }

    await new Promise((resolve) => setTimeout(resolve, sessions.length ? 50 : idleMs));
  }
}
