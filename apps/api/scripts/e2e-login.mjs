import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {configuredTarget,cookieFor} from './e2e-config.mjs';
async function main(){
  const base=configuredTarget();
  const output=process.env.ORLYNX_E2E_STORAGE_STATE;
  if(!output)throw new Error('Set ORLYNX_E2E_STORAGE_STATE to a private file outside the repository.');
  const repo=path.resolve(import.meta.dirname,'../../..'),dest=path.resolve(output);
  if(dest===repo||dest.startsWith(repo+path.sep))throw new Error('Storage state must be saved outside the repository.');
  const browser=await chromium.launch({headless:false});
  try{
    const context=await browser.newContext();const page=await context.newPage();
    await page.goto(`${base}/v1/github/install`);
    console.log('Complete the normal GitHub login in the browser. Waiting up to ten minutes; no password is captured.');
    const end=Date.now()+10*60_000;
    while(Date.now()<end){
      const state=await context.storageState();
      if(cookieFor(state,base)){
        const ready=await context.request.get(`${base}/v1/integrations/status`);
        if(ready.ok()&&(await ready.json()).github?.connected){
          const scoped={cookies:state.cookies.filter(c=>cookieFor({cookies:[c]},base)),origins:[]};
          fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
          fs.writeFileSync(dest,JSON.stringify(scoped),{mode:0o600,flag:'wx'});
          console.log('Saved only the Orlynx session cookie to the private storage-state file. Run npm run e2e:setup next.');return;
        }
      }
      await new Promise(r=>setTimeout(r,1000));
    }
    throw new Error('Login timed out.');
  }finally{await browser.close();}
}
main().catch(error=>{console.error(`LOGIN BLOCKED: ${error.message.replace(/https?:\/\/\S+/g,'[URL]')}`);process.exitCode=2;});
