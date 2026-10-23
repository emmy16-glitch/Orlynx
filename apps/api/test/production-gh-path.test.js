import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Render packages the pinned GitHub CLI and production supervisor adds it to PATH', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts/render-build.sh'), 'utf8');
  const supervisor = fs.readFileSync(path.join(repoRoot, 'apps/api/scripts/production-start.mjs'), 'utf8');
  const workspace = fs.readFileSync(path.join(repoRoot, 'apps/api/src/runtime-worker.ts'), 'utf8');

  assert.match(build, /cp "\/tmp\/orlynx-gh\/\$\{ARCHIVE\}\/bin\/gh" \.render-bin\/gh/);
  assert.match(supervisor, /new URL\('\.\.\/\.\.\/\.\.\/\.render-bin\/', import\.meta\.url\)/);
  assert.match(supervisor, /existsSync\(join\(bundledGhDir, 'gh'\)\)/);
  assert.match(supervisor, /childEnv\.PATH\s*=\s*\[bundledGhDir, process\.env\.PATH/);
  assert.match(supervisor, /join\(delimiter\)/);
  assert.match(supervisor, /env: childEnv/);
  assert.match(workspace, /spawn\('gh', \['codespace', 'ssh'/);
});

test('production supervisor syntax is accepted by the Node runtime', async () => {
  const { execFileSync } = await import('node:child_process');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(repoRoot, 'apps/api/scripts/production-start.mjs')]));
});
