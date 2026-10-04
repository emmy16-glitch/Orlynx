import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { onlyPeerMetadataChanged, recoverPeerMetadata } from '../../../bridge/src/lockfile-drift.ts';

test('recognizes npm peer flag churn while preserving dependency and other metadata changes', () => {
  const lock = {lockfileVersion:3, packages:{'':{name:'app'}, 'node_modules/a':{version:'1.0.0',integrity:'sha512-original'}}};
  const before = JSON.stringify(lock);
  const peer = structuredClone(lock); peer.packages['node_modules/a'].peer = true;
  assert.equal(onlyPeerMetadataChanged(before, JSON.stringify(peer)), true);
  assert.equal(onlyPeerMetadataChanged(JSON.stringify(peer), before), true);
  for (const key of ['version', 'integrity', 'resolved', 'dev']) {
    const changed = structuredClone(peer); changed.packages['node_modules/a'][key] = 'changed';
    assert.equal(onlyPeerMetadataChanged(before, JSON.stringify(changed)), false);
  }
  assert.equal(onlyPeerMetadataChanged(before, before), false);
  assert.equal(onlyPeerMetadataChanged(before, '{}'), false);
  assert.equal(onlyPeerMetadataChanged(before, 'invalid'), false);
});

test('current Git workspace recovers peer drift with a replayable patch and preserves real edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orlynx-lock-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const repo = path.join(root,'repo'), recovery = path.join(root,'recovery'); fs.mkdirSync(repo);
  const git = args => execFileSync('git',args,{cwd:repo,encoding:'utf8'});
  git(['init','-q']); git(['config','user.name','test']); git(['config','user.email','test@example.com']);
  // These public registry URLs look like secrets to the display redactor.
  // Internal Git comparisons and saved recovery patches must retain them exactly.
  const lock = {lockfileVersion:3, packages:{'node_modules/a':{version:'1', resolved:'https://registry.npmjs.org/@aws-sdk/token-providers/-/token-providers-3.1138.0.tgz'}}};
  const filename = path.join(repo,'package-lock.json'), original = JSON.stringify(lock,null,2)+'\n';
  fs.writeFileSync(filename,original); git(['add','.']); git(['commit','-qm','baseline']);
  lock.packages['node_modules/a'].peer = true;
  const drift = JSON.stringify(lock,null,2)+'\n'; fs.writeFileSync(filename,drift);
  const saved = recoverPeerMetadata(repo,recovery,git);
  assert.ok(saved); assert.equal(fs.readFileSync(filename,'utf8'),original); assert.equal(git(['status','--porcelain']), '');
  git(['apply',saved]); assert.equal(fs.readFileSync(filename,'utf8'),drift);
  git(['add','package-lock.json']); assert.equal(recoverPeerMetadata(repo,recovery,git),undefined);
  git(['reset','-q']); lock.packages['node_modules/a'].version = '2'; fs.writeFileSync(filename,JSON.stringify(lock));
  assert.equal(recoverPeerMetadata(repo,recovery,git),undefined); assert.match(fs.readFileSync(filename,'utf8'), /"version":"2"/);
});
