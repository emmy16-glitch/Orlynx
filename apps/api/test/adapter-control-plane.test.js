import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneFixture } from './helpers/control-plane.js';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { switchTaskAdapter, failoverCandidate, failoverRoute } from '../src/agent-handoff.ts';
import { createHarnessCheckpoint } from '../src/harness.ts';
import { registerBridgeSocket, authenticateBridgeSocket, unregisterBridgeSocket, publishLiveBridgeResult } from '../src/bridge-live.ts';
import { verifiedKnowledgeEdge } from '../src/knowledge-graph.ts';

async function switchFixture(t) {
  const f=await controlPlaneFixture(t);
  setControlPlaneRepositoryForTests(f.repository);
  const oldUrl=process.env.DATABASE_URL; process.env.DATABASE_URL='postgresql://test';
  t.after(()=>{setControlPlaneRepositoryForTests(undefined); if(oldUrl===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=oldUrl;});
  await f.repository.putWorkspace({id:'ws',sessionId:'s',userId:'u',projectId:'p',repositoryId:1,branch:'main',provider:'orlynx-runner',state:'ready',bridgeState:'ready',createdAt:f.now,updatedAt:f.now});
  for(const adapterId of ['opencode','mini-swe','cline']) await f.repository.putWorkspaceAgentAdapter({workspaceId:'ws',adapterId,state:'ready',supportedModels:['openai/test'],updatedAt:f.now});
  const harness=createHarnessCheckpoint({prompt:'fix tests',mode:'build',permission:'full',plane:'workspace'});
  harness.investigation={id:'inv',stage:'repairing',question:'tests failed',evidence:['failing test'],attempt:1,startedAt:f.now,updatedAt:f.now};
  await f.repository.putTask({...f.task('t','running'),workspaceId:'ws',adapterId:'opencode',modelId:'openai/test',mode:'build',permission:'full',harness});
  const socket={readyState:1,OPEN:1,send(raw){const frame=JSON.parse(raw);const result={reconciled:true,head:'a'.repeat(40),branch:'main',dirtyState:true,files:[{path:'src/auth.ts',status:'modified'}]};void f.repository.completeCommand(frame.commandId,'completed',result).then(()=>publishLiveBridgeResult(frame.commandId,{ok:true,result}));}};
  registerBridgeSocket('ws',socket);authenticateBridgeSocket('ws',socket);t.after(()=>unregisterBridgeSocket('ws',socket));
  return f;
}

test('manual OpenCode → Cline → mini-SWE switches one durable task and Investigation',async t=>{
  const {repository}=await switchFixture(t);
  for(const target of ['cline','mini-swe']) {
    const switched=await switchTaskAdapter('t',target);
    assert.equal(switched.id,'t');assert.equal(switched.runId,'run-t');assert.equal(switched.sessionId,'s');assert.equal(switched.workspaceId,'ws');
    assert.equal(switched.harness.investigation.id,'inv');assert.equal(switched.harness.agentHandoff.changedFiles[0].path,'src/auth.ts');
    assert.equal(switched.modelId,'openai/test');assert.equal(switched.harness.verification.status,'pending');
    // A fresh repository object/read simulates orchestrator state reload.
    assert.equal((await repository.getTask('t')).adapterId,target);
  }
  assert.equal((await repository.listTasks('s')).length,1);
  const events=await repository.listRunEvents('s','run-t',100);
  assert.equal(events.filter(event=>event.payload.sourceType==='handoff.created').length,2);
  assert.ok(events.every((event,i)=>!i || event.sequence>events[i-1].sequence));
});
test('failover excludes incompatible, attempted, stale and circuit-open adapters',async t=>{
  const {repository}=await switchFixture(t);let task=await repository.getTask('t');
  assert.equal(await failoverCandidate(task),'mini-swe');
  await repository.recordAdapterOutcome('ws','mini-swe',false);await repository.recordAdapterOutcome('ws','mini-swe',false);
  await repository.putWorkspaceAgentAdapter({workspaceId:'ws',adapterId:'mini-swe',state:'ready',updatedAt:new Date().toISOString()});
  assert.equal((await repository.getWorkspaceAgentAdapter('ws','mini-swe')).consecutiveFailures,2);
  assert.equal(await failoverCandidate(task),'cline');
  task.harness.adapterAttempts=['cline'];assert.equal(await failoverCandidate(task),undefined);
  await repository.recordAdapterOutcome('ws','mini-swe',true);assert.equal(await failoverCandidate(task),'mini-swe');
  task.modelId='opencode/free';assert.equal(await failoverCandidate(task),undefined);
});
test('transition lease is exclusive, expiring, and stale holders cannot release the replacement',async t=>{
  const {repository,db}=await controlPlaneFixture(t);
  const a=await repository.claimAdapterTransition('ws','a');assert.equal(a,1);
  assert.equal(await repository.claimAdapterTransition('ws','b'),null);
  await db.query("UPDATE adapter_transitions SET lease_until=now()-interval '1 second' WHERE workspace_id='ws'");
  assert.equal(await repository.claimAdapterTransition('ws','b'),2);
  await repository.releaseAdapterTransition('ws','a');assert.equal(await repository.claimAdapterTransition('ws','c'),null);
  await repository.releaseAdapterTransition('ws','b');assert.equal(await repository.claimAdapterTransition('ws','c'),3);
});
test('knowledge provenance invalidates only affected scoped facts and re-verification restores them',async t=>{
  const {repository,now}=await controlPlaneFixture(t);
  const edge=verifiedKnowledgeEdge({userId:'u',projectId:'p',subject:'auth-route',predicate:'implemented_by',object:'src/auth.ts',sourceTaskId:'t',commitSha:'a'.repeat(40),referencedFiles:['src/auth.ts'],evidenceRefs:['evt-test']},true);
  const dependent=verifiedKnowledgeEdge({...edge,subject:'frontend',predicate:'calls',object:'auth-route',referencedFiles:['frontend/package.json']},true);
  await repository.putKnowledgeEdge(dependent);
  await repository.putKnowledgeEdge(edge);assert.equal((await repository.listKnowledgeEdges('other','p')).length,0);
  await repository.invalidateKnowledgeEdges('u','p',['README.md'],'b'.repeat(40));assert.equal((await repository.listKnowledgeEdges('u','p'))[0].status,'active');
  await repository.invalidateKnowledgeEdges('u','p',['src/auth.ts'],'b'.repeat(40));assert.equal((await repository.listKnowledgeEdges('u','p'))[0].status,'stale');
  assert.equal((await repository.listKnowledgeEdges('u','p')).find(item=>item.id===dependent.id).status,'stale');
  await repository.putKnowledgeEdge({...edge,commitSha:'b'.repeat(40)});assert.equal((await repository.listKnowledgeEdges('u','p')).find(item=>item.id===edge.id).status,'active');
  assert.equal(verifiedKnowledgeEdge({...edge,commitSha:'wrong'},true),undefined);
  const lesson={id:'l',userId:'u',projectId:'p',scope:'repository',title:'auth',problem:'bug',lesson:'verified',evidence:['test'],tags:['auth'],successCount:1,confidence:.7,repositoryCommit:'a'.repeat(40),sourceTaskId:'t',referencedFiles:['src/auth.ts'],createdAt:now,updatedAt:now};
  await repository.putAgentLesson(lesson);assert.equal((await repository.listAgentLessons('u','p'))[0].repositoryCommit,'a'.repeat(40));
  await repository.invalidateAgentLessons('u','p',['l'],'file removed');assert.equal((await repository.listAgentLessons('u','p')).length,0);
  await repository.putAgentLesson({...lesson,repositoryCommit:'b'.repeat(40)});assert.equal((await repository.listAgentLessons('u','p')).length,1);
});

test('a crash after durable transition intent fences old task writes and progress',async t=>{
  const {repository}=await switchFixture(t);
  const old=await repository.getTask('t');old.harness.executionGeneration=0;
  assert.equal(await repository.beginAdapterTransition('t','cline','runtime-failure',1),true);
  old.state='completed';await repository.putTask(old);
  const recovered=await repository.getTask('t');assert.equal(recovered.state,'running');assert.equal(recovered.harness.adapterTransition.target,'cline');
  await repository.touchTaskHeartbeat(old.id,0,new Date().toISOString());assert.equal((await repository.getTask('t')).harness.executionGeneration,1);
  const switched=await switchTaskAdapter('t','cline','recovery');assert.equal(switched.id,'t');assert.equal(switched.state,'queued');
});
test('an uncertain cancellation blocks with task and workspace intact',async t=>{
  const {repository}=await switchFixture(t);
  // Replace the bridge with one that reports an unresolved writer.
  const socket={readyState:1,OPEN:1,send(raw){const frame=JSON.parse(raw);void repository.completeCommand(frame.commandId,'failed',{error:'workspace_conflict'}).then(()=>publishLiveBridgeResult(frame.commandId,{ok:false,error:'workspace_conflict: previous writer alive'}));}};
  registerBridgeSocket('ws',socket);authenticateBridgeSocket('ws',socket);t.after(()=>unregisterBridgeSocket('ws',socket));
  await assert.rejects(switchTaskAdapter('t','cline'),/workspace_conflict/);
  const blocked=await repository.getTask('t');assert.equal(blocked.state,'waiting_input');assert.equal(blocked.harness.investigation.stage,'blocked');assert.equal(blocked.workspaceId,'ws');assert.equal(blocked.harness.adapterTransition.target,'cline');
});

test('a stopped direct response switches into the existing workspace without replacing task identity',async t=>{
  const {repository}=await switchFixture(t);const task=await repository.getTask('t');task.plane='direct';task.workspaceId='direct';await repository.putTask(task);
  const switched=await switchTaskAdapter('t','cline');assert.equal(switched.id,'t');assert.equal(switched.runId,'run-t');assert.equal(switched.plane,'workspace');assert.equal(switched.workspaceId,'ws');assert.equal(switched.harness.investigation.id,'inv');
});


test('failover preserves task identity while visibly routing only to a catalog-proven free model',async t=>{
  const {repository}=await switchFixture(t);const task=await repository.getTask('t');task.modelId='opencode/free';await repository.putTask(task);
  const free='openrouter/poolside/laguna-s-2.1:free';
  await repository.putWorkspaceAgentAdapter({workspaceId:'ws',adapterId:'mini-swe',state:'ready',supportedModels:[free],freeModels:[],updatedAt:new Date().toISOString()});
  assert.equal(await failoverRoute(task),undefined);
  await repository.putWorkspaceAgentAdapter({workspaceId:'ws',adapterId:'mini-swe',state:'ready',supportedModels:[free],freeModels:[free],updatedAt:new Date().toISOString()});
  const route=await failoverRoute(task);assert.deepEqual(route,{adapterId:'mini-swe',modelId:free});
  const continued=await switchTaskAdapter(task.id,route.adapterId,'runtime-failure',route.modelId);assert.equal(continued.id,'t');assert.equal(continued.modelId,free);assert.equal(continued.harness.investigation.id,'inv');
  const events=await repository.listRunEvents('s','run-t',100);assert.ok(events.some(event=>event.payload.sourceType==='handoff.created' && event.payload.previousModel==='opencode/free' && event.payload.modelId===free));
});
