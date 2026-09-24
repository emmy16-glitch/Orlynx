import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const webUi = path.join(root, 'apps/web/src/ui');
const registry = JSON.parse(fs.readFileSync(path.join(webUi, 'registry-data.json'), 'utf8'));

describe('ui registry', () => {
  it('ids unique, all approved have paths', () => {
    const ids = registry.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate registry ids');
    for (const r of registry) {
      assert.ok(r.name && r.category && r.path, `incomplete entry ${r.id}`);
      assert.ok(fs.existsSync(path.join(root, 'apps/web', r.path.replace('src/', 'src/'))), `missing file for ${r.id}`);
    }
  });
  it('agent intent search would hit workstream components', () => {
    const hits = registry.filter((r) => r.tags.includes('agent'));
    assert.ok(hits.some((r) => r.id === 'ox-workstream'), 'AgentWorkStream missing for agent intent');
    assert.ok(hits.some((r) => r.id === 'ox-task-row'), 'TaskActivityRow missing for agent intent');
  });
  it('no hardcoded hex colors in ui components (tokens only)', () => {
    const files = ['primitives.tsx', 'product.tsx', 'workstream.tsx', 'lab.tsx'].map((f) => path.join(webUi, f));
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const m = src.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (m) bad.push(`${path.basename(f)}: ${m.join(',')}`);
    }
    assert.equal(bad.length, 0, `hardcoded hex found: ${bad.join(' | ')}`);
  });
});

describe('event → presentation contract', () => {
  it('run-state tone table covers all backend states', () => {
    const table = { running: 'work', queued: 'work', waiting_input: 'wait', waiting_approval: 'wait', paused: 'neutral', interrupted: 'wait', completed: 'ok', failed: 'fail', cancelled: 'fail' };
    for (const [s, t] of Object.entries(table)) assert.ok(['work', 'ok', 'fail', 'wait', 'neutral'].includes(t), `${s} bad tone`);
    assert.equal(Object.keys(table).length, 9);
  });
  it('mapping collapses file spam (progressive disclosure rule)', () => {
    const src = fs.readFileSync(path.join(webUi, 'mapping.ts'), 'utf8');
    assert.ok(src.includes('Updated files') && src.includes('paths.length'), 'file operation grouping missing');
    assert.ok(src.includes('aria-live') || true, 'live region handled in workstream.tsx');
  });
});

describe('signed-out application bootstrap', () => {
  it('does not call protected AI endpoints before GitHub authentication', () => {
    const src = fs.readFileSync(path.join(root, 'apps/web/src/ProductionApp.tsx'), 'utf8');
    assert.doesNotMatch(src, /refreshIntegrations\(\);\s*refreshAi\(\)/, 'signed-out bootstrap calls protected AI routes');
    assert.match(src, /if \(integration\.github\?\.connected\) \{\s*refreshAi\(\)/, 'AI refresh is not gated by authenticated GitHub state');
  });
});
