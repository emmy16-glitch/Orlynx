import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const webSrc = path.join(root, 'apps/web/src');
const app = () => fs.readFileSync(path.join(webSrc, 'ProductionApp.tsx'), 'utf8');
const product = () => fs.readFileSync(path.join(webSrc, 'ui/product.tsx'), 'utf8');
const css = () => fs.readFileSync(path.join(webSrc, 'styles.css'), 'utf8');

describe('contextual message actions (§§142-143, 161, 171-173)', () => {
  it('assistant responses carry a quiet attached action row', () => {
    // Thread turns attach actions to the durable assistant message they own.
    assert.match(app(), /<AssistantMessageActions text=\{visibleChatText\('assistant', durable\.text, priorUserPrompt\)\}/);
    assert.match(product(), /className="message-actions" role="group" aria-label="Response actions"/);
    assert.match(css(), /\.message-actions \{[\s\S]*?opacity: 0\.78/);
  });

  it('primary set stays at 2-4 controls; the rest hides in More', () => {
    const src = product();
    assert.match(src, /: 'Copy'\}/);
    assert.match(src, /aria-label=\{retryAria\}/);
    assert.match(src, /aria-label="More actions"/);
    assert.match(src, /<MsgMenu label="More actions" onClose=\{closeMenu\}>/);
    assert.doesNotMatch(src, /Thumbs|Share|Speak|read-aloud/i);
  });

  it('user messages get minimal Copy + Edit & resend only', () => {
    assert.match(app(), /<UserMessageActions text=\{userText\} onEdit=\{/);
    assert.match(product(), /aria-label="Edit and resend as a new message"/);
  });

  it('technical activity rows are not given message action bars', () => {
    // Typed work parts render through the part registry; message actions
    // attach only to the turn's durable assistant response.
    assert.doesNotMatch(product(), /PartRow[\s\S]{0,500}?AssistantMessageActions/);
    const src = app();
    const partRow = src.indexOf('<PartRow part={part} onResolveApproval={resolveApproval} />');
    assert.ok(partRow > 0);
    assert.doesNotMatch(src.slice(partRow - 200, partRow + 200), /MessageActions/);
  });
});

describe('retry semantics (§§144-149, 175-178, 183, 185)', () => {
  it('retry attaches to the latest response and never streams', () => {
    assert.match(product(), /const showRetry = !props\.runActive && props\.isLatest && Boolean\(props\.userPrompt\)/);
    assert.match(app(), /onRetry=\{\(\) => retryMessage\(durable\.id, priorUserPrompt\)\}/);
  });

  it('retry is idempotent with pending/failed states', () => {
    const src = app();
    assert.match(src, /if \(retrying\[messageId\] \|\| submittingRef\.current \|\| sending\) return;/);
    assert.match(src, /async function sendMessage\(overrideText\?: string\): Promise<boolean>/);
    assert.match(src, /const ok = await sendMessage\(text\);/);
    assert.match(product(), /Retrying…/);
    assert.match(product(), /Retry couldn’t start\. The previous result is unchanged\./);
  });

  it('build-with-changes uses an honest two-step resume confirm', () => {
    assert.match(app(), /buildWithChanges = \(lastRun\?\.mode \|\| ai\.mode\) === 'build' && changesCount > 0/);
    assert.match(app(), /resumeLabel=\{isLatestAssistant && buildWithChanges \? `Resume with/);
    assert.match(product(), /aria-label="Confirm resume"/);
    assert.match(product(), /'Resume task from current state'/);
    assert.doesNotMatch(app(), /transcript-recovery-actions/);
  });

  it('failure recovery sits beside the failure, once', () => {
    assert.match(product(), /onClick=\{props\.onOpenModels\}>Change model<\/button>/);
    assert.match(product(), /runCancelled \? 'Run again'/);
    assert.equal((product().match(/Change model/g) || []).length, 1);
    assert.equal((app().match(/Change model/g) || []).length, 0);
  });

  it('resend creates a new attempt; history is never rewritten', () => {
    assert.match(app(), /overrideText \?\? composer/);
    assert.match(app(), /if \(!overrideText\) \{ setComposer\(''\);/);
    assert.match(app(), /history is never\s*\n?\s*\/\/? ?rewritten|never\s*\n.*rewritten/s);
  });
});

describe('copy, menu, a11y (§§150, 155-156, 165-168, 184)', () => {
  it('copy uses readable text with brief inline confirmation', () => {
    const src = product();
    assert.match(src, /navigator.*clipboard.*writeText|clipboard\?\.writeText/);
    assert.match(src, /fallbackCopy/);
    assert.match(src, /Copied<\/span>/);
    assert.match(src, /setTimeout\(\(\) => setCopied\(false\), 1500\)/);
    assert.doesNotMatch(src, /toast/i);
  });

  it('more menu holds only supported actions and closes correctly', () => {
    const src = product();
    assert.match(src, /Copy response<\/button>/);
    assert.match(src, /View run details<\/button>/);
    assert.match(src, /View \{props\.changesCount\} changed file/);
    assert.doesNotMatch(src, /Branch from here|Report problem|Read aloud/i);
    assert.match(src, /window\.addEventListener\('pointerdown', onPointer\)/);
    assert.match(src, /if \(event\.key === 'Escape'\) onClose\(\)/);
    assert.match(src, /moreRef\.current\.focus\(\)/);
  });

  it('run details stay behind progressive disclosure', () => {
    assert.match(product(), /className="msg-run-details"/);
    assert.match(product(), /aria-expanded=\{showDetails\}/);
    assert.doesNotMatch(product(), /adapter|bridge|heartbeat|OpenCode/i);
  });

  it('icons are labeled; touch targets stay tappable without bulk', () => {
    const src = product();
    assert.match(src, /aria-label="Copy response"/);
    assert.match(src, /aria-label="More actions"/);
    assert.match(src, /aria-label=\{copied \? 'Copied message' : 'Copy message'\}/);
    assert.match(src, /title=\{copied \? 'Copied' : 'Copy'\}/);
    assert.match(src, /title="Edit and resend"/);
    const source = css();
    assert.match(source, /\.msg-action \{[\s\S]*?min-width: 40px;\s*min-height: 40px;/);
    assert.match(source, /\.msg-menu > button \{[\s\S]*?min-height: 44px;/);
    assert.match(source, /\.msg-menu \{[\s\S]*?max-width: min\(260px, calc\(100vw - 32px\)\)/);
    assert.match(source, /\.msg-menu \{[\s\S]*?bottom: calc\(100% \+ 6px\)/);
  });

  it('edit & resend preserves history and focuses the composer', () => {
    assert.match(app(), /function editAndResend\(text: string\) \{[\s\S]*?setComposer\(text\);[\s\S]*?composerBoxRef\.current\?\.focus\(\)/);
  });
});
