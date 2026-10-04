import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureE2ERemoteBranch, browserE2EModel, browserE2EPlan, verifyReplay } from '../src/e2e-browser.ts';
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

test('E2E remote preparation rejects unsafe targets before API calls and preserves HEAD without commits', async () => {
 const env={ORLYNX_E2E_ENABLED:'true',ORLYNX_E2E_REPOSITORY:'emmy16-glitch/Orlynx'}, head='a'.repeat(40), branch='orlynx-e2e/1760000000000';
 let calls=[];
 const api={read:async()=>{calls.push('read');return null;},create:async(b,h)=>{calls.push([b,h]);return h;}};
 for(const b of ['main','master','orlynx/test']) await assert.rejects(ensureE2ERemoteBranch('emmy16-glitch/Orlynx',b,head,api,env));
 await assert.rejects(ensureE2ERemoteBranch('other/repo',branch,head,api,env));
 assert.deepEqual(calls,[]);
 await ensureE2ERemoteBranch('emmy16-glitch/Orlynx',branch,head,api,env);
 assert.deepEqual(calls,['read',[branch,head]]);
 await assert.rejects(ensureE2ERemoteBranch('emmy16-glitch/Orlynx',branch,head,{...api,read:async()=> 'b'.repeat(40)},env),/does not match/);
 await assert.rejects(ensureE2ERemoteBranch('emmy16-glitch/Orlynx',branch,head,{...api,read:async()=>{throw new Error('HTTP 403');}},env),/403/);
});
