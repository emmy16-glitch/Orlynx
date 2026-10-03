import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneFixture } from './helpers/control-plane.js';

test('disconnected commands expire in bounded batches without replay or false execution certainty', async t => {
  const {repository,now} = await controlPlaneFixture(t);
  for (const id of ['ws','other']) await repository.putWorkspace({id,sessionId:'s',userId:'u',projectId:'p',repositoryId:1,branch:'main',provider:'orlynx-runner',state:'connecting',bridgeState:'disconnected',createdAt:now,updatedAt:now});
  const queue = (id,status,workspaceId='ws',expiresAt='2000-01-01T00:00:00Z',result=undefined) => repository.queueCommand({id,workspaceId,kind:'fs.write',payload:{path:'file.txt'},status,expiresAt,createdAt:now,updatedAt:now,result});
  await queue('queued','queued'); await queue('sent','sent'); await queue('other-expired','queued','other');
  await queue('live','queued','ws','2100-01-01T00:00:00Z');
  await queue('done','completed','ws','2000-01-01T00:00:00Z',{saved:true});
  assert.equal(await repository.expireCommands('ws',1),1);
  assert.equal((await repository.getCommand('other-expired')).status,'queued','workspace-scoped claim does not expire another workspace');
  assert.equal(await repository.expireCommands(),2,'global sweep needs no bridge connection');
  for (const id of ['queued','sent','other-expired']) {
    const command = await repository.getCommand(id);
    assert.equal(command.status,'failed');
    assert.equal(command.result.executionOutcome,'unknown');
    assert.equal(command.result.reconciliationRequired,true,'timeout is not proof that a mutation did not execute');
    assert.equal(await repository.completeCommand(id,'completed',{saved:true}),false,'late result cannot overwrite terminal expiry');
  }
  assert.equal((await repository.getCommand('live')).status,'queued');
  assert.deepEqual((await repository.getCommand('done')).result,{saved:true});
  assert.equal(await repository.expireCommands(),0,'repeated sweep is idempotent');
  assert.deepEqual((await repository.claimCommands('ws')).map(command=>command.id),['live'],'expired mutations are never replayed');
});
