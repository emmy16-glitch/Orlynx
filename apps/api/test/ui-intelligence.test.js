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
  it('canonical stream owns event normalization and progressive disclosure', () => {
    const mapping = fs.readFileSync(path.join(webUi, 'mapping.ts'), 'utf8');
    const store = fs.readFileSync(path.join(root, 'apps/web/src/agent-stream/store.ts'), 'utf8');
    const view = fs.readFileSync(path.join(root, 'apps/web/src/agent-stream/view.ts'), 'utf8');
    assert.match(mapping, /canonical agent-stream/);
    assert.doesNotMatch(mapping, /case 'tool\.started'/);
    assert.match(store, /case 'TOOL_START'/);
    assert.match(store, /case 'STATE_DELTA'/);
    assert.match(store, /Updated \${compact\(paths\[0\], 88\)}/);
    assert.match(view, /activity\.kind === 'changes'/);
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
    assert.match(src, /\/v1\/sessions\/\$\{record\.id\}\/activity\?limit=500/, 'workspace does not restore durable activity history');
    assert.match(src, /setAgentStream\(rebuildAgentStream\(ordered\)\)/, 'restored activity is not rebuilt into canonical stream state');
    assert.match(src, /connectEvents\(record\.id\)/, 'live event stream is not resumed after restoration');
  });

  it('keeps agent/runtime and OpenCode model controls separate', () => {
    assert.match(src, /className="ai-control-trigger composer-chip agent-chip"/, 'compact agent control missing');
    assert.match(src, /className="composer-chip model-chip"/, 'compact model control missing');
    assert.match(src, /className="composer-chip mode-access-chip"/, 'compact mode/access control missing');
    assert.match(src, /const \[aiPickerView, setAiPickerView\] = useState<'agent' \| 'model'>\('model'\)/, 'picker view state missing');
    assert.match(src, /aria-label="Choose AI agent"/, 'agent picker missing');
    assert.match(src, /aria-label="Choose OpenCode model"/, 'OpenCode model picker missing');
    assert.match(src, /displayName: 'Cline'/, 'Cline placeholder missing');
    assert.match(src, /displayName: 'OpenAI'/, 'OpenAI placeholder missing');
    assert.match(src, /displayName: 'Claude'/, 'Claude placeholder missing');
    assert.match(src, /displayName: 'Other'/, 'Other placeholder missing');
    assert.match(src, /openCodeModels = available\.filter/, 'models are not scoped to OpenCode');
    assert.doesNotMatch(src, /className="inline-agent-picker"/, 'legacy native agent picker returned');
    assert.doesNotMatch(src, /className="inline-model-picker"/, 'legacy native model picker returned');
    assert.match(src, /const renderAiSwitcher = \(\) => session \? <ConnectAiSheet/, 'shared AI switcher renderer missing');
    assert.match(src, /composer-ai-dropdown view-\$\{aiPickerView\}/, 'AI switcher is not anchored to the composer');
    assert.match(src, /page !== 'workspace'.*ai-settings-switcher-anchor/, 'settings AI switcher fallback missing');
  });

  it('routes model recovery back into the unified AI controls', () => {
    assert.match(src, /onOpenModels=\{\(\) => \{ setAiPickerView\('model'\); setShowConnectAI\(true\); \}\}/, 'per-message recovery does not open the model picker');
    const product = fs.readFileSync(path.join(root, 'apps/web/src/ui/product.tsx'), 'utf8');
    assert.match(product, /onClick=\{\(\) => \{ closeMenu\(\); props\.onOpenModels\(\); \}\}>Change model<\/button>/, 'Change model action missing from failed response menu');
    assert.doesNotMatch(src, /transcript-recovery-actions/, 'legacy global recovery block still present');
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


describe('chat and cloud reliability contract', () => {
  const src = fs.readFileSync(path.join(root, 'apps/web/src/ProductionApp.tsx'), 'utf8');

  it('starts or reconnects a cloud workspace once and observes progress instead of POST-looping', () => {
    const start = src.indexOf('async function startCloud(');
    const end = src.indexOf('async function stopRun()', start);
    const block = src.slice(start, end);
    assert.match(block, /fetch\(\`\/v1\/sessions\/\$\{sessionId\}\/cloud/);
    assert.doesNotMatch(block, /while \(workspace\?\.state/);
    assert.doesNotMatch(block, /setTimeout\(resolve, 2_000\)/);
    assert.match(src, /setInterval\(async \(\) =>[\s\S]*?\/v1\/sessions\/\$\{encodeURIComponent\(session\.id\)\}/);
  });

  it('preserves streamed tokens per run through the canonical protocol store', () => {
    assert.match(src, /pendingRef\.current\.splice\(0\)\.sort/);
    assert.match(src, /applyRawAgentEvents\(current, batch\)/);
    assert.match(src, /reconcileAgentStream\(current, runData, messageData\)/);
    assert.match(src, /selectLiveReplies\(agentStream, messages\)/);
    assert.doesNotMatch(src, /const \[draftReply, setDraftReply\]/);
    assert.doesNotMatch(src, /applyLiveReplyEvents/);
  });

  it('keeps session refresh single-flight while canonical reconciliation rejects stale snapshots', () => {
    assert.match(src, /sessionRefreshesRef = useRef\(new Map<string, Promise<void>>\(\)\)/);
    assert.match(src, /const inFlight = sessionRefreshesRef\.current\.get\(id\)/);
    const helper = fs.readFileSync(path.join(root, 'apps/web/src/agent-stream/store.ts'), 'utf8');
    assert.match(helper, /prior\.text\.startsWith\(snapshot\)/);
    assert.match(helper, /snapshot\.startsWith\(prior\.text\)/);
    assert.match(helper, /snapshotAt < prior\.lastEventAt/);
    assert.match(helper, /event\.sequence && event\.sequence <= prior\.lastSequence/);
  });

  it('keeps raw provider lifecycle out of React and routes it through an adapter first', () => {
    const adapter = fs.readFileSync(path.join(root, 'apps/web/src/agent-stream/adapter.ts'), 'utf8');
    assert.match(adapter, /normalizeOrlynxEvent/);
    assert.match(adapter, /TEXT_CONTENT/);
    assert.match(adapter, /TOOL_START/);
    assert.match(adapter, /WORKSPACE_STATE/);
    assert.doesNotMatch(src, /switch \(item\.type\)/);
  });
});
