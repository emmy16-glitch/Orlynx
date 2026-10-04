import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertLiveE2ESession,
  assertLiveE2EPublication,
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
  assert.match(routes, /assertLiveE2EPublication\(session, originalBranch/);
  assert.match(routes, /persistE2EIsolation\(durable, workspace, requestedBranch/);
  const publisher = fs.readFileSync(new URL('../src/publisher.ts', import.meta.url), 'utf8');
  assert.match(publisher, /assertLiveE2EPublication\(session, targetBranch, strategy/);
  assert.match(publisher, /await verifyE2EWorkspaceBranch\(\);\n    if \(!existingTargetSha\)/);
  assert.match(publisher, /if \(e2ePublication\) throw error/);
});


test('E2E publication rejects retargeting, PR strategies, lost session identity and workspace drift', () => {
  const branch = 'orlynx-e2e/1760000000000';
  const session = { project: 'emmy16-glitch/Orlynx', branch, checkpoint: { liveE2EBranch: branch } };
  assert.doesNotThrow(() => assertLiveE2EPublication(session, branch, 'direct', branch, enabled));
  for (const target of ['main', 'master', 'orlynx/test', 'orlynx-e2e/1760000000001']) {
    assert.throws(() => assertLiveE2EPublication(session, target, 'direct', branch, enabled), /isolated/);
    assert.throws(() => assertLiveE2EPublication(session, branch, 'direct', target, enabled), /workspace branch/);
    assert.throws(() => assertLiveE2EPublication({ ...session, branch: target }, target, 'direct', target, enabled), /isolated/);
  }
  assert.throws(() => assertLiveE2EPublication(session, branch, 'pull-request', branch, enabled), /direct/);
  assert.throws(() => assertLiveE2EPublication(session, branch, 'direct', '', enabled), /workspace branch/);
  assert.throws(() => assertLiveE2EPublication(session, branch, 'direct', branch, { ...enabled, ORLYNX_E2E_ENABLED: 'false' }), /disabled/);
  assert.throws(() => assertLiveE2EPublication({ ...session, project: 'other/repo' }, branch, 'direct', branch, enabled), /allowlisted/);
  assert.throws(() => assertLiveE2EPublication({ project: session.project, branch: 'orlynx-e2e/main' }, 'main', 'direct', 'main', enabled), /namespace/);
  assert.throws(() => assertLiveE2EPublication({ project: session.project, branch: 'main' }, 'main', 'direct', branch, enabled), /isolated/);
  assert.doesNotThrow(() => assertLiveE2EPublication({ project: session.project, branch: 'main' }, 'main', 'direct', 'main', {}));
});
