import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentFailure, adapterEligible, compatibleCapabilities, currentExecution, taskCapabilities } from '../src/adapter-policy.ts';
import { handoffCheckpoint } from '../src/agent-handoff.ts';
import { createHarnessCheckpoint, verifyHarness } from '../src/harness.ts';
import { getAgentAdapter } from '../src/agent-runtime.ts';

for (const [detail, code, candidate] of [
  ['provider 429 rate limit', 'provider_rate_limit', true], ['401 unauthorized', 'provider_auth', false],
  ['runtime crashed', 'runtime_crash', true], ['stream stalled', 'stream_stall', true],
  ['workspace unavailable', 'workspace_unavailable', false], ['permission denied by policy', 'permission_denied', false],
  ['workspace conflict: prior writer still running', 'workspace_conflict', false], ['user cancelled by user', 'user_cancelled', false],
]) test(`normalized failure: ${code}`, () => { const result = classifyAgentFailure(detail); assert.equal(result.code, code); assert.equal(result.adapterFailover, candidate); });

test('machine failure codes retain their policy even when diagnostics mention another failure',()=>{
  const auth=classifyAgentFailure('provider_auth');assert.equal(auth.code,'provider_auth');assert.equal(auth.humanActionRequired,true);assert.equal(auth.adapterFailover,false);
  const timeout=classifyAgentFailure('runtime_timeout: prior provider response mentioned 401');assert.equal(timeout.code,'runtime_timeout');assert.equal(timeout.adapterFailover,true);assert.equal(timeout.humanActionRequired,false);
});

test('routing excludes stale readiness and open circuits', () => {
  const ready = { state: 'ready', updatedAt: new Date().toISOString() };
  assert.equal(adapterEligible(ready), true);
  assert.equal(adapterEligible({ ...ready, circuitOpenUntil: new Date(Date.now() + 60000).toISOString() }), false);
  assert.equal(adapterEligible({ ...ready, updatedAt: new Date(Date.now() - 120000).toISOString() }), false);
  assert.equal(adapterEligible({ ...ready, state: 'busy' }), false);
});
test('write tasks require tools and manual model selection is preserved', () => {
  const required = taskCapabilities({ mode: 'build', permission: 'full' });
  assert.equal(compatibleCapabilities(getAgentAdapter('mini-swe').capabilities, required), true);
  assert.equal(compatibleCapabilities({ repositoryRead: true }, required), false);
  for (const id of ['mini-swe','cline']) assert.equal(getAgentAdapter(id).supportsModel('opencode/free-model'), false);
});
test('late results and events from previous executions are fenced', () => {
  const task = { adapterId: 'cline', harness: { executionGeneration: 2 } };
  assert.equal(currentExecution(task, { adapterId: 'opencode', executionGeneration: 1 }), false);
  assert.equal(currentExecution(task, { adapterId: 'cline', executionGeneration: 2 }), true);
  task.harness.adapterTransition = { target: 'mini-swe' };
  assert.equal(currentExecution(task, { adapterId: 'cline', executionGeneration: 2 }), false);
});
test('handoff includes public state and preserves durable identity', () => {
  const harness = createHarnessCheckpoint({ prompt: 'fix tests', mode: 'build', permission: 'full', plane: 'workspace' });
  harness.investigation = { id: 'inv-1', stage: 'testing', question: 'test failure', hypothesis: 'public diagnostic', evidence: ['test failed'], attempt: 1 };
  const task = { id: 't', sessionId: 's', workspaceId: 'w', prompt: 'fix tests', harness, adapterId: 'opencode' };
  const checkpoint = handoffCheckpoint(task, { repo: 'u/r', branch: 'main', headSha: 'a'.repeat(40), dirtyState: true }, 'orlynx-runner', [{path:'src/auth.ts',action:'modified'}], [], 'manual-switch');
  assert.equal(checkpoint.taskId, 't'); assert.equal(checkpoint.investigationId, 'inv-1'); assert.equal(checkpoint.workspace.id, 'w');
  assert.equal(checkpoint.changedFiles[0].path, 'src/auth.ts'); assert.equal(checkpoint.previousAdapter, 'opencode');
  assert.equal('messages' in checkpoint, false); assert.equal('reasoning' in checkpoint, false);
});
test('verification after handoff rejects passing tests from the old adapter generation', () => {
  const harness = createHarnessCheckpoint({ prompt: 'run tests', mode: 'build', permission: 'full', plane: 'workspace' });
  harness.executionGeneration = 2;
  harness.verification.required = ['tests'];
  const events = [{ type:'test.result', sequence:1, payload:{code:0,executionGeneration:1} }];
  assert.equal(verifyHarness(harness,events).verification.status, 'needs_more_work');
  events.push({ type:'test.result',sequence:2,payload:{code:0,executionGeneration:2} });
  assert.equal(verifyHarness(harness,events).verification.status, 'passed');
});

