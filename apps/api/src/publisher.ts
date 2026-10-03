import { assertLiveE2EPublication, liveE2ESessionBranch } from './e2e-safety.js';
import { prePublicationMissing } from './publication-language.js';
import crypto from 'node:crypto';
import type { ChangeSet, ChangedFile, TaskRecord } from '@orlynx/shared';
import { bridgeRequest } from './bridge-rpc.js';
import {
  createGitHubPullRequest,
  getGitHubPullRequest,
  githubInstallationApiRequest,
  githubInstallationPermissionStatus,
  githubRepositoryById,
  mergeGitHubPullRequest,
  type GitHubMergeMethod,
} from './github.js';
import { controlPlaneRepository } from './storage.js';
import { emitPersisted } from './events.js';
import { verifyHarness } from './harness.js';

export type PublicationStrategy = 'direct' | 'pull-request';

export interface PublicationResult {
  branch: string;
  head: string;
  alreadyPublished?: boolean;
  workspaceReconciled?: boolean;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  protectedBranchFallback?: boolean;
  changeId: string;
}

type GitStatus = {
  branch?: string;
  head?: string;
  porcelain?: string;
  remoteHead?: string;
  ahead?: number;
  behind?: number;
};

type GitRef = { object?: { sha?: string } };
type GitCommit = { tree?: { sha?: string } };
type GitObject = { sha?: string };

function encodedRef(branch: string): string {
  return branch.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function parsePorcelainPaths(porcelain: string): string[] {
  return String(porcelain || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const raw = line.length > 3 ? line.slice(3).trim() : '';
      if (!raw) return [];
      const path = raw.includes(' -> ') ? raw.split(' -> ').pop() || raw : raw;
      return [path.replace(/^"|"$/g, '')];
    });
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeBranch(value: string): string {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('..') || raw.startsWith('/') || raw.endsWith('/') || raw.startsWith('-')) {
    throw new Error('Publication branch is invalid.');
  }
  const cleaned = raw
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 100);
  if (!cleaned || cleaned.includes('..') || cleaned.startsWith('-')) throw new Error('Publication branch is invalid.');
  return cleaned;
}

function publicationCandidate(
  changes: ChangeSet[],
  tasks: TaskRecord[],
  runId?: string,
): { change: ChangeSet; task: TaskRecord } {
  const ordered = [...changes].reverse();
  for (const change of ordered) {
    if (!change.files.length) continue;
    if (runId && change.runId !== runId) continue;
    const task = [...tasks].reverse().find((item) => item.runId && item.runId === change.runId);
    if (!task?.harness) continue;
    const nonPublishMissing = prePublicationMissing(task.harness.verification.missing);
    if (nonPublishMissing.length) continue;
    return { change, task };
  }
  throw new Error('No verified change set is ready to publish.');
}

type CommittedWorkspaceSnapshot = {
  branch?: string;
  head?: string;
  baseSha?: string;
  ahead?: number;
  files?: ChangedFile[];
};

async function recoverCommittedPublicationCandidate(input: {
  sessionId: string;
  workspaceId: string;
  tasks: TaskRecord[];
  baseSha: string;
  runId?: string;
}): Promise<{ change: ChangeSet; task: TaskRecord }> {
  const orderedTasks = [...input.tasks].reverse();
  const task = input.runId
    ? orderedTasks.find((item) => item.runId === input.runId)
    : orderedTasks.find((item) => item.harness?.verification.required.includes('publish'));
  if (!task?.harness || !task.runId) throw new Error('No verified change set is ready to publish.');

  const snapshot = await bridgeRequest<CommittedWorkspaceSnapshot>(
    input.workspaceId,
    'git.capture-committed-changes',
    { approved: true, baseSha: input.baseSha },
    90_000,
  );
  const head = String(snapshot.head || '');
  const baseSha = String(snapshot.baseSha || '');
  const files = Array.isArray(snapshot.files) ? snapshot.files : [];
  const ahead = Number(snapshot.ahead || 0);
  if (!/^[a-f0-9]{40}$/i.test(head) || baseSha !== input.baseSha || ahead < 1 || !files.length) {
    throw new Error('No committed local work is ready for controlled publication.');
  }

  const change: ChangeSet = {
    id: `chg_${crypto.randomUUID()}`,
    sessionId: input.sessionId,
    runId: task.runId,
    baseSha: input.baseSha,
    currentHead: head,
    files,
    reviewState: 'pending',
    createdAt: new Date().toISOString(),
  };
  await controlPlaneRepository().putChangeSet(change);

  const now = new Date().toISOString();
  await emitPersisted(
    input.sessionId,
    'changes.updated',
    {
      changeId: change.id,
      count: files.length,
      files: files.slice(0, 20).map((file) => ({
        path: file.path,
        action: file.action,
        additions: file.additions,
        deletions: file.deletions,
        afterHash: file.afterHash,
        diff: String(file.diff || '').slice(0, 8_000),
      })),
      recoveredCommittedWork: true,
      localHead: head,
      baseSha: input.baseSha,
      ahead,
    },
    task.runId,
    { taskId: task.id, workspaceId: input.workspaceId, timestamp: now },
  );

  const recent = await controlPlaneRepository().listRunEvents(input.sessionId, task.runId, 1000);
  task.harness = verifyHarness(task.harness, recent, now);
  task.harness.verifiedWorkspaceHead = head;
  task.updatedAt = now;
  await controlPlaneRepository().putTask(task);
  return { change, task };
}

