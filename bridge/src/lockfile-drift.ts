import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** npm versions can rewrite peer flags without changing dependency resolution. */
export function onlyPeerMetadataChanged(before: string, after: string): boolean {
  try {
    const normalize = (text: string) => {
      const lock = JSON.parse(text);
      if (!lock || typeof lock !== 'object' || !lock.packages || !Number.isInteger(lock.lockfileVersion)) return null;
      for (const item of Object.values(lock.packages)) {
        if (item && typeof item === 'object') delete (item as Record<string, unknown>).peer;
      }
      return JSON.stringify(lock);
    };
    const original = normalize(before), current = normalize(after);
    return before !== after && original !== null && original === current;
  } catch { return false; }
}

/** Recover only an unstaged peer-only rewrite, with the exact patch retained. */
export function recoverPeerMetadata(repoRoot: string, recoveryRoot: string, git: (args: string[]) => string): string | undefined {
  if (git(['status', '--porcelain=v1']).trimEnd() !== ' M package-lock.json') return undefined;
  const before = git(['show', 'HEAD:package-lock.json']);
  const after = fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8');
  if (!onlyPeerMetadataChanged(before, after)) return undefined;
  const patch = git(['diff', 'HEAD', '--binary', '--', 'package-lock.json']);
  fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const recovery = path.join(recoveryRoot, `package-lock-peer-${crypto.randomUUID()}.patch`);
  fs.writeFileSync(recovery, patch, { mode: 0o600, flag: 'wx' });
  // Do not restore a newer edit that appeared while the patch was being saved.
  if (fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8') !== after
    || git(['status', '--porcelain=v1']).trimEnd() !== ' M package-lock.json') throw new Error('Lockfile changed during metadata recovery.');
  git(['restore', '--source=HEAD', '--worktree', '--', 'package-lock.json']);
  return recovery;
}
