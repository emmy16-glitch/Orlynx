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
  // module cycle while still waking queued Build work after preparation.
  const { promoteNextQueuedRun } = await import('./agents.js');
  await promoteNextQueuedRun(sessionId).catch(() => null);
}

let inlineKick: Promise<void> | null = null;
function kickInlineOrchestrator(): void {
  if (orchestratorMode() === 'worker' || inlineKick || !durableStorageConfigured()) return;
  inlineKick = (async () => {
    const sessions = await runWorkspaceOrchestratorOnce(workerId('inline'), 2);
    for (const sessionId of sessions) await promoteSession(sessionId);
  })().catch((error) => {
    console.warn(`[orchestrator] inline pass failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }).finally(() => { inlineKick = null; });
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
  await repository.enqueueWorkspaceJob(job);
  emit(input.sessionId, 'workspace.preparing', {
    stage: 'orchestrator.queued',
    workspaceId: workspace.id,
    provider: workspace.provider,
    reason: options.reason || 'workspace_prepare',
    message: options.reason === 'prewarm'
      ? 'Preparing the development environment in the background…'
      : 'Development environment task queued.',
  });

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
  const maxAttempts = Math.max(1, Number(process.env.ORLYNX_ORCHESTRATOR_MAX_ATTEMPTS || 4));
  const jobs = await repository.claimWorkspaceJobs(id, limit, leaseSeconds);
  const touchedSessions = new Set<string>();

  for (const job of jobs) {
    touchedSessions.add(job.sessionId);
    const heartbeat = setInterval(() => {
      void repository.renewWorkspaceJobLease(job.id, id, leaseSeconds).catch(() => false);
    }, Math.max(10_000, Math.floor(leaseSeconds * 1000 / 3)));
    heartbeat.unref?.();

    try {
      const workspace = await repository.getWorkspace(job.workspaceId);
      if (!workspace) {
        await repository.failWorkspaceJob(job.id, 'Workspace no longer exists.');
        continue;
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
      }, { allowFallback: job.allowFallback });

      if (prepared.state === 'ready' && prepared.bridgeState === 'ready') {
        await repository.completeWorkspaceJob(job.id);
      } else {
        throw new Error(prepared.failureCode || 'Workspace preparation ended before the bridge became ready.');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Workspace orchestration failed.';
      if (job.attempt < maxAttempts && retryable(error)) {
        const delaySeconds = Math.min(60, Math.max(3, 2 ** Math.max(1, job.attempt)));
        await repository.retryWorkspaceJob(job.id, detail, delaySeconds);
        emit(job.sessionId, 'workspace.preparing', {
          stage: 'orchestrator.retry',
          attempt: job.attempt,
          retryInSeconds: delaySeconds,
          message: 'Development environment preparation will retry automatically.',
        });
      } else {
        await repository.failWorkspaceJob(job.id, detail);
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
  }

  return [...touchedSessions];
}

export async function runWorkspaceOrchestratorLoop(): Promise<never> {
  if (!durableStorageConfigured()) throw new Error('Workspace orchestrator requires durable Postgres storage.');
  const id = workerId();
  const idleMs = Math.max(250, Number(process.env.ORLYNX_ORCHESTRATOR_POLL_MS || 1000));
  console.log(`[orchestrator] started worker=${id}`);

  for (;;) {
    const sessions = await runWorkspaceOrchestratorOnce(id);
    for (const sessionId of sessions) await promoteSession(sessionId);
    await new Promise((resolve) => setTimeout(resolve, sessions.length ? 50 : idleMs));
  }
}
