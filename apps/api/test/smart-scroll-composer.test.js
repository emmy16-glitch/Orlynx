import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEAR_BOTTOM_PX, distanceFromBottom, followAfterContentGrowth, followAfterUserScroll,
  isFollowWorthyEvent, isNearBottom, jumpBehavior,
} from '../../web/src/ui/scroll.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const webSrc = path.join(root, 'apps/web/src');
const app = () => fs.readFileSync(path.join(webSrc, 'ProductionApp.tsx'), 'utf8');
const css = () => fs.readFileSync(path.join(webSrc, 'styles.css'), 'utf8');

describe('live-follow geometry (§§89-91)', () => {
  it('near-bottom tolerance covers mobile imprecision', () => {
    assert.equal(NEAR_BOTTOM_PX, 140);
    assert.equal(isNearBottom(0), true);
    assert.equal(isNearBottom(139), true);
    assert.equal(isNearBottom(140), false);
    assert.equal(isNearBottom(500), false);
  });

  it('distance math never goes negative', () => {
    assert.equal(distanceFromBottom(1000, 860, 140), 0);
    assert.equal(distanceFromBottom(1000, 700, 140), 160);
    assert.equal(distanceFromBottom(100, 0, 800), 0);
  });

  it('user scroll intent alone flips follow state', () => {
    assert.equal(followAfterUserScroll(20), true);
    assert.equal(followAfterUserScroll(400), false);
  });

  it('§91: content growth never flips follow state by itself', () => {
    assert.equal(followAfterContentGrowth(true), true);
    assert.equal(followAfterContentGrowth(false), false);
  });
});

