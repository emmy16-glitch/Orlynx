import {configuredTarget,sessionCookie} from './e2e-config.mjs';
async function main(){
  const base=configuredTarget();
  const cookie=sessionCookie(base);
  if(!cookie){console.log('SETUP REQUIRED: no matching authenticated Orlynx session. Run npm run e2e:login on a computer with a browser, then set ORLYNX_E2E_STORAGE_STATE to the saved file.');process.exitCode=2;return;}
  const response=await fetch(`${base}/v1/integrations/status`,{headers:cookie?{Cookie:cookie}:{},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Integration readiness request returned HTTP ${response.status}.`);
  const status=await response.json();
  console.log(`Target: ${base}; repository: ${process.env.ORLYNX_E2E_REPOSITORY}`);
  console.log(`Authenticated GitHub: ${Boolean(status.github?.connected)}; cloud infrastructure: ${Boolean(status.workspace?.cloudAvailable)}`);
  if(!cookie||!status.github?.connected){console.log('SETUP REQUIRED: npm run e2e:login on a computer with a browser, then set ORLYNX_E2E_STORAGE_STATE to the saved file.');process.exitCode=2;return;}
  const repos=await fetch(`${base}/v1/repos`,{headers:{Cookie:cookie},signal:AbortSignal.timeout(20000)});
  if(!repos.ok)throw new Error(`Repository authorization returned HTTP ${repos.status}.`);
  const listing=await repos.json();
  if(!listing.github?.some(r=>r.full===process.env.ORLYNX_E2E_REPOSITORY))throw new Error('Dedicated test repository is not authorized for this account.');
  if(!status.workspace?.cloudAvailable)throw new Error('Workspace infrastructure is not configured for the test deployment.');
  console.log('Session, repository and cloud checks passed. Before running npm run e2e, enable ORLYNX_E2E_ENABLED=true on the controlled test deployment. This check does not exercise execution or publication.');
}
main().catch(()=>{console.error('SETUP BLOCKED: check the target, local storage-state file and network access. No credentials were printed.');process.exitCode=2;});
