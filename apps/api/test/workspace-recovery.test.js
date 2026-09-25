import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceNeedsSshRebuild, workspaceConnectionMatchesRevision } from '../src/workspaces.ts';

test('missing SSH server bootstrap failures request a Codespace rebuild', () => {
  assert.equal(workspaceNeedsSshRebuild('Codespace bootstrap failed: failed to start SSH server'), true);
  assert.equal(workspaceNeedsSshRebuild('error getting ssh server details'), true);
  assert.equal(workspaceNeedsSshRebuild('GitHub Codespace did not become ready before the startup timeout.'), false);
});

test('bridge runtime revision marker distinguishes current and stale bridges', () => {
  assert.equal(workspaceConnectionMatchesRevision('bridge-abc123-current', 'abc123'), true);
  assert.equal(workspaceConnectionMatchesRevision('bridge-oldrev-current', 'abc123'), false);
  assert.equal(workspaceConnectionMatchesRevision(undefined, 'abc123'), false);
});
