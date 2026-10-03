import test from 'node:test';
import assert from 'node:assert/strict';
import {cookieFor,configuredTarget} from '../scripts/e2e-config.mjs';
const cookie={name:'orlynx_session',value:'fixture',domain:'test.example',path:'/',secure:true,expires:Date.now()/1000+600};
test('E2E credentials are scoped to matching host, path, transport and expiry',()=>{
  assert.equal(cookieFor({cookies:[cookie]},'https://test.example'),'orlynx_session=fixture');
  for(const base of ['https://other.example','http://test.example']) assert.equal(cookieFor({cookies:[cookie]},base),'');
  for(const changes of [{expires:1},{path:'/unrelated/'},{name:'github_session'}])assert.equal(cookieFor({cookies:[{...cookie,...changes}]},'https://test.example'),'');
  assert.equal(cookieFor({cookies:[{...cookie,domain:'.test.example',expires:-1}]},'https://sub.test.example'),'orlynx_session=fixture');
  assert.equal(cookieFor({cookies:[{...cookie,domain:'.test.example'}]},'https://eviltest.example'),'');
});
test('live E2E requires an explicit test origin and repository',()=>{
  assert.throws(()=>configuredTarget({}),/Set ORLYNX_API/);
  assert.equal(configuredTarget({ORLYNX_API:'https://test.example/',ORLYNX_E2E_REPOSITORY:'owner/test'}),'https://test.example');
  for(const url of ['https://user:pass@test.example','https://test.example/path','https://test.example?token=secret'])assert.throws(()=>configuredTarget({ORLYNX_API:url,ORLYNX_E2E_REPOSITORY:'owner/test'}));
});