describe('only visible content moves the viewport (§103)', () => {
  it('assistant deltas are follow-worthy; stream markers are not', () => {
    assert.equal(isFollowWorthyEvent('message.delta', { delta: 'hi' }), true);
    assert.equal(isFollowWorthyEvent('message.start', {}), false);
    assert.equal(isFollowWorthyEvent('message.end', {}), false);
    assert.equal(isFollowWorthyEvent('state.snapshot', {}), false);
  });

  it('§103/TEST 14: repeated ready heartbeats never scroll', () => {
    for (let i = 0; i < 100; i++) {
      assert.equal(isFollowWorthyEvent('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'ready' }), false);
    }
  });

  it('meaningful adapter transitions may surface; steady state may not', () => {
    assert.equal(isFollowWorthyEvent('state.delta', { scope: 'agent-adapter', state: 'starting' }), true);
    assert.equal(isFollowWorthyEvent('state.delta', { scope: 'agent-adapter', state: 'unavailable', reason: 'down' }), true);
    assert.equal(isFollowWorthyEvent('state.delta', { scope: 'bridge', state: 'ready' }), false);
    assert.equal(isFollowWorthyEvent('state.delta', { scope: 'bridge', state: 'disconnected' }), true);
  });

  it('runs, tools, workspace, approvals and files are follow-worthy', () => {
    for (const type of ['run.started', 'run.completed', 'tool.started', 'tool.output', 'workspace.preparing', 'workspace.ready', 'activity.progress', 'approval.required', 'receipt.created', 'file.changed', 'changes.updated']) {
      assert.equal(isFollowWorthyEvent(type, {}), true, type);
    }
    assert.equal(isFollowWorthyEvent('something.unknown', {}), false);
  });

  it('reduced-motion jump is instant; otherwise smooth', () => {
    assert.equal(jumpBehavior(), 'smooth'); // node has no matchMedia
    const src = fs.readFileSync(path.join(webSrc, 'ui/scroll.ts'), 'utf8');
    assert.match(src, /prefers-reduced-motion: reduce/);
  });
});

describe('wired follow behavior in ProductionApp (§§83-88, 94-96, 100)', () => {
  it('scroll listener tracks intent; growth never writes follow state', () => {
    const src = app();
    assert.match(src, /followAfterUserScroll\(distance\)/);
    assert.match(src, /distanceFromBottom\(document\.documentElement\.scrollHeight/);
    assert.match(src, /import \{ distanceFromBottom, followAfterUserScroll, isFollowWorthyEvent, jumpBehavior \} from '\.\/ui\/scroll'/);
  });

  it('New activity raises only for visible batches', () => {
    assert.match(app(), /batch\.some\(\(item\) => isFollowWorthyEvent\(item\.type, item\.payload\)\)/);
  });

  it('§88: live pin is instant rAF, never smooth-per-token', () => {
    const src = app();
    const at = src.indexOf('FOLLOWING_LIVE pin');
    const block = src.slice(at, at + 600);
    assert.match(block, /requestAnimationFrame\(\(\) => window\.scrollTo\(\{ top: document\.documentElement\.scrollHeight \}\)\)/);
    assert.doesNotMatch(block, /scrollTo\(\{[^}]*behavior/);
  });

  it('§85/100: jump-to-latest resumes follow with motion-aware behavior', () => {
    assert.match(app(), /nearBottomRef\.current = true; window\.scrollTo\(\{ top: document\.documentElement\.scrollHeight, behavior: jumpBehavior\(\) \}\)/);
  });

  it('§87/96: latest content keeps breathing room above the fixed composer', () => {
    const source = css();
    assert.match(source, /\.conversation \{\s*padding-bottom: 150px/);
    assert.match(source, /\.is-workspace\.has-active-work \.conversation \{\s*padding-bottom: 208px/);
    assert.match(source, /@media \(max-width: 760px\) \{\s*\.conversation \{\s*padding-bottom: 232px/);
  });
});

describe('compact expanding composer (§§109-140)', () => {
  it('idle vs expanded states exist and draft survives blur', () => {
    const src = app();
    assert.match(src, /const \[composerFocused, setComposerFocused\] = useState\(false\)/);
    assert.match(src, /const composerExpanded = composerFocused \|\| composer\.length > 0 \|\| sending/);
    assert.match(src, /className=\{`composer \$\{composerExpanded \? 'is-expanded' : 'is-idle'\}`\}/);
    assert.match(src, /onFocus=\{\(\) => setComposerFocused\(true\)\}/);
    assert.match(src, /onBlur=\{\(\) => setComposerFocused\(false\)\}/);
    assert.match(src, /localStorage\.setItem\(draftKey\(session\.id\), event\.target\.value\)/);
  });

  it('textarea auto-grows, caps viewport-aware, scrolls internally', () => {
    const src = app();
    assert.match(src, /composerBoxRef\.current/);
    assert.match(src, /el\.style\.height = `\$\{el\.scrollHeight\}px`/);
    assert.match(src, /rows=\{1\}/);
    const source = css();
    assert.match(source, /\.composer textarea \{\s*max-height: min\(30vh, 200px\);\s*overflow-y: auto/);
  });

  it('keeps agent, model and mode visible as compact stable controls', () => {
    const src = app();
    assert.match(src, /className="ai-control-trigger composer-chip agent-chip"/);
    assert.match(src, /className="composer-chip model-chip"/);
    assert.match(src, /className="composer-chip mode-access-chip"/);
    assert.match(src, /aria-label="Choose AI agent and model"/);
    assert.match(src, /\{ai\.mode === 'build' \? 'Build' : ai\.mode === 'plan' \? 'Plan' : 'Ask'\}/);
    assert.match(src, /ai\.mode === 'build' && ai\.permission === 'ask-first' && aiAccountConnected && composerExpanded/);
  });

  it('send stays anchored; Enter/Shift+Enter/IME untouched', () => {
    const src = app();
    assert.match(src, /<Button className="composer-send" type="submit"/);
    assert.match(src, /event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing && event\.nativeEvent\.keyCode !== 229/);
    assert.match(src, /placeholder=\{!online \? 'Offline — draft saved' : !aiAccountConnected \|\| !ai\.model \? 'Connect AI to start' : `Ask Orlynx anything…`\}/);
  });

  it('focus ring is subtle; press uses the calm motion token', () => {
    const source = css();
    assert.match(source, /\.composer:focus-within \{\s*border-color: var\(--primary\)/);
    assert.match(source, /\.composer \{\s*transition: border-color var\(--motion-fast\)/);
    assert.match(source, /\.composer\.is-idle \{\s*min-height: 52px/);
    assert.match(source, /\.composer-chip \{[\s\S]*?min-height: 30px/);
  });
});
