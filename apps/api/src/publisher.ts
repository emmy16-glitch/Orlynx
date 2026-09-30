import crypto from 'node:crypto';
import type { ChangeSet, ChangedFile, TaskRecord } from '@orlynx/shared';
import { bridgeRequest } from './bridge-rpc.js';
import {
  createGitHubPullRequest,
  githubInstallationApiRequest,
  githubInstallationPermissionStatus,
  githubRepositoryById,
} from './github.js';
import { controlPlaneRepository } from './storage.js';

export type PublicationStrategy = 'direct' | 'pull-request';

export interface PublicationResult {
  branch: string;
  head: string;
  alreadyPublished?: boolean;
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

function sha256(value: string): string {
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
    const nonPublishMissing = task.harness.verification.missing.filter((item) => item !== 'publish');
    if (nonPublishMissing.length) continue;
    return { change, task };
  }
  throw new Error('No verified change set is ready to publish.');
}

async function validatedWorkspaceFiles(
  workspaceId: string,
  change: ChangeSet,
  task: TaskRecord,
): Promise<{ files: Array<{ file: ChangedFile; content?: string }>; status: GitStatus }> {
  const status = await bridgeRequest<GitStatus>(workspaceId, 'git.status', {}, 30_000);
  const head = String(status.head || '');
  if (!head || !change.baseSha) throw new Error('Publication cannot verify the workspace base commit.');
  if (head !== change.baseSha) {
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

  const validated: Array<{ file: ChangedFile; content?: string }> = [];
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

    const read = await bridgeRequest<{ content?: string }>(workspaceId, 'fs.read', { path: file.path }, 15_000);
    const content = String(read.content ?? '');
    const expectedHash = file.afterHash || (typeof file.after === 'string' ? sha256(file.after) : '');
    if (!expectedHash) throw new Error(`Publication lacks observed contents for ${file.path}. Re-run the change capture.`);
    if (sha256(content) !== expectedHash) {
      throw new Error(`File changed after verification: ${file.path}. Re-verify before publishing.`);
    }
    validated.push({ file, content });
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
  files: Array<{ file: ChangedFile; content?: string }>;
  message: string;
}): Promise<string> {
  const parent = await githubInstallationApiRequest<GitCommit>(
    input.installationId,
    `/repos/${input.project}/git/commits/${encodeURIComponent(input.parentSha)}`,
  );
  const baseTree = String(parent.tree?.sha || '');
  if (!baseTree) throw new Error('GitHub did not return the base tree for publication.');

  const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
  for (const item of input.files) {
    if (item.file.action === 'delete') {
      tree.push({ path: item.file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await githubInstallationApiRequest<GitObject>(
      input.installationId,
      `/repos/${input.project}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: Buffer.from(String(item.content ?? ''), 'utf8').toString('base64'),
          encoding: 'base64',
        }),
      },
    );
    if (!blob.sha) throw new Error(`GitHub did not create a blob for ${item.file.path}.`);
    tree.push({ path: item.file.path, mode: '100644', type: 'blob', sha: blob.sha });
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

  const { change, task } = publicationCandidate(changes, tasks, input.runId);
  const nonPublishMissing = task.harness?.verification.missing.filter((item) => item !== 'publish') || [];
  if (nonPublishMissing.length) {
    throw new Error(`Verification is incomplete: ${nonPublishMissing.join(', ')}.`);
  }

  const { files, status } = await validatedWorkspaceFiles(input.workspaceId, change, task);
  const githubRepo = await githubRepositoryById(workspace.userId, workspace.repositoryId);
  if (githubRepo.fullName.toLowerCase() !== session.project.toLowerCase()) {
    throw new Error('Connected GitHub authorization does not match this conversation repository.');
  }
  const permissions = await githubInstallationPermissionStatus(githubRepo.installationId);
  if (!permissions.publishReady) {
    throw new Error(`GitHub App publication permissions are incomplete: ${permissions.missingPublish.join(', ')}.`);
  }

  const baseBranch = safeBranch(session.branch);
  const targetBranch = safeBranch(input.targetBranch || baseBranch);
  const baseRemoteSha = await refSha(githubRepo.installationId, githubRepo.fullName, baseBranch);
  if (!baseRemoteSha) throw new Error(`GitHub branch ${baseBranch} does not exist.`);
  if (baseRemoteSha !== change.baseSha) {
    throw new Error(`GitHub ${baseBranch} moved since this work began. Refresh/reconcile before publishing.`);
  }

  const existingTargetSha = await refSha(githubRepo.installationId, githubRepo.fullName, targetBranch);
  if (existingTargetSha && existingTargetSha !== change.baseSha) {
    if (change.commitSha && existingTargetSha === change.commitSha) {
      return { branch: targetBranch, head: existingTargetSha, alreadyPublished: true, changeId: change.id };
    }
    throw new Error(`GitHub branch ${targetBranch} diverged from the verified base. Refusing a non-fast-forward publication.`);
  }

  const commitSha = change.commitSha || await createCommitFromFiles({
    installationId: githubRepo.installationId,
    project: githubRepo.fullName,
    parentSha: change.baseSha,
    files,
    message: input.commitMessage || `Orlynx verified update for ${session.project}`,
  });
  change.reviewState = 'committed';
  change.commitSha = commitSha;
  change.currentHead = commitSha;
  await repository.putChangeSet(change);

  const strategy = input.strategy || 'direct';
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
    if (!existingTargetSha) await createBranch(githubRepo.installationId, githubRepo.fullName, targetBranch, commitSha);
    else await updateBranch(githubRepo.installationId, githubRepo.fullName, targetBranch, commitSha);
    change.pushedAt = new Date().toISOString();
    change.pushedBranch = targetBranch;
    await repository.putChangeSet(change);
    return { branch: targetBranch, head: commitSha, changeId: change.id };
  } catch (error) {
    const statusCode = (error as Error & { status?: number }).status;
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

export const publicationInternals = { parsePorcelainPaths, safeBranch, sha256 };
