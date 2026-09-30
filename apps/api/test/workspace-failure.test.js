import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkspaceFailure } from '../src/workspace-failure.ts';

test('GitHub installation repository visibility failures cannot reroute or retry', () => {
  for (const detail of [
    'This repository is not available through the connected Orlynx GitHub App installation.',
    'This repository is not available through an installed GitHub App.',
    'E2B request failed (HTTP 401)',
    'Codespaces request failed (HTTP 403)',
    'Unauthorized runner request',
  ]) assert.equal(classifyWorkspaceFailure(new Error(detail)), 'authorization', detail);
});

test('configuration errors stop preparation while transport and stale resource failures can recover', () => {
  assert.equal(classifyWorkspaceFailure(new Error('E2B is not configured')), 'configuration');
  for (const detail of ['HTTP 502', 'HTTP 503', 'HTTP 504', 'Codespace lookup HTTP 404', 'SSH attempt timed out']) {
    assert.equal(classifyWorkspaceFailure(new Error(detail)), 'transient', detail);
  }
});
