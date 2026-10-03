import test from 'node:test';
import assert from 'node:assert/strict';
import { productionHealthSample } from '../src/production-observer.ts';
import { controlPlaneFixture } from './helpers/control-plane.js';
test('production evidence requires successful health and the exact published commit',async()=>{
  const sha='a'.repeat(40);const sample=body=>productionHealthSample(sha,['https://example.invalid/health'],async()=>new Response(JSON.stringify(body)));
  assert.equal((await sample({alive:true,commit:sha}))[0].commitMatches,true);
  assert.equal((await sample({alive:true,commit:'b'.repeat(40)}))[0].commitMatches,false);
  assert.equal((await sample({alive:false,commit:sha}))[0].healthy,false);
  assert.equal((await productionHealthSample(sha,['https://example.invalid'],async()=>{throw new Error('offline');}))[0].healthy,false);
});
test('production observation reclaim and learning replay are fenced and idempotent',async t=>{
  const {repository,db,now}=await controlPlaneFixture(t);
  const record={id:'obs',sessionId:'s',userId:'u',projectId:'p',commitSha:'a'.repeat(40),state:'pending',startedAt:now,observeUntil:now,samples:[]};
  await repository.enqueueProductionObservation(record);await repository.enqueueProductionObservation(record);
  assert.equal((await repository.claimProductionObservations('a')).length,1);assert.equal((await repository.claimProductionObservations('b')).length,0);
  await db.query("UPDATE production_observations SET lease_until=now()-interval '1 second'");
  assert.equal((await repository.claimProductionObservations('b')).length,1);assert.equal(await repository.completeProductionObservation({...record,state:'healthy'},'a'),false);
  const lesson={id:'lesson',userId:'u',projectId:'p',scope:'repository',title:'deployment',problem:'deploy',lesson:'observed healthy',evidence:['exact sha'],tags:[],sourceTaskId:'deploy:'+record.commitSha,repositoryCommit:record.commitSha,successCount:1,confidence:.7,createdAt:now,updatedAt:now};
  await repository.putAgentLesson(lesson);await repository.putAgentLesson(lesson);assert.equal((await repository.listAgentLessons('u','p'))[0].successCount,1);
  assert.equal(await repository.completeProductionObservation({...record,state:'healthy'},'b'),true);assert.equal((await repository.claimProductionObservations('c')).length,0);
});