async function validatedWorkspaceFiles(
  workspaceId: string,
  change: ChangeSet,
  task: TaskRecord,
): Promise<{ files: Array<{ file: ChangedFile; contentBase64?: string; mode?: '100644' | '100755' | '120000' }>; status: GitStatus }> {
  const status = await bridgeRequest<GitStatus>(workspaceId, 'git.status', {}, 30_000);
  const head = String(status.head || '');
  const expectedWorkspaceHead = String(change.currentHead || change.baseSha || '');
  if (!head || !change.baseSha || !expectedWorkspaceHead) throw new Error('Publication cannot verify the workspace base commit.');
  if (head !== expectedWorkspaceHead) {
    throw new Error('Workspace HEAD changed after the recorded change set. Re-verify before publishing.');
  }
  if (task.harness?.verifiedWorkspaceHead && task.harness.verifiedWorkspaceHead !== head) {
    throw new Error('Workspace HEAD changed after verification. Re-run verification before publishing.');
  }

  const allowed = new Set(change.files.map((file) => file.path));
  const dirty = parsePorcelainPaths(String(status.porcelain || ''));
  const unrelated = dirty.filter((file) => !allowed.has(file));
  if (unrelated.length) {
    throw new Error(`Publication blocked because unrelated workspace files are dirty: ${unrelated.slice(0, 8).join(', ')}`);
  }

  const validated: Array<{ file: ChangedFile; contentBase64?: string; mode?: '100644' | '100755' | '120000' }> = [];
  for (const file of change.files) {
    if (!file.path || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      throw new Error('Publication change set contains an invalid path.');
    }
    if (file.action === 'delete') {
      try {
        await bridgeRequest(workspaceId, 'fs.read', { path: file.path }, 15_000);
        throw new Error(`Expected deleted file still exists: ${file.path}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Expected deleted file still exists:')) throw error;
      }
      validated.push({ file });
      continue;
    }

    const read = await bridgeRequest<{ contentBase64?: string; mode?: string }>(
      workspaceId,
      'git.read-publication-file',
      { path: file.path, approved: true },
      15_000,
    );
    const contentBase64 = String(read.contentBase64 || '');
    const mode = String(read.mode || '');
    if (!contentBase64 || !['100644', '100755', '120000'].includes(mode)) {
      throw new Error(`Publication could not read exact Git bytes for ${file.path}.`);
    }
    const bytes = Buffer.from(contentBase64, 'base64');
    const expectedHash = file.afterHash || (typeof file.after === 'string' ? sha256(Buffer.from(file.after, 'utf8')) : '');
    if (!expectedHash) throw new Error(`Publication lacks observed contents for ${file.path}. Re-run the change capture.`);
    if (sha256(bytes) !== expectedHash) {
      throw new Error(`File changed after verification: ${file.path}. Re-verify before publishing.`);
    }
    validated.push({ file, contentBase64, mode: mode as '100644' | '100755' | '120000' });
  }
  return { files: validated, status };
}

async function refSha(installationId: number, project: string, branch: string): Promise<string | null> {
  const refPath = encodedRef(branch);
  try {
    const ref = await githubInstallationApiRequest<GitRef>(
      installationId,
      `/repos/${project}/git/ref/heads/${refPath}`,
    );
    return String(ref.object?.sha || '') || null;
  } catch (error) {
    if ((error as Error & { status?: number }).status === 404) return null;
    throw error;
  }
}

async function createCommitFromFiles(input: {
  installationId: number;
  project: string;
  parentSha: string;
  files: Array<{ file: ChangedFile; contentBase64?: string; mode?: '100644' | '100755' | '120000' }>;
  message: string;
}): Promise<string> {
  const parent = await githubInstallationApiRequest<GitCommit>(
    input.installationId,
    `/repos/${input.project}/git/commits/${encodeURIComponent(input.parentSha)}`,
  );
  const baseTree = String(parent.tree?.sha || '');
  if (!baseTree) throw new Error('GitHub did not return the base tree for publication.');

  const tree: Array<{ path: string; mode: '100644' | '100755' | '120000'; type: 'blob'; sha: string | null }> = [];
  for (const item of input.files) {
    if (item.file.action === 'delete') {
      tree.push({ path: item.file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    if (!item.contentBase64 || !item.mode) throw new Error(`Publication bytes are unavailable for ${item.file.path}.`);
    const blob = await githubInstallationApiRequest<GitObject>(
      input.installationId,
      `/repos/${input.project}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: item.contentBase64,
          encoding: 'base64',
        }),
      },
    );
    if (!blob.sha) throw new Error(`GitHub did not create a blob for ${item.file.path}.`);
    tree.push({ path: item.file.path, mode: item.mode, type: 'blob', sha: blob.sha });
  }

  const treeResult = await githubInstallationApiRequest<GitObject>(
    input.installationId,
    `/repos/${input.project}/git/trees`,
    { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) },
  );
  if (!treeResult.sha) throw new Error('GitHub did not create the publication tree.');

  const commit = await githubInstallationApiRequest<GitObject>(
    input.installationId,
    `/repos/${input.project}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: input.message.trim().slice(0, 240) || 'Orlynx verified changes',
        tree: treeResult.sha,
        parents: [input.parentSha],
      }),
    },
  );
  if (!commit.sha) throw new Error('GitHub did not create the publication commit.');
  return commit.sha;
}

async function createBranch(
  installationId: number,
  project: string,
  branch: string,
  sha: string,
): Promise<void> {
  await githubInstallationApiRequest(
    installationId,
    `/repos/${project}/git/refs`,
    {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    },
  );
}

async function updateBranch(
  installationId: number,
  project: string,
  branch: string,
  sha: string,
): Promise<void> {
  await githubInstallationApiRequest(
    installationId,
    `/repos/${project}/git/refs/heads/${encodedRef(branch)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha, force: false }),
    },
  );
}

