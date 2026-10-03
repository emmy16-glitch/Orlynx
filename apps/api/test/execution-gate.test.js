import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionGate } from '../../../bridge/src/execution-gate.ts';
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'orlynx-gate-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return path.join(root,'gate.json'); }
test('one workspace cannot admit two adapters even for the same task', t => {
  const gate=new ExecutionGate(fixture(t)); gate.enter('t',1,'opencode');
  assert.throws(()=>gate.enter('t',2,'cline'),/conflict/); gate.leave('t'); gate.reconcile(2); gate.enter('t',2,'cline');
  assert.equal(gate.current().taskId,'t'); gate.leave('t'); assert.throws(()=>gate.enter('other',1,'mini-swe'),/stale/);
});
test('restart with an unfinished writer blocks replay instead of duplicating effects', t => {
  const file=fixture(t); const gate=new ExecutionGate(file); gate.enter('t',1,'opencode'); gate.session('t','engine-1');
  const restored=new ExecutionGate(file); assert.equal(restored.interrupted(),true); assert.equal(restored.current().engineSessionId,'engine-1');
  assert.throws(()=>restored.enter('t',2,'cline'),/reconciliation/); assert.throws(()=>restored.reconcile(2),/uncertain/);
});
test('acknowledged completion permits clean restart and retains the fence', t => {
  const file=fixture(t); const gate=new ExecutionGate(file); gate.enter('t',4,'mini-swe'); gate.leave('t');
  const restored=new ExecutionGate(file); assert.equal(restored.interrupted(),false); assert.throws(()=>restored.enter('t',3,'cline'),/stale/); restored.enter('t',5,'cline');
});

