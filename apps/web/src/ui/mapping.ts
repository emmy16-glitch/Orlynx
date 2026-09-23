// Event → presentation mapping (pure, tested). Integrates with existing normalized
// schema (run/activity/tool/message/workspace/changes/receipt) — no backend change.
export type ActivityState = 'done' | 'active' | 'todo' | 'fail';
export interface ActivityItem { key: string; label: string; detail?: string; state: ActivityState; }

const DONE_ICON = '✓';

// Maps raw Orlynx events to a compact, progressive-disclosure activity list.
// Collapses 200 file reads into "Inspected repository — N files examined".
export function toActivities(events: { type: string; payload?: Record<string, unknown> }[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let fileReads = 0;
  let testsPassed: number | undefined;
  let testsFailed: number | undefined;
  let lastTool = '';

  for (const e of events) {
    const p = e.payload || {};
    switch (e.type) {
      case 'activity.started':
      case 'activity.progress':
        items.push({ key: `${e.type}-${items.length}`, label: String(p.text || 'Working'), state: 'active' });
        break;
      case 'tool.started':
        lastTool = String(p.tool || 'tool');
        items.push({ key: `tool-${items.length}`, label: labelForTool(lastTool), detail: detailForTool(lastTool, p), state: 'active' });
        break;
      case 'tool.completed':
      case 'tool.output':
        markLastActiveDone(items);
        break;
      case 'tool.failed':
        markLastActiveFail(items);
        break;
      case 'message.delta':
        break; // text streams into chat, not the activity rail
      case 'run.completed':
        markAllActiveDone(items);
        items.push({ key: `run-${items.length}`, label: String((p as { summary?: string }).summary || 'Done — review Changes'), state: 'done' });
        break;
      case 'run.failed':
        markAllActiveFail(items);
        items.push({ key: `runf-${items.length}`, label: (p as { cancelled?: boolean }).cancelled ? 'Run cancelled' : 'Run failed — retry available', state: 'fail' });
        break;
      case 'receipt.created':
        if (typeof p.code !== 'undefined') {
          const m = /(\d+)\s+passed|(\d+)\s+failed/gi;
          const s = String((p as { out?: string }).out || JSON.stringify(p));
          let mm: RegExpExecArray | null;
          while ((mm = m.exec(s))) {
            if (/passed/i.test(mm[0])) testsPassed = Number(mm[1] || mm[2]);
            if (/failed/i.test(mm[0])) testsFailed = Number(mm[1] || mm[2]);
          }
        }
        break;
      case 'workspace.preparing':
        items.push({ key: `cloud-${items.length}`, label: 'Preparing cloud workspace', state: 'active' });
        break;
      case 'workspace.ready':
        markCloudDone(items);
        items.push({ key: `cloudr-${items.length}`, label: 'Cloud ready', state: 'done' });
        break;
      case 'file.changed':
        fileReads += 1;
        break;
      default:
        break;
    }
  }

  // Collapse: if many low-level reads, summarize once at top.
  if (fileReads > 3) {
    items.unshift({ key: 'inspect', label: `${DONE_ICON} Inspected repository`, detail: `${fileReads} files examined`, state: 'done' });
  }

  if (typeof testsPassed !== 'undefined' || typeof testsFailed !== 'undefined') {
    const t = testsFailed ? 'fail' : 'done';
    items.push({ key: 'tests', label: testsFailed ? 'Tests completed with failures' : 'Tests completed', detail: [testsPassed !== undefined && `${testsPassed} passed`, testsFailed !== undefined && `${testsFailed} failed`].filter(Boolean).join(' · '), state: t });
  }

  return dedupe(items).slice(-12);
}

function labelForTool(tool: string): string {
  if (/test/i.test(tool)) return 'Running tests';
  if (/build/i.test(tool)) return 'Building';
  if (/patch|edit|write/i.test(tool)) return 'Updating files';
  if (/search|read|inspect/i.test(tool)) return 'Searching repository';
  if (/exec|shell|command/i.test(tool)) return 'Running command';
  return `Running ${tool}`;
}

function detailForTool(tool: string, p: Record<string, unknown>): string | undefined {
  if (typeof p.cmd === 'string') return p.cmd.slice(0, 80);
  if (typeof p.path === 'string') return p.path;
  if (Array.isArray(p.files)) return `${(p.files as unknown[]).length} files`;
  void tool;
  return undefined;
}

function markLastActiveDone(items: ActivityItem[]) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].state === 'active') { items[i].state = 'done'; return; }
}
function markLastActiveFail(items: ActivityItem[]) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].state === 'active') { items[i].state = 'fail'; return; }
}
function markAllActiveDone(items: ActivityItem[]) {
  items.forEach((it) => { if (it.state === 'active') it.state = 'done'; });
}
function markAllActiveFail(items: ActivityItem[]) {
  items.forEach((it) => { if (it.state === 'active') it.state = 'fail'; });
}
function markCloudDone(items: ActivityItem[]) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].label.startsWith('Preparing cloud')) { items[i].state = 'done'; return; }
}
function dedupe(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = `${it.label}|${it.detail || ''}|${it.state}`;
    if (seen.has(k) && it.state !== 'fail') return false;
    seen.add(k);
    return true;
  });
}

// Run-state → pill tone/label (single source of truth for agent status).
export function runTone(state: string): { tone: 'work' | 'ok' | 'fail' | 'wait' | 'neutral'; label: string } {
  switch (state) {
    case 'running': case 'queued': return { tone: 'work', label: 'Agent working' };
    case 'waiting_input': case 'waiting_approval': return { tone: 'wait', label: 'Waiting for you' };
    case 'paused': return { tone: 'neutral', label: 'Paused' };
    case 'interrupted': return { tone: 'wait', label: 'Interrupted — resume' };
    case 'completed': return { tone: 'ok', label: 'Done' };
    case 'failed': case 'cancelled': return { tone: 'fail', label: state === 'cancelled' ? 'Stopped' : 'Failed' };
    default: return { tone: 'neutral', label: 'Idle' };
  }
}
