import type { TaskRecord, WorkspaceRecord } from '@orlynx/shared';
import { githubInstallationApiRequest, githubRepositoryById } from './github.js';
import { verificationRequirementsFor } from './harness.js';
import { controlPlaneRepository } from './storage.js';

type Workflow = { id: number; name: string; path: string; state: string };
type WorkflowRun = {
  id: number;
  name?: string;
  path?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_branch?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
};
type WorkflowJob = {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string;
  steps?: Array<{ name: string; status: string; conclusion?: string | null; number?: number }>;
};
type WorkflowArtifact = { id: number; name: string; size_in_bytes?: number; expired?: boolean; archive_download_url?: string };

export class GitHubActionsUnavailableError extends Error {
  readonly unavailable = true;
}

export interface GitHubActionsVerificationResult {
  available: true;
  success: boolean;
  workflow: { id: number; name: string; path: string };
  run: WorkflowRun;
  jobs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion?: string | null;
    url?: string;
    failedSteps: string[];
  }>;
  artifacts: Array<{ id: number; name: string; size?: number; expired: boolean }>;
  summary: string;
}

function repoParts(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length) throw new Error('GitHub repository identity is invalid.');
  return { owner, repo };
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function workflowDispatchEnabled(source: string): boolean {
  const value = String(source || '');
  // YAML permits either mapping form ("workflow_dispatch:") or flow-list form
  // ("on: [push, workflow_dispatch]"). Ignore comments to avoid false matches.
  const uncommented = value.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '')).join('\n');
  return /^\s*workflow_dispatch\s*:/m.test(uncommented)
    || /^\s*on\s*:\s*\[[^\]]*\bworkflow_dispatch\b[^\]]*\]/m.test(uncommented);
}

export function workflowScore(workflow: Pick<Workflow, 'name' | 'path'>): number {
  const value = `${workflow.name} ${workflow.path}`.toLowerCase();
  let score = 0;
  if (/\bci\b|continuous.integration/.test(value)) score += 100;
  if (/verify|verification|check/.test(value)) score += 80;
  if (/test/.test(value)) score += 70;
  if (/build/.test(value)) score += 60;
  if (/lint|typecheck/.test(value)) score += 40;
  if (/deploy|release|publish/.test(value)) score -= 120;
  return score;
}

export function githubActionsVerificationEligible(task: Pick<TaskRecord, 'prompt' | 'mode' | 'harness'>): boolean {
  if ((task.mode || 'build') !== 'build') return false;
  const required = task.harness?.verification.required || verificationRequirementsFor(task.prompt);
  if (!required.length || required.some((item) => !['tests', 'build'].includes(item))) return false;

  // Actions is a verification backend, not an editing backend. Never dispatch a
  // remote CI job as a substitute for a task that asked Orlynx to change code.
  if (/\b(fix|implement|edit|modify|change|update|delete|create|add|remove|rename|refactor|rewrite|commit|push|publish|merge|revert|patch|deploy|redeploy)\b/i.test(task.prompt)) return false;
  return true;
}

async function workflowSource(installationId: number, owner: string, repo: string, workflow: Workflow, branch: string): Promise<string> {
  const result = await githubInstallationApiRequest<{ content?: string; encoding?: string }>(
    installationId,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath(workflow.path)}?ref=${encodeURIComponent(branch)}`,
  );
  if (result.encoding !== 'base64' || !result.content) return '';
  return Buffer.from(result.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

export async function selectDispatchableVerificationWorkflow(
  workspace: Pick<WorkspaceRecord, 'userId' | 'repositoryId' | 'branch'>,
): Promise<{ repository: { fullName: string }; workflow: Workflow }> {
  const repository = await githubRepositoryById(workspace.userId, workspace.repositoryId);
  const { owner, repo } = repoParts(repository.fullName);
  const result = await githubInstallationApiRequest<{ workflows?: Workflow[] }>(
    repository.installationId,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?per_page=100`,
  );
  const candidates = (result.workflows || [])
    .filter((workflow) => workflow.state === 'active')
    .sort((a, b) => workflowScore(b) - workflowScore(a));

  for (const workflow of candidates) {
    try {
      const source = await workflowSource(repository.installationId, owner, repo, workflow, workspace.branch);
      if (workflowDispatchEnabled(source)) return { repository, workflow };
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 403) throw new GitHubActionsUnavailableError('GitHub Actions permission is not approved for this Orlynx installation yet.');
      if (status === 404) continue;
      throw error;
    }
  }
  throw new GitHubActionsUnavailableError('This repository has no active CI workflow with workflow_dispatch enabled. Orlynx will not modify the repository just to create one.');
}

