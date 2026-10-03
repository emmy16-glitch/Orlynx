import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { controlPlaneFixture } from './helpers/control-plane.js';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { attachBridgeGateway } from '../src/bridge-gateway.ts';
import { durableHistory } from '../src/events.ts';
import { createBridgeToken } from '../src/bridge-auth.ts';

test('initial authenticated READY persists model constraints before the first heartbeat', {timeout:15000}, async t=>{
  const {repository,now}=await controlPlaneFixture(t);
  const before=process.env.ORLYNX_BRIDGE_SIGNING_SECRET;
  process.env.ORLYNX_BRIDGE_SIGNING_SECRET='test-bridge-secret-with-at-least-32-bytes';
  setControlPlaneRepositoryForTests(repository);
  t.after(()=>{setControlPlaneRepositoryForTests(undefined);if(before===undefined)delete process.env.ORLYNX_BRIDGE_SIGNING_SECRET;else process.env.ORLYNX_BRIDGE_SIGNING_SECRET=before;});
  const claims={workspaceId:'ws',sessionId:'s',userId:'u',connectionId:'connection-test'};
  await repository.putWorkspace({id:'ws',sessionId:'s',userId:'u',projectId:'p',repositoryId:1,branch:'main',provider:'orlynx-runner',state:'connecting',bridgeState:'connecting',connectionId:claims.connectionId,createdAt:now,updatedAt:now});
  const server=http.createServer();attachBridgeGateway(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/bridge`,{headers:{Authorization:`Bearer ${createBridgeToken(claims)}`}});
  t.after(async()=>{if(socket.readyState!==WebSocket.CLOSED){const closed=once(socket,'close');socket.terminate();await closed;}await new Promise(resolve=>server.close(resolve));});
  await once(socket,'open');
  const authenticated=once(socket,'message');socket.send(JSON.stringify({kind:'HELLO',...claims}));
  assert.equal(JSON.parse(String((await authenticated)[0])).kind,'AUTHENTICATED');
  const model='openrouter/poolside/laguna-s-2.1:free';
  socket.send(JSON.stringify({kind:'READY',adapters:{cline:{state:'ready',supportedModels:[model],freeModels:[model],runtimeVersion:'@cline/agents@0.0.90'}}}));
  let health;
  for(let i=0;i<100;i++) {
    health=await repository.getWorkspaceAgentAdapter('ws','cline');
    if(health)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.deepEqual(health.supportedModels,[model]);assert.deepEqual(health.freeModels,[model]);assert.equal(health.runtimeVersion,'@cline/agents@0.0.90');
  const adapterEvents = async () => (await durableHistory('s')).filter(event => event.payload.scope === 'agent-adapter' && event.payload.adapterId === 'cline');
  const heartbeat = async adapter => {
    const previous = await repository.getWorkspaceAgentAdapter('ws', 'cline');
    await repository.putWorkspaceAgentAdapter({...previous,updatedAt:'2000-01-01T00:00:00.000Z'});
    socket.send(JSON.stringify({kind:'ADAPTER_STATUS',adapterId:'cline',adapter}));
    for(let i=0;i<100;i++) {
      const next = await repository.getWorkspaceAgentAdapter('ws','cline');
      if(next.updatedAt !== '2000-01-01T00:00:00.000Z') return next;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('heartbeat did not refresh durable health');
  };
  const baseline = (await adapterEvents()).length;
  const ready = {state:'ready',supportedModels:[model],freeModels:[model],runtimeVersion:'@cline/agents@0.0.90'};
  await heartbeat(ready);
  assert.equal((await adapterEvents()).length, baseline, 'unchanged READY heartbeat is suppressed');
  const rejected = {...ready,state:'unavailable',reason:'provider_auth: rejected'};
  await heartbeat(rejected);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await adapterEvents()).length, baseline + 1);
  await heartbeat(rejected);
  assert.equal((await adapterEvents()).length, baseline + 1, 'identical rejection does not flood events');
  await heartbeat({...rejected,reason:'provider_unavailable: timeout'});
  await heartbeat(ready);
  await new Promise(resolve=>setTimeout(resolve,50));
  const transitions = await adapterEvents();
  assert.equal(transitions.length, baseline + 3, 'changed reason and recovery are emitted');
  assert.equal(transitions.at(-1).payload.state, 'ready');
  assert.equal(transitions.at(-1).payload.reason, undefined, 'recovery clears stale reason');

});
