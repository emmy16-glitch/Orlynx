import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('workspace bridge discovers bounded verification artifacts without reading arbitrary paths', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');

  assert.match(bridge, /case 'verification\.artifacts'/);
  assert.match(bridge, /VERIFICATION_ARTIFACT_ROOTS/);
  for (const root of ['test-results', 'playwright-report', 'blob-report', 'cypress/screenshots', 'cypress/videos', 'artifacts']) {
    assert.match(bridge, new RegExp(root.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  }
  assert.match(bridge, /error-context\.md/);
  assert.match(bridge, /trace\.zip/);
  assert.match(bridge, /maxScannedFiles = 160/);
  assert.match(bridge, /\.slice\(0, 40\)/);
  assert.match(bridge, /stat\.isSymbolicLink\(\)/);
  assert.match(bridge, /artifact\.excerpt = redactSecrets/);
});

test('verification failure path records artifact evidence before model reflection', () => {
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  const harness = fs.readFileSync(new URL('../src/harness.ts', import.meta.url), 'utf8');

  const discovery = gateway.indexOf("'verification.artifacts'");
  const reflection = gateway.indexOf('prepareReflection(task.harness, recent');
  assert.ok(discovery >= 0, 'artifact discovery command is wired into the gateway');
  assert.ok(reflection > discovery, 'artifact evidence is recorded before the reflection checkpoint is prepared');
  assert.match(gateway, /scope: 'verification-artifacts'/);
  assert.match(gateway, /signature/);
  assert.match(gateway, /artifacts\.slice\(0, 8\)/);

  assert.match(harness, /classifyVerificationFailure/);
  assert.match(harness, /verificationFailureClass/);
  assert.match(harness, /artifactEvidence/);
  assert.match(harness, /rerun the narrow failing test\/spec/);
});
