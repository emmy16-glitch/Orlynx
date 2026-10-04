import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCodespacesProvider } from '../src/github-codespaces.ts';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';

test('E2E allocation never adopts another session Codespace; normal sessions still reuse', async t => {
 const input={workspaceId:'ws-new',sessionId:'s-new',userId:'u',projectId:'p',repositoryId:1,branch:'main'};
 let isE2E=true, reused=0, created=0;
 setControlPlaneRepositoryForTests({getSession:async()=>({checkpoint:isE2E?{liveE2EBranch:'orlynx-e2e/1760000000000'}:undefined})});
 t.after(()=>setControlPlaneRepositoryForTests(undefined));
 const provider=new GitHubCodespacesProvider();
 provider.reusableForSession=async()=>null;
 provider.reusableForProject=async()=>{reused++;return {name:'old-user-codespace',state:'Shutdown'};};
 provider.request=async(_user,path)=>{if(path === '/user/codespaces') created++;return {name:'new-e2e-codespace',state:'Starting'};};
 const fresh=await provider.create(input);
 assert.equal(fresh.codespaceName,'new-e2e-codespace'); assert.equal(reused,0); assert.equal(created,1);
 isE2E=false;
 const normal=await provider.create(input);
 assert.equal(normal.codespaceName,'old-user-codespace'); assert.equal(reused,1); assert.equal(created,1);
});
