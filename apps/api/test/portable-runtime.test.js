import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runPortable, portableHealth, cancelPortable, adapterProviderKey} from '../../../bridge/src/portable-agents.ts';
const exec=promisify(execFile);

// These tests run the real upstream loops with a deterministic model endpoint.
// Only the model replies are scripted; commands execute in a real fixture.
for (const adapter of ['cline','mini-swe']) test(`${adapter} actual runtime writes, verifies and exports only public events`, {timeout:120000}, async t=>{
  if(adapter==='mini-swe' && !process.env.ORLYNX_MINI_SWE_PYTHON) {t.skip('Set ORLYNX_MINI_SWE_PYTHON to the pinned runtime for integration verification.');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orlynx-runtime-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let requests=0;const received=[];const events=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test'}]}));return;}
    let raw='';for await(const part of req) raw+=part;const body=JSON.parse(raw);received.push(body);requests++;
    const name=body.tools[0].function.name;
    const command=requests===1 ? "printf verified > result.txt; test \"$(cat result.txt)\" = verified" : 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT; echo Verified fixture.';
    const tool={id:`call-${requests}`,type:'function',function:{name,arguments:JSON.stringify({command})}};
    if(body.stream){
      res.setHeader('Content-Type','text/event-stream');
      const delta=requests===1?{role:'assistant',tool_calls:[{...tool,index:0}]}:{role:'assistant',content:'Verified fixture.',reasoning_content:'PRIVATE_SENTINEL'};
      const chunk={id:'test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta,finish_reason:null}]};
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);chunk.choices=[{index:0,delta:{},finish_reason:requests===1?'tool_calls':'stop'}];res.write(`data: ${JSON.stringify(chunk)}\n\n`);res.end('data: [DONE]\n\n');
    }else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'test',object:'chat.completion',created:1,model:'test',choices:[{index:0,message:{role:'assistant',content:'',reasoning_content:'PRIVATE_SENTINEL',tool_calls:[tool]},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const prefix=adapter==='cline'?'ORLYNX_CLINE':'ORLYNX_MINI_SWE';
  const old={base:process.env[`${prefix}_API_BASE`],model:process.env[`${prefix}_MODEL`]};
  process.env[`${prefix}_API_BASE`]=`http://127.0.0.1:${server.address().port}/v1`;process.env[`${prefix}_MODEL`]='openai/test';
  t.after(()=>{for(const [key,value] of [[`${prefix}_API_BASE`,old.base],[`${prefix}_MODEL`,old.model]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const host={root,environment:()=>({PATH:process.env.PATH,NO_PROXY:'127.0.0.1,localhost'}),emit:(type,payload)=>events.push({type,payload}),changes:()=>fs.existsSync(path.join(root,'result.txt'))?[{path:'result.txt',status:'added'}]:[],command:async command=>{try{const {stdout,stderr}=await exec('/bin/bash',['--noprofile','--norc','-c',command],{cwd:root,env:{PATH:process.env.PATH},timeout:5000});return {returncode:0,output:stdout+stderr};}catch(error){return {returncode:1,output:error.stdout+error.stderr};}}};
  assert.equal((await portableHealth(adapter,root)).state,'ready');
  const result=await runPortable(adapter,{taskId:'same-task',modelId:'openai/test',text:'Edit and verify fixture.',mode:'build',permission:'full',handoff:{taskId:'same-task',objective:'HANDOFF_SENTINEL'}},host);
  assert.equal(fs.readFileSync(path.join(root,'result.txt'),'utf8'),'verified');assert.match(result.responseText,/Verified fixture/);
  assert.ok(events.some(event=>event.type==='tool.completed' && event.payload.code===0));assert.ok(events.some(event=>event.type==='files.changed'));
  assert.match(JSON.stringify(received),/HANDOFF_SENTINEL/);assert.doesNotMatch(JSON.stringify(events),/PRIVATE_SENTINEL/);
  await assert.rejects(runPortable(adapter,{taskId:'same-task',modelId:'opencode/free'},host),/selected model/);
  requests=0;let aborted=false;
  const cancellable={...host,command:async(_command,_readOnly,signal)=>{
    const cancelled=new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({returncode:1,output:'cancelled'});},{once:true}));
    setTimeout(()=>void cancelPortable('cancel-task'),10);return cancelled;
  }};
  await assert.rejects(runPortable(adapter,{taskId:'cancel-task',modelId:'openai/test',text:'inspect',mode:'build',permission:'full'},cancellable),/cancel|abort/i);
  assert.equal(aborted,true);

  if(adapter==='cline') {
  requests=0;aborted=false;
  const timed={...host,command:async(_command,_readOnly,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({returncode:1,output:'interrupted'});},{once:true}))};
  await assert.rejects(runPortable(adapter,{taskId:'timeout-task',modelId:'openai/test',text:'inspect',mode:'build',permission:'full',timeoutMs:1000},timed),/runtime_timeout/);
  assert.equal(aborted,true,'deadline must stop outstanding tools and retain recoverable timeout classification');
  }

});


test('one shared provider key is confined to configured OpenRouter endpoints',t=>{
  const before={key:process.env.ORLYNX_OPENROUTER_API_KEY,base:process.env.ORLYNX_CLINE_API_BASE};
  t.after(()=>{for(const [key,value] of [['ORLYNX_OPENROUTER_API_KEY',before.key],['ORLYNX_CLINE_API_BASE',before.base]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  process.env.ORLYNX_OPENROUTER_API_KEY='test-credential';process.env.ORLYNX_CLINE_API_BASE='https://openrouter.ai/api/v1';assert.equal(adapterProviderKey('cline'),'test-credential');
  process.env.ORLYNX_CLINE_API_BASE='https://another-provider.invalid/v1';assert.equal(adapterProviderKey('cline'),undefined);
});

test('OpenRouter health distinguishes missing/rejected credentials from temporary provider failures',async t=>{
  const keys=['ORLYNX_CLINE_API_BASE','ORLYNX_CLINE_MODEL','ORLYNX_CLINE_API_KEY','ORLYNX_OPENROUTER_API_KEY'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));const fetchBefore=globalThis.fetch;
  t.after(()=>{globalThis.fetch=fetchBefore;for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
  process.env.ORLYNX_CLINE_API_BASE='https://openrouter.ai/api/v1';process.env.ORLYNX_CLINE_MODEL='openrouter/poolside/laguna-s-2.1:free';
  delete process.env.ORLYNX_CLINE_API_KEY;delete process.env.ORLYNX_OPENROUTER_API_KEY;
  globalThis.fetch=async()=>{throw new Error('must not request without a key');};
  assert.match((await portableHealth('cline',os.tmpdir())).reason,/^provider_auth/);
  process.env.ORLYNX_OPENROUTER_API_KEY='PRIVATE_CREDENTIAL_SENTINEL';
  for(const [status,code] of [[401,'provider_auth'],[403,'provider_auth'],[429,'provider_rate_limit'],[503,'provider_unavailable']]) {
    globalThis.fetch=async()=>new Response('{}',{status});
    const health=await portableHealth('cline',os.tmpdir());assert.match(health.reason,new RegExp(`^${code}`));assert.doesNotMatch(JSON.stringify(health),/PRIVATE_CREDENTIAL_SENTINEL/);
  }
  globalThis.fetch=async()=>{throw new Error('PRIVATE_CREDENTIAL_SENTINEL');};
  const health=await portableHealth('cline',os.tmpdir());assert.match(health.reason,/^provider_unavailable/);assert.doesNotMatch(JSON.stringify(health),/PRIVATE_CREDENTIAL_SENTINEL/);
});
