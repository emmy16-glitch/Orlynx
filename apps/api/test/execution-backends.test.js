import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  githubActionsVerificationEligible,
  workflowDispatchEnabled,
  workflowScore,
} from '../src/github-actions.ts';
import { fallbackWorkspaceProviderId } from '../src/workspace-providers.ts';

describe('GitHub Actions verification backend', () => {
  it('only accepts workflows that explicitly support workflow_dispatch', () => {
    assert.equal(workflowDispatchEnabled('on:\n  push:\n  workflow_dispatch:\n'), true);
    assert.equal(workflowDispatchEnabled('on: [push, workflow_dispatch]'), true);
    assert.equal(workflowDispatchEnabled('on:\n  push:\n'), false);
    assert.equal(workflowDispatchEnabled('# workflow_dispatch:\non:\n  push:\n'), false);
  });

  it('prefers CI/test workflows over deploy workflows', () => {
    assert.ok(
      workflowScore({ name: 'CI verification', path: '.github/workflows/ci.yml' })
      > workflowScore({ name: 'Deploy production', path: '.github/workflows/deploy.yml' }),
    );
  });

  it('uses Actions for verification-only Build work, never mutation work', () => {
    assert.equal(githubActionsVerificationEligible({
      prompt: 'run the tests and build',
      mode: 'build',
      harness: {
        phase: 'routing', step: 0, stepBudget: 30, steeringRevision: 0, inbox: [], toolFamilies: [],
        verification: { required: ['tests', 'build'], satisfied: [], missing: ['tests', 'build'], status: 'pending' },
        salvageAttempts: 0, updatedAt: new Date().toISOString(),
      },
    }), true);

    assert.equal(githubActionsVerificationEligible({
      prompt: 'fix the failing tests and build',
      mode: 'build',
      harness: {
        phase: 'routing', step: 0, stepBudget: 30, steeringRevision: 0, inbox: [], toolFamilies: [],
        verification: { required: ['changes', 'tests', 'build'], satisfied: [], missing: ['changes', 'tests', 'build'], status: 'pending' },
        salvageAttempts: 0, updatedAt: new Date().toISOString(),
      },
    }), false);
  });
});

describe('workspace provider failover', () => {
  it('does not loop back into an already attempted provider', () => {
    const prior = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = 'e2b_test';
    try {
      assert.equal(fallbackWorkspaceProviderId('github-codespaces', ['github-codespaces']), 'e2b');
      assert.equal(fallbackWorkspaceProviderId('e2b', ['e2b']), 'github-codespaces');
      assert.equal(fallbackWorkspaceProviderId('e2b', ['e2b', 'github-codespaces']), null);
    } finally {
      if (prior === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = prior;
    }
  });
});