async function reconcilePublishedWorkspace(input: {
  workspaceId: string;
  branch: string;
  expectedHead: string;
  publishedHead: string;
  files: string[];
}): Promise<boolean> {
  try {
    const reconciled = await bridgeRequest<{ state?: string; head?: string }>(
      input.workspaceId,
      'git.reconcile-published',
      {
        approved: true,
        branch: input.branch,
        expectedHead: input.expectedHead,
        publishedHead: input.publishedHead,
        files: input.files,
      },
      120_000,
    );
    return reconciled.state === 'reconciled' && reconciled.head === input.publishedHead;
  } catch {
    // Publication already succeeded remotely. Never turn a safe publication
    // into a false failure because local work changed after verification.
    return false;
  }
}

export async function publishVerifiedChangeSet(input: {
  sessionId: string;
  workspaceId: string;
  strategy?: PublicationStrategy;
  targetBranch?: string;
  runId?: string;
  commitMessage?: string;
}): Promise<PublicationResult> {
  const repository = controlPlaneRepository();
  const [session, workspace, changes, tasks] = await Promise.all([
    repository.getSession(input.sessionId),
    repository.getWorkspace(input.workspaceId),
    repository.listChangeSets(input.sessionId),
    repository.listTasks(input.sessionId),
  ]);
  if (!session || !workspace || workspace.sessionId !== session.id) throw new Error('Publication session/workspace is unavailable.');
  if (workspace.state !== 'ready' || workspace.bridgeState !== 'ready') throw new Error('The development environment must be ready before publishing.');

  const githubRepo = await githubRepositoryById(workspace.userId, workspace.repositoryId);
  if (githubRepo.fullName.toLowerCase() !== session.project.toLowerCase()) {
    throw new Error('Connected GitHub authorization does not match this conversation repository.');
  }
  const permissions = await githubInstallationPermissionStatus(githubRepo.installationId);
  if (!permissions.publishReady) {
    throw new Error(`GitHub App publication permissions are incomplete: ${permissions.missingPublish.join(', ')}.`);
  }

  const sessionBaseBranch = safeBranch(session.branch);
  const targetBranch = safeBranch(input.targetBranch || sessionBaseBranch);
  const strategy = input.strategy || 'direct';
  assertLiveE2EPublication(session, targetBranch, strategy);
  const verifyE2EWorkspaceBranch = async () => {
    if (!liveE2ESessionBranch(session)) return;
    const status = await bridgeRequest<GitStatus>(input.workspaceId, 'git.status', {}, 30_000);
    assertLiveE2EPublication(session, targetBranch, strategy, String(status.branch || ''));
  };
  await verifyE2EWorkspaceBranch();
  const targetRemoteSha = await refSha(githubRepo.installationId, githubRepo.fullName, targetBranch);
  // Direct publication to an existing explicit target (for example "push to
  // main") is based on that target's live GitHub head, not stale conversation
  // branch metadata. New target branches still fork from the session branch.
  const baseBranch = strategy === 'direct' && targetRemoteSha ? targetBranch : sessionBaseBranch;
  const baseRemoteSha = baseBranch === targetBranch
    ? targetRemoteSha
    : await refSha(githubRepo.installationId, githubRepo.fullName, baseBranch);
  if (!baseRemoteSha) throw new Error(`GitHub branch ${baseBranch} does not exist.`);
  const existingTargetSha = targetRemoteSha;

  let candidate: { change: ChangeSet; task: TaskRecord };
  try {
    candidate = publicationCandidate(changes, tasks, input.runId);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'No verified change set is ready to publish.') throw error;
    candidate = await recoverCommittedPublicationCandidate({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      tasks,
      baseSha: baseRemoteSha,
      runId: input.runId,
    });
  }
  const { change, task } = candidate;
  const nonPublishMissing = prePublicationMissing(task.harness?.verification.missing || []);
  if (nonPublishMissing.length) {
    throw new Error(`Verification is incomplete: ${nonPublishMissing.join(', ')}.`);
  }

  // Recover a remote publication whose durable receipt was interrupted. This
  // check intentionally happens before workspace dirty/hash validation: after a
  // successful push the workspace may already be clean/reconciled, and retrying
  // must not misreport that successful publication as a validation failure.
  if (strategy === 'direct' && change.commitSha && existingTargetSha === change.commitSha) {
    change.pushedAt ||= new Date().toISOString();
    change.pushedBranch = targetBranch;
    await repository.putChangeSet(change);
    const workspaceReconciled = targetBranch === baseBranch
      ? await reconcilePublishedWorkspace({
          workspaceId: input.workspaceId,
          branch: baseBranch,
          expectedHead: change.currentHead || change.baseSha,
          publishedHead: change.commitSha,
          files: change.files.map((file) => file.path),
        })
      : false;
    return { branch: targetBranch, head: existingTargetSha, alreadyPublished: true, workspaceReconciled, changeId: change.id };
  }

  const retryPullRequestBranch = strategy === 'pull-request'
    ? (targetBranch === baseBranch
        ? safeBranch(`orlynx/publish-${task.id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-36)}`)
        : targetBranch)
    : '';
  if (strategy === 'pull-request' && change.commitSha && retryPullRequestBranch) {
    const retryBranchSha = await refSha(githubRepo.installationId, githubRepo.fullName, retryPullRequestBranch);
    if (retryBranchSha === change.commitSha) {
      const pr = await createGitHubPullRequest(
        githubRepo.fullName,
        baseBranch,
        retryPullRequestBranch,
        input.commitMessage || 'Orlynx verified changes',
        'Created by Orlynx from a verified change set. Publication credentials remained in the control plane.',
        githubRepo.installationId,
      );
      change.pushedAt ||= new Date().toISOString();
      change.pushedBranch = retryPullRequestBranch;
      change.pullRequestUrl = pr.url;
      change.pullRequestNumber = pr.number;
      await repository.putChangeSet(change);
      return {
        branch: retryPullRequestBranch,
        head: change.commitSha,
        alreadyPublished: true,
        pullRequestUrl: pr.url,
        pullRequestNumber: pr.number,
        changeId: change.id,
      };
    }
  }

  const { files } = await validatedWorkspaceFiles(input.workspaceId, change, task);
  if (baseRemoteSha !== change.baseSha) {
    throw new Error(`GitHub ${baseBranch} moved since this work began. Refresh/reconcile before publishing.`);
  }
  if (existingTargetSha && existingTargetSha !== change.baseSha) {
    throw new Error(`GitHub branch ${targetBranch} diverged from the verified base. Refusing a non-fast-forward publication.`);
  }

  const workspaceHeadBeforePublish = change.currentHead || change.baseSha;
  const commitSha = change.commitSha || await createCommitFromFiles({
    installationId: githubRepo.installationId,
    project: githubRepo.fullName,
    parentSha: change.baseSha,
    files,
    message: input.commitMessage || `Orlynx verified update for ${session.project}`,
  });
  change.reviewState = 'committed';
  change.commitSha = commitSha;
  // Preserve the actual local workspace HEAD until reconciliation succeeds.
  // A recovered local commit can have a different SHA from the GitHub commit
  // Orlynx safely reconstructs from the same verified bytes.
  change.currentHead = workspaceHeadBeforePublish;
  await repository.putChangeSet(change);

  if (strategy === 'pull-request') {
    const publishBranch = targetBranch === baseBranch
      ? safeBranch(`orlynx/publish-${task.id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-36)}`)
      : targetBranch;
    const current = await refSha(githubRepo.installationId, githubRepo.fullName, publishBranch);
    if (!current) await createBranch(githubRepo.installationId, githubRepo.fullName, publishBranch, commitSha);
    else if (current !== commitSha) throw new Error(`Publication branch ${publishBranch} already exists with different work.`);
    const pr = await createGitHubPullRequest(
      githubRepo.fullName,
      baseBranch,
      publishBranch,
      input.commitMessage || 'Orlynx verified changes',
      'Created by Orlynx from a verified change set. Publication credentials remained in the control plane.',
      githubRepo.installationId,
    );
    change.pushedAt = new Date().toISOString();
    change.pushedBranch = publishBranch;
    change.pullRequestUrl = pr.url;
    change.pullRequestNumber = pr.number;
    await repository.putChangeSet(change);
    return { branch: publishBranch, head: commitSha, pullRequestUrl: pr.url, pullRequestNumber: pr.number, changeId: change.id };
  }

  try {
    await verifyE2EWorkspaceBranch();
    if (!existingTargetSha) await createBranch(githubRepo.installationId, githubRepo.fullName, targetBranch, commitSha);
    else await updateBranch(githubRepo.installationId, githubRepo.fullName, targetBranch, commitSha);
    change.pushedAt = new Date().toISOString();
    change.pushedBranch = targetBranch;
    await repository.putChangeSet(change);

    const workspaceReconciled = targetBranch === baseBranch
      ? await reconcilePublishedWorkspace({
          workspaceId: input.workspaceId,
          branch: baseBranch,
          expectedHead: workspaceHeadBeforePublish,
          publishedHead: commitSha,
          files: change.files.map((file) => file.path),
        })
      : false;
    if (workspaceReconciled) {
      change.currentHead = commitSha;
      await repository.putChangeSet(change);
    }
    return { branch: targetBranch, head: commitSha, workspaceReconciled, changeId: change.id };
  } catch (error) {
    const statusCode = (error as Error & { status?: number }).status;
    if (liveE2ESessionBranch(session)) throw error;
    if (targetBranch !== baseBranch || (statusCode !== 403 && statusCode !== 422)) throw error;

    // Direct default-branch updates may be prohibited by rulesets/branch
    // protection even though the installation has contents+PR write access.
    // Preserve the user's work using an isolated branch and PR, never force.
    const fallback = safeBranch(`orlynx/publish-${task.id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-36)}`);
    const fallbackSha = await refSha(githubRepo.installationId, githubRepo.fullName, fallback);
    if (!fallbackSha) await createBranch(githubRepo.installationId, githubRepo.fullName, fallback, commitSha);
    else if (fallbackSha !== commitSha) throw new Error('Protected-branch fallback already exists with different work.');
    const pr = await createGitHubPullRequest(
      githubRepo.fullName,
      baseBranch,
      fallback,
      input.commitMessage || 'Orlynx verified changes',
      'Direct publication was blocked by GitHub branch policy, so Orlynx created this non-force fallback PR.',
      githubRepo.installationId,
    );
    change.pushedAt = new Date().toISOString();
    change.pushedBranch = fallback;
    change.pullRequestUrl = pr.url;
    change.pullRequestNumber = pr.number;
    await repository.putChangeSet(change);
    return {
      branch: fallback,
      head: commitSha,
      pullRequestUrl: pr.url,
      pullRequestNumber: pr.number,
      protectedBranchFallback: true,
      changeId: change.id,
    };
  }
}

