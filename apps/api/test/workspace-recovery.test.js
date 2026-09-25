import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceNeedsSshRebuild } from '../src/workspaces.ts';

test('missing SSH server bootstrap failures request a Codespace rebuild', () => {
  assert.equal(workspaceNeedsSshRebuild('Codespace bootstrap failed: failed to start SSH server'), true);
  assert.equal(workspaceNeedsSshRebuild('error getting ssh server details'), true);
  assert.equal(workspaceNeedsSshRebuild('GitHub Codespace did not become ready before the startup timeout.'), false);
});