test('test success applies only to the exact current workspace bytes',()=>{
  const harness=createHarnessCheckpoint({prompt:'run tests',mode:'build',permission:'full',plane:'workspace'});harness.executionGeneration=3;harness.verifiedWorkspaceFingerprint='new-bytes';
  const historical={type:'test.result',sequence:1,payload:{code:0,executionGeneration:3,repositoryFingerprint:'old-bytes'}};
  assert.equal(verifyHarness(harness,[historical]).verification.status,'needs_more_work');
  assert.equal(verifyHarness(harness,[historical,{type:'test.result',sequence:2,payload:{code:0,executionGeneration:3,repositoryFingerprint:'new-bytes'}}]).verification.status,'passed');
});
test('invalid or future health timestamps cannot admit automatic traffic',()=>{
  for(const updatedAt of ['invalid',new Date(Date.now()+60000).toISOString()])assert.equal(adapterEligible({state:'ready',updatedAt}),false);
});
test('all adapters consume the same observable checkpoint without native sessions',()=>{
  const input={taskId:'t',runId:'r',sessionId:'s',modelId:'openai/test',text:'objective',handoff:{taskId:'t',objective:'checkpoint'},executionGeneration:4,workspaceBaseHead:'a'.repeat(40)};
  for(const id of ['opencode','mini-swe','cline']){const adapter=getAgentAdapter(id);const payload=adapter.workspacePayload(input);assert.equal(payload.taskId,'t');assert.equal(payload.handoff,input.handoff);assert.equal(payload.workspaceBaseHead,input.workspaceBaseHead);if(id!=='opencode')assert.equal(adapter.getOrCreateSession,undefined);}
});

test('provider model namespaces preserve the user-selected free model',async()=>{
  const {setSessionPrefs}=await import('../src/ai.ts');
  const id='openrouter/poolside/laguna-s-2.1:free';assert.equal(setSessionPrefs('adapter-policy-model',{modelId:id}).modelId,id);
  assert.throws(()=>setSessionPrefs('adapter-policy-model',{modelId:'openrouter/../bad key'}),/Unknown model/);
});


test('workspace-only agents and provider-specific models never fall back into the OpenCode direct lane',async()=>{
  const {adapterExecutionPlane}=await import('../src/agent-runtime.ts');
  assert.equal(adapterExecutionPlane(getAgentAdapter('opencode'),'opencode/free','direct'),'direct');
  assert.equal(adapterExecutionPlane(getAgentAdapter('opencode'),'openrouter/poolside/laguna-s-2.1:free','direct'),'workspace');
  for(const id of ['cline','mini-swe'])assert.equal(adapterExecutionPlane(getAgentAdapter(id),'openai/test','direct'),'workspace');
});

for (const detail of ['no shell', 'no shell available in this adapter', 'no terminal', 'shell unavailable', 'command tool unavailable', 'missing shell capability', 'shell is not available', 'exec tool not available']) {
  test(`shell capability recovery: ${detail}`, () => {
    const failure = classifyAgentFailure(detail);
    assert.equal(failure.code, 'runtime_unavailable');
    assert.equal(failure.adapterFailover, true);
    assert.equal(failure.retryable, true);
    assert.equal(failure.humanActionRequired, false);
  });
}
for (const detail of ['npm: command not found', 'executable python missing', 'spawn bash ENOENT']) {
  test(`missing executable is distinct from missing shell: ${detail}`, () => {
    const failure = classifyAgentFailure(detail);
    assert.equal(failure.code, 'tool_failure');
    assert.equal(failure.adapterFailover, false);
  });
}
