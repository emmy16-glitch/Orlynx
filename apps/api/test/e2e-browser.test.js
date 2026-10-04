import test from 'node:test';
import assert from 'node:assert/strict';
import { browserE2EModel, browserE2EPlan, verifyReplay } from '../src/e2e-browser.ts';
test('browser plan refuses disabled or differently allowlisted production and generates only isolated targets', () => {
 const saved = {...process.env};
 try {
  process.env.ORLYNX_E2E_ENABLED = 'false';
  assert.throws(() => browserE2EPlan(), /disabled/);
  process.env.ORLYNX_E2E_ENABLED = 'true'; process.env.ORLYNX_E2E_REPOSITORY = 'another/repo';
  assert.throws(() => browserE2EPlan(), /allowlisted/);
  process.env.ORLYNX_E2E_REPOSITORY = 'emmy16-glitch/Orlynx';
  assert.deepEqual(browserE2EPlan(1760000000000), {branch:'orlynx-e2e/1760000000000',filename:'orlynx-e2e-1760000000000.txt',clientId:'browser-e2e-1760000000000'});
 } finally { for(const key of ['ORLYNX_E2E_ENABLED','ORLYNX_E2E_REPOSITORY']) { if(saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
test('durable replay fails on empty, repeated IDs, repeated sequence, reversed or invalid sequence', () => {
 assert.deepEqual(verifyReplay([{sequence:1,eventId:'a'},{sequence:3,eventId:'b'}]), {count:2,lastSequence:3});
 for(const events of [[],[{sequence:1,eventId:'a'},{sequence:2,eventId:'a'}],[{sequence:1,eventId:'a'},{sequence:1,eventId:'b'}],[{sequence:2,eventId:'a'},{sequence:1,eventId:'b'}],[{sequence:NaN,eventId:'a'}]]) assert.throws(() => verifyReplay(events));
});

test('browser verification requires an explicit model and rejects malformed values', () => {
 assert.equal(browserE2EModel('opencode/big-pickle'), 'opencode/big-pickle');
 for(const value of [undefined, null, '', 'auto', 'opencode/../../main', {}, 'opencode/model;cmd']) assert.throws(() => browserE2EModel(value), /Choose/);
});
