import test from 'node:test';
import assert from 'node:assert/strict';
import {readOnlyCommand} from '../../../bridge/src/read-only-command.ts';
test('review tools execute a bounded argument vector rather than a shell',()=>{
  assert.deepEqual(readOnlyCommand('cat "src/file name.ts"'),{executable:'cat',args:['src/file name.ts']});
  assert.deepEqual(readOnlyCommand('git diff --stat'),{executable:'git',args:['diff','--no-ext-diff','--no-textconv','--stat']});
  for(const command of ['cat $HOME/.env','cat ../.env','cat /proc/1/environ','cat x; touch owned','rg --pre=node text','rg --follow secret','grep -R secret','git -c core.pager=node log','git diff --output=owned','find . -delete','python3 -c pass','cat `id`']) assert.throws(()=>readOnlyCommand(command),/permission_denied/);
});
