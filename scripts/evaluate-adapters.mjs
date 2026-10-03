/** Deterministic, zero-provider-cost evaluation of real engines and controller.
 * The report measures this suite, not broad agent coding quality. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
const suites=[
  {name:'real-execution',files:['apps/api/test/portable-runtime.test.js']},
  {name:'switch-recovery-tenancy',files:['apps/api/test/adapter-control-plane.test.js','apps/api/test/execution-gate.test.js']},
  {name:'routing-verification',files:['apps/api/test/adapter-policy.test.js','apps/api/test/production-observation.test.js']},
];
const results=[];
for(const suite of suites){
  const start=performance.now();let output='';
  const child=spawn(process.execPath,['--import','tsx','--test','--test-reporter=tap',...suite.files],{stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const number=label=>Number(output.match(new RegExp(`# ${label} (\\d+)`))?.[1] || 0);
  results.push({suite:suite.name,durationMs:Math.round(performance.now()-start),tests:number('tests'),passed:number('pass'),failed:number('fail'),skipped:number('skipped'),exitCode:code});
  if(code)process.stderr.write(output);
}
const report={generatedAt:new Date().toISOString(),providerCost:0,scope:'deterministic model fixtures and PostgreSQL control-plane integration',results};
const reportPath=process.argv[2];if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=results.some(result=>result.exitCode)?1:0;
