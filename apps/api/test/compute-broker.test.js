import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTargetQuarantined,
  noteComputeFailure,
  noteComputeSuccess,
  resetComputeBrokerForTests,
  selectWorkspaceProvider,
  workspaceProviderScores,
} from '../src/compute-broker.ts';

function withEnv(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    resetComputeBrokerForTests();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('compute broker quarantines repeated provider failures and routes to the next configured target', async (t) => {
  withEnv(t, {
    E2B_API_KEY: 'test-key',
    ORLYNX_RUNNER_HOSTS: undefined,
    ORLYNX_RUNNER_URL: undefined,
    ORLYNX_RUNNER_TOKEN: undefined,
    ORLYNX_COMPUTE_QUARANTINE_FAILURES: '2',
    ORLYNX_COMPUTE_QUARANTINE_MS: '60000',
  });
  resetComputeBrokerForTests();

  assert.equal(await selectWorkspaceProvider(), 'github-codespaces');

  noteComputeFailure('github-codespaces', 'temporary GitHub failure');
  assert.equal(computeTargetQuarantined('github-codespaces'), false);
  noteComputeFailure('github-codespaces', 'temporary GitHub failure');
  assert.equal(computeTargetQuarantined('github-codespaces'), true);

  assert.equal(await selectWorkspaceProvider(), 'e2b');

  noteComputeSuccess('github-codespaces', 250);
  assert.equal(computeTargetQuarantined('github-codespaces'), false);
  assert.equal(await selectWorkspaceProvider(), 'github-codespaces');
});

test('compute broker never retries a provider already attempted in the same preparation', async (t) => {
  withEnv(t, {
    E2B_API_KEY: 'test-key',
    ORLYNX_RUNNER_HOSTS: '[{"id":"runner-a","url":"https://runner-a.example.com"}]',
    ORLYNX_RUNNER_TOKEN: 'runner-token',
  });
  resetComputeBrokerForTests();

  const selected = await selectWorkspaceProvider({
    attempted: ['github-codespaces', 'e2b'],
  });
  assert.equal(selected, 'orlynx-runner');
});

test('direct runtime uses the same quarantine mechanism as workspace providers', (t) => {
  withEnv(t, {
    ORLYNX_COMPUTE_QUARANTINE_FAILURES: '2',
    ORLYNX_COMPUTE_QUARANTINE_MS: '60000',
  });
  resetComputeBrokerForTests();

  noteComputeFailure('direct-runtime', 'HTTP 502');
  assert.equal(computeTargetQuarantined('direct-runtime'), true);

  noteComputeSuccess('direct-runtime', 100);
  assert.equal(computeTargetQuarantined('direct-runtime'), false);
});

test('success and sticky bonuses never make an attempted provider eligible again', async (t) => {
  withEnv(t, { E2B_API_KEY: 'test-key', ORLYNX_RUNNER_URL: undefined, ORLYNX_RUNNER_HOSTS: undefined, ORLYNX_RUNNER_TOKEN: undefined });
  resetComputeBrokerForTests();
  noteComputeSuccess('github-codespaces', 1);
  noteComputeSuccess('e2b', 1);
  assert.equal(await selectWorkspaceProvider({ attempted: ['github-codespaces', 'e2b'], preferredProvider: 'github-codespaces' }), null);
});

test('all targets quarantined produces no provider instead of an unhealthy fallback loop', async (t) => {
  withEnv(t, { E2B_API_KEY: 'test-key', ORLYNX_RUNNER_URL: undefined, ORLYNX_RUNNER_HOSTS: undefined, ORLYNX_RUNNER_TOKEN: undefined, ORLYNX_COMPUTE_QUARANTINE_FAILURES: '1' });
  resetComputeBrokerForTests();
  noteComputeFailure('github-codespaces', '502');
  noteComputeFailure('e2b', '502');
  assert.equal(await selectWorkspaceProvider(), null);
});

test('broker scores keep healthy existing preference sticky without making it absolute', (t) => {
  withEnv(t, { E2B_API_KEY: 'test-key' });
  resetComputeBrokerForTests();

  const preferred = workspaceProviderScores({ preferredProvider: 'e2b' });
  const e2b = preferred.find((item) => item.id === 'e2b');
  const codespaces = preferred.find((item) => item.id === 'github-codespaces');
  assert.ok(e2b && codespaces);
  assert.ok(e2b.score >= codespaces.score - 5);

  noteComputeFailure('e2b', 'failed');
  noteComputeFailure('e2b', 'failed');
  const afterFailure = workspaceProviderScores({ preferredProvider: 'e2b' });
  assert.ok(afterFailure.find((item) => item.id === 'github-codespaces').score > afterFailure.find((item) => item.id === 'e2b').score);
});


test('Build admission keeps healthy workspaces sticky while consulting the broker', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /selectWorkspaceProvider\(\{[\s\S]*taskText: String\(text\)/);
  assert.match(routes, /preserveHealthyExisting: true/);
  assert.doesNotMatch(routes, /workspaceShouldAdoptPreferredRunner\(workspace/);
});