async function findDispatchedRun(
  installationId: number,
  owner: string,
  repo: string,
  workflowId: number,
  branch: string,
  dispatchedAt: number,
): Promise<WorkflowRun | null> {
  const result = await githubInstallationApiRequest<{ workflow_runs?: WorkflowRun[] }>(
    installationId,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=20`,
  );
  const floor = dispatchedAt - 15_000;
  return (result.workflow_runs || [])
    .filter((run) => run.event === 'workflow_dispatch' && run.head_branch === branch && Date.parse(run.created_at || '') >= floor)
    .sort((a, b) => Date.parse(a.created_at || '') - Date.parse(b.created_at || ''))[0] || null;
}

async function waitForRunIdentity(
  installationId: number,
  owner: string,
  repo: string,
  workflowId: number,
  branch: string,
  dispatchedAt: number,
): Promise<WorkflowRun> {
  const deadline = Date.now() + Math.max(30_000, Number(process.env.ORLYNX_GITHUB_ACTIONS_DISCOVERY_TIMEOUT_MS || 90_000));
  while (Date.now() < deadline) {
    const run = await findDispatchedRun(installationId, owner, repo, workflowId, branch, dispatchedAt);
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error('GitHub accepted the workflow dispatch but Orlynx could not identify the new run.');
}

async function getRun(userId: string, owner: string, repo: string, runId: number): Promise<WorkflowRun> {
  return githubInstallationApiRequest<WorkflowRun>(
    installationId,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`,
  );
}

async function waitForCompletion(userId: string, owner: string, repo: string, runId: number): Promise<WorkflowRun> {
  const deadline = Date.now() + Math.max(2 * 60_000, Number(process.env.ORLYNX_GITHUB_ACTIONS_TIMEOUT_MS || 20 * 60_000));
  let run = await getRun(installationId, owner, repo, runId);
  while (run.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    run = await getRun(installationId, owner, repo, runId);
  }
  if (run.status !== 'completed') throw new Error('GitHub Actions verification did not finish before the Orlynx verification timeout.');
  return run;
}

function verificationSummary(run: WorkflowRun, jobs: WorkflowJob[]): string {
  const failedJobs = jobs.filter((job) => job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped');
  if (run.conclusion === 'success') {
    return `GitHub Actions verification passed (${jobs.length} job${jobs.length === 1 ? '' : 's'}).`;
  }
  const detail = failedJobs.slice(0, 4).map((job) => {
    const failed = (job.steps || []).filter((step) => step.conclusion === 'failure').map((step) => step.name).slice(0, 3);
    return failed.length ? `${job.name}: ${failed.join(', ')}` : job.name;
  }).join('; ');
  return `GitHub Actions verification ${run.conclusion || 'failed'}${detail ? `: ${detail}` : '.'}`;
}

export async function runGitHubActionsVerification(
  task: TaskRecord,
  workspace: Pick<WorkspaceRecord, 'userId' | 'repositoryId' | 'branch'>,
): Promise<GitHubActionsVerificationResult> {
  if (!githubActionsVerificationEligible(task)) {
    throw new GitHubActionsUnavailableError('This task needs an interactive workspace, not CI-only verification.');
  }

  const repositoryState = controlPlaneRepository();
  const repository = await githubRepositoryById(workspace.userId, workspace.repositoryId);
  const { owner, repo } = repoParts(repository.fullName);
  let workflow: Workflow;
  let run: WorkflowRun;

  if (task.verificationRunId) {
    workflow = {
      id: 0,
      name: task.verificationWorkflow || 'GitHub Actions',
      path: task.verificationWorkflow || '',
      state: 'active',
    };
    run = await getRun(repository.installationId, owner, repo, task.verificationRunId);
  } else {
    const selected = await selectDispatchableVerificationWorkflow(workspace);
    workflow = selected.workflow;
    const dispatchedAt = Date.now();
    try {
      await githubInstallationApiRequest<void>(
        repository.installationId,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflow.id}/dispatches`,
        { method: 'POST', body: JSON.stringify({ ref: workspace.branch }) },
      );
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 403) {
        throw new GitHubActionsUnavailableError('GitHub Actions write permission is not approved for this Orlynx installation yet.');
      }
      if (status === 404) {
        throw new GitHubActionsUnavailableError('GitHub Actions is not available for this repository or workflow.');
      }
      throw error;
    }

    run = await waitForRunIdentity(repository.installationId, owner, repo, workflow.id, workspace.branch, dispatchedAt);
    task.verificationBackend = 'github-actions';
    task.verificationRunId = run.id;
    task.verificationUrl = run.html_url;
    task.verificationWorkflow = workflow.path || workflow.name;
    task.updatedAt = new Date().toISOString();
    await repositoryState.putTask(task);
  }

  run = await waitForCompletion(repository.installationId, owner, repo, run.id);
  const [jobData, artifactData] = await Promise.all([
    githubInstallationApiRequest<{ jobs?: WorkflowJob[] }>(
      repository.installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run.id}/jobs?per_page=100`,
    ),
    githubInstallationApiRequest<{ artifacts?: WorkflowArtifact[] }>(
      repository.installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run.id}/artifacts?per_page=100`,
    ).catch(() => ({ artifacts: [] })),
  ]);
  const jobs = jobData.jobs || [];
  return {
    available: true,
    success: run.conclusion === 'success',
    workflow: { id: workflow.id, name: workflow.name, path: workflow.path },
    run,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.html_url,
      failedSteps: (job.steps || []).filter((step) => step.conclusion === 'failure').map((step) => step.name),
    })),
    artifacts: (artifactData.artifacts || []).map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      size: artifact.size_in_bytes,
      expired: artifact.expired === true,
    })),
    summary: verificationSummary(run, jobs),
  };
}
