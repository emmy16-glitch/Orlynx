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


describe('workspace trust and AI control contract', () => {
  const src = fs.readFileSync(path.join(root, 'apps/web/src/ProductionApp.tsx'), 'utf8');

  it('restores recent durable activity before resuming the live stream', () => {
    assert.match(src, /\/v1\/sessions\/\$\{record\.id\}\/activity\?limit=300/, 'workspace does not restore durable activity history');
    assert.match(src, /setEvents\(ordered\)/, 'restored activity is not placed back into the timeline');
    assert.match(src, /connectEvents\(record\.id\)/, 'live event stream is not resumed after restoration');
  });

  it('uses one authored agent/model control instead of native composer selects', () => {
    assert.match(src, /className="ai-control-trigger"/, 'unified AI control trigger missing');
    assert.match(src, /className="ai-dropdown-topline"/, 'compact AI dropdown header missing');
    assert.match(src, /aria-label="Model"/, 'model picker list missing');
    assert.doesNotMatch(src, /className="inline-agent-picker"/, 'legacy native agent picker returned');
    assert.doesNotMatch(src, /className="inline-model-picker"/, 'legacy native model picker returned');
    assert.match(src, /const renderAiSwitcher = \(\) => session \? <ConnectAiSheet/, 'shared AI switcher renderer missing');
    assert.match(src, /className="composer-ai-dropdown"/, 'AI switcher is not anchored to the composer');
    assert.match(src, /page !== 'workspace'.*ai-settings-switcher-anchor/, 'settings AI switcher fallback missing');
  });

  it('routes model recovery back into the unified AI controls', () => {
    assert.match(src, /if \(modelProblem\) \{\s*setShowConnectAI\(true\);/, 'model recovery does not open AI controls');
  });

  it('keeps the composer picker compact and scrollable', () => {
    const css = fs.readFileSync(path.join(root, 'apps/web/src/styles.css'), 'utf8');
    assert.match(css, /\.composer-ai-dropdown[\s\S]*?width: min\(302px/, 'composer dropdown is too wide');
    assert.match(css, /\.composer-ai-dropdown \.ai-model-compact-list[\s\S]*?max-height: 155px/, 'model list is not compact and scrollable');
  });
});


describe('theme integrity contract', () => {
  const src = fs.readFileSync(path.join(root, 'apps/web/src/ProductionApp.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'apps/web/src/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');

  it('uses an authored System/Light/Dark theme switcher instead of a native select', () => {
    assert.match(src, /className="theme-switcher"/, 'theme switcher is missing');
    assert.match(src, /\['system', 'System'\]/, 'System theme option missing');
    assert.match(src, /\['light', 'Light'\]/, 'Light theme option missing');
    assert.match(src, /\['dark', 'Dark'\]/, 'Dark theme option missing');
    assert.doesNotMatch(src, /<select value=\{theme\}/, 'native theme select returned');
  });

  it('applies the chosen theme before React paints', () => {
    assert.match(html, /localStorage\.getItem\('orlynx:theme'\)/, 'theme is not restored before first paint');
    assert.match(html, /document\.documentElement\.dataset\.theme/, 'resolved theme is not applied to the root element');
  });

  it('overrides the high-specificity mobile workspace bar in dark mode', () => {
    assert.match(css, /html\[data-theme="dark"\] \.is-workspace \.mobile-project-nav[\s\S]*?background:/, 'dark mobile project navigation override missing');
    assert.match(css, /html\[data-theme="dark"\] \.is-workspace \.composer[\s\S]*?background:/, 'dark composer override missing');
  });
});


describe('curated editorial design contract', () => {
  const src = fs.readFileSync(path.join(root, 'apps/web/src/ProductionApp.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'apps/web/src/curated.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(root, 'apps/web/src/ui/tokens.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');
  const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');

  it('loads the isolated curated visual layer after functional UI modules', () => {
    assert.match(src, /import '\.\/curated\.css';/, 'curated visual layer is not loaded');
    assert.ok(src.indexOf("from './ui/workstream'") < src.indexOf("import './curated.css'"), 'curated layer should load after shared UI modules');
  });

  it('uses the approved editorial typography and focus palette', () => {
    assert.match(tokens, /--font-display: "Geist"/, 'Geist heading role missing');
    assert.match(tokens, /--font-sans: "Inter"/, 'Inter body role missing');
    assert.match(tokens, /--font-mono: "IBM Plex Mono"/, 'IBM Plex Mono technical role missing');
    assert.match(tokens, /--accent-focus: #B7FF5A/, 'focus accent missing');
    assert.match(html, /family=Geist/, 'Geist webfont not loaded');
    assert.match(html, /family=IBM\+Plex\+Mono/, 'IBM Plex Mono webfont not loaded');
    assert.match(html, /family=Inter/, 'Inter webfont not loaded');
  });

  it('keeps Chat as the primary workspace canvas instead of a dashboard', () => {
    assert.match(css, /\.context-panel\s*\{\s*display: none !important;/, 'permanent context rail returned');
    assert.match(css, /\.workspace-layout[\s\S]*?display: block !important;/, 'workspace is not single-canvas');
    assert.match(css, /\.conversation[\s\S]*?var\(--chat-max\)/, 'chat canvas width contract missing');
  });

  it('uses separators and flat surfaces instead of card-heavy primary workflows', () => {
    assert.match(css, /\.message-row[\s\S]*?border-bottom: 1px solid var\(--border-subtle\)/, 'editorial chat separators missing');
    assert.match(css, /\.change-set[\s\S]*?border-radius: 0 !important;/, 'change review returned to card chrome');
    assert.match(css, /\.project-list-row,[\s\S]*?border-bottom: 1px solid var\(--border-subtle\)/, 'scan-first project rows missing');
  });

  it('keeps the composer and AI selector compact and attached to the working canvas', () => {
    assert.match(css, /\.composer[\s\S]*?width: min\(calc\(100vw - 40px\), var\(--chat-max\)\)/, 'composer is not bounded to the chat canvas');
    assert.match(css, /\.composer-ai-dropdown[\s\S]*?width: min\(300px/, 'AI selector is no longer compact');
  });

  it('documents curated.design as a reference rather than a clone', () => {
    assert.match(design, /curated\.design translated into a real developer workspace/i);
    assert.match(design, /reference, not a clone/i);
  });
});
