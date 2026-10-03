import test from 'node:test';
import assert from 'node:assert/strict';
import { publishIntentFor, publishTargetBranchFor, deployIntentFor } from '../src/direct-chat.ts';
import { createHarnessCheckpoint, verificationRequirementsFor, verifyHarness, steeringActionFor } from '../src/harness.ts';

for (const prompt of ['ship it', 'ship this', 'publish the changes', 'publish changes', 'apply those fixes to main', 'apply these fixes to master', 'make sure everything is in main', 'make sure the changes are in main', 'get this live', 'get it live']) {
  for (const variant of [prompt, 'Please '+prompt+'!']) test(`publication follow-up: ${variant}`, () => {
    assert.equal(publishIntentFor(variant), 'direct');
    assert.equal(steeringActionFor(variant), 'append', 'follow-up stays on the active task');
    assert.ok(verificationRequirementsFor(variant).includes('publish'));
    const harness = createHarnessCheckpoint({prompt:variant,mode:'build',permission:'full',plane:'workspace'});
    assert.equal(verifyHarness(harness, []).verification.status, 'needs_more_work', 'completion prose cannot prove publication');
  });
}
test('live intent requires deployment evidence and explicit branch targets are preserved', () => {
  for (const prompt of ['get this live', 'get it live']) {
    assert.equal(deployIntentFor(prompt), true);
    assert.ok(verificationRequirementsFor(prompt).includes('deployment'));
  }
  assert.equal(publishTargetBranchFor('apply those fixes to main', 'feature/demo'), 'main');
  assert.equal(publishTargetBranchFor('apply these fixes to master', 'feature/demo'), 'master');
});
for (const prompt of ["don't publish the changes", 'do not ship it', 'never get this live', 'do not open a PR', "don't create a pull request", 'never make a PR', 'explain how to ship it', 'what does get this live mean?', 'implement a ship it button']) test(`non-authorizing publication language: ${prompt}`, () => {
  assert.equal(publishIntentFor(prompt), null);
});
test('negated deployment is not deployment intent', () => {
  for (const prompt of ["don't deploy", 'do not deploy it', 'never deploy this']) assert.equal(deployIntentFor(prompt), false);
});