export interface DeploymentTarget {
  changeId: string;
  commitSha: string;
  source: 'merged' | 'direct-publish';
}

// Bare "deploy it" is a verification continuation when the newest change is
// already published. Never re-push an old workspace commit after a PR merge.
// If the newest publication is still an open PR, require the merge first so
// deployment cannot silently bypass the review path.
export async function deploymentTargetForSession(sessionId: string): Promise<DeploymentTarget | null> {
  const changes = [...await controlPlaneRepository().listChangeSets(sessionId)].reverse();
  const latest = changes[0];
  if (!latest) return null;

  if (latest.pullRequestUrl && !latest.mergeCommitSha) {
    const label = latest.pullRequestNumber ? ` #${latest.pullRequestNumber}` : '';
    throw new Error(`Pull request${label} is published but not merged yet. Merge it before verifying production deployment.`);
  }
  if (latest.mergeCommitSha) {
    return { changeId: latest.id, commitSha: latest.mergeCommitSha, source: 'merged' };
  }
  if (latest.pushedAt && latest.commitSha) {
    return { changeId: latest.id, commitSha: latest.commitSha, source: 'direct-publish' };
  }
  return null;
}

export interface MergeResult {
  changeId: string;
  pullRequestNumber: number;
  pullRequestUrl?: string;
  merged: boolean;
  alreadyMerged?: boolean;
  checksPending?: boolean;
  mergeCommitSha: string | null;
  mergeMethod?: GitHubMergeMethod;
  message: string;
}

