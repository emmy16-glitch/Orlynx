// Change Review Service — PDF §5.2: immutable base SHA, never silently overwrite.
import { v4 as uuid } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChangeSet, ChangedFile } from '@orlynx/shared';
import { store } from './store.js';
import { configureCommitIdentity, headSha, repoRoot } from './github.js';
import { pushGitHubRepository } from './github.js';
import { emit } from './events.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';

export function createChangeSet(sessionId: string, project: string, files: ChangedFile[], runId?: string, baseSha?: string): ChangeSet {
  const cs: ChangeSet = {
    id: `chg_${uuid().slice(0, 8)}`, sessionId, runId,
    baseSha: baseSha || (durableStorageConfigured() ? '' : headSha(project)), files,
    reviewState: 'pending', createdAt: new Date().toISOString(),
  };
  (store.db.changes[sessionId] ||= []).push(cs);
  store.save();
  if (durableStorageConfigured()) void controlPlaneRepository().putChangeSet(cs);
  emit(sessionId, 'changes.updated', { changeId: cs.id, count: files.length }, runId);
  return cs;
}

export function currentChanges(sessionId: string): ChangeSet[] {
  return store.db.changes[sessionId] || [];
}

export function approve(changeId: string): ChangeSet | undefined {
  for (const list of Object.values(store.db.changes)) {
    const c = list.find((x) => x.id === changeId);
    if (c) { c.reviewState = 'approved'; store.save(); if (durableStorageConfigured()) void controlPlaneRepository().putChangeSet(c); return c; }
  }
}

export function commit(sessionId: string, project: string, changeId: string, message: string): ChangeSet {
  const list = store.db.changes[sessionId] || [];
  const cs = list.find((x) => x.id === changeId);
  if (!cs) throw new Error('changeset not found');
  if (cs.reviewState !== 'approved') throw new Error('approve before commit (safe-by-default)');
  const nowHead = headSha(project);
  if (nowHead !== cs.baseSha) {
    cs.reviewState = 'stale';
    store.save();
    emit(sessionId, 'state.delta', { conflict: true, base: cs.baseSha, head: nowHead });
    throw new Error('Repository changed since work started. Review before committing.');
  }
  const root = repoRoot(project);
  configureCommitIdentity(project);
  for (const f of cs.files) {
    const target = path.normalize(path.join(root, f.path));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error('path escape denied');
    if (f.action === 'delete') { if (fs.existsSync(target)) fs.rmSync(target); }
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.after ?? ''); }
  }
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message || 'Orlynx update', '--allow-empty'], { cwd: root, stdio: 'ignore' });
  const sha = headSha(project);
  cs.reviewState = 'committed'; cs.commitSha = sha; cs.currentHead = sha;
  store.save();
  emit(sessionId, 'receipt.created', { changeId, commitSha: sha, message });
  return cs;
}

export async function push(sessionId: string, project: string, branch: string, changeId: string, installationId?: number): Promise<ChangeSet> {
  const cs = (store.db.changes[sessionId] || []).find((change) => change.id === changeId);
  if (!cs) throw new Error('changeset not found');
  if (cs.reviewState !== 'committed') throw new Error('commit and approve this changeset before pushing');
  if (cs.pushedAt) return cs;
  await pushGitHubRepository(project, branch, installationId);
  cs.pushedAt = new Date().toISOString();
  store.save();
  emit(sessionId, 'receipt.created', { changeId, pushedAt: cs.pushedAt, branch });
  return cs;
}
