import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertLiveE2ESession,
  liveE2EEnabled,
  liveE2ERepositoryAllowed,
  validLiveE2EBranch,
} from '../src/e2e-safety.ts';

const enabled = {
  ORLYNX_E2E_ENABLED: 'true',
  ORLYNX_E2E_REPOSITORY: 'emmy16-glitch/Orlynx',
};

test('live E2E requires explicit enablement and exact repository allowlist', () => {
  assert.equal(liveE2EEnabled({}), false);
  assert.equal(liveE2EEnabled(enabled), true);
  assert.equal(liveE2ERepositoryAllowed('emmy16-glitch/Orlynx', enabled), true);
  assert.equal(liveE2ERepositoryAllowed('EMMY16-GLITCH/orlynx', enabled), true);
  assert.equal(liveE2ERepositoryAllowed('emmy16-glitch/other', enabled), false);
  assert.equal(liveE2ERepositoryAllowed('emmy16-glitch/Orlynx', { ORLYNX_E2E_ENABLED: 'true' }), false);
});

test('live E2E branch namespace can never select main or arbitrary branches', () => {
  assert.equal(validLiveE2EBranch('orlynx-e2e/1760000000000'), true);
  assert.equal(validLiveE2EBranch('orlynx-e2e/1760000000000-retry-1'), true);
  for (const branch of ['main', 'master', 'orlynx/test', 'orlynx-e2e/main', 'orlynx-e2e/../../main', 'orlynx-e2e/']) {
    assert.equal(validLiveE2EBranch(branch), false, branch);
  }
});

test('live E2E session assertion fails closed', () => {
  assert.doesNotThrow(() => assertLiveE2ESession('emmy16-glitch/Orlynx', 'orlynx-e2e/1760000000000', enabled));
  assert.throws(() => assertLiveE2ESession('emmy16-glitch/Orlynx', 'main', enabled), /orlynx-e2e/);
  assert.throws(() => assertLiveE2ESession('emmy16-glitch/other', 'orlynx-e2e/1760000000000', enabled), /allowlisted/);
  assert.throws(() => assertLiveE2ESession('emmy16-glitch/Orlynx', 'orlynx-e2e/1760000000000', { ...enabled, ORLYNX_E2E_ENABLED: 'false' }), /disabled/);
});

test('routes enforce the same repository and branch guard at creation and publication', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /liveE2ERepositoryAllowed\(s\.project\)/);
  assert.match(routes, /validLiveE2EBranch\(requestedBranch\)/);
  assert.match(routes, /assertLiveE2ESession\(session\.project, originalBranch\)/);
  assert.match(routes, /Live E2E sessions may publish only their isolated E2E branch/);
});