// Merge the session's current pull request through the control plane.
// Finds the newest change set carrying a PR number, verifies live PR state,
// and merges only when GitHub permits it. Required human approvals or
// running checks are reported, never bypassed or misreported as success.
export async function mergePublishedPullRequest(input: {
  sessionId: string;
  changeId?: string;
  method?: GitHubMergeMethod;
}): Promise<MergeResult> {
  const repository = controlPlaneRepository();
  const [session, changes] = await Promise.all([
    repository.getSession(input.sessionId),
    repository.listChangeSets(input.sessionId),
  ]);
  if (!session) throw new Error('Publication session is unavailable.');
  const ordered = [...changes].reverse();
  const latest = ordered[0];
  const change = input.changeId
    ? ordered.find((item) => item.id === input.changeId)
    : latest;
  if (!change) throw new Error('No pull request exists for this work yet. Publish it first, then merge.');
  if (!change.pullRequestNumber) {
    throw new Error(input.changeId
      ? 'The requested change set does not have a pull request yet. Publish it first, then merge.'
      : 'The latest work does not have a pull request yet. Publish the latest work first; Orlynx will not merge an older pull request implicitly.');
  }
  const method = input.method || change.mergeMethod || 'merge';

  // Crash recovery: a merge recorded durably before the receipt was emitted
  // must not trigger a second merge attempt.
  if (change.mergeCommitSha) {
    try {
      const live = await getGitHubPullRequest(session.project, change.pullRequestNumber);
      if (live.merged) {
        change.mergedAt ||= new Date().toISOString();
        await repository.putChangeSet(change);
        return {
          changeId: change.id, pullRequestNumber: change.pullRequestNumber,
          pullRequestUrl: change.pullRequestUrl, merged: true, alreadyMerged: true,
          mergeCommitSha: change.mergeCommitSha, mergeMethod: change.mergeMethod, message: live.url
            ? `Pull request #${change.pullRequestNumber} is already merged (${change.mergeCommitSha.slice(0, 7)}).`
            : `Pull request #${change.pullRequestNumber} is already merged.`,
        };
      }
    } catch {
      // Live verification failed; fall through to a fresh merge attempt so a
      // stale local record can never fake a merge.
    }
  }

  const result = await mergeGitHubPullRequest(session.project, change.pullRequestNumber, { method });
  if (result.merged && result.sha) {
    change.mergeCommitSha = result.sha;
    change.mergeMethod = method;
    change.mergedAt = new Date().toISOString();
    await repository.putChangeSet(change);
  }
  return {
    changeId: change.id, pullRequestNumber: change.pullRequestNumber,
    pullRequestUrl: change.pullRequestUrl, merged: result.merged,
    alreadyMerged: result.alreadyMerged, checksPending: result.checksPending,
    mergeCommitSha: result.sha, mergeMethod: method, message: result.message,
  };
}

export const publicationInternals = { parsePorcelainPaths, safeBranch, sha256, publicationCandidate };
