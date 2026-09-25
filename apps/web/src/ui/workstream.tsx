// Level 3 — Experience: AgentWorkStream + LiveActivityPill (live, reconnect-safe).
import React, { useMemo, useState } from 'react';
import { runTone, toActivities } from './mapping';
import { TaskActivityRow, type ActivityDetailMode } from './product';
import { Badge, Button, Card, Icon } from './primitives';

const ACTIVITY_DETAIL_KEY = 'orlynx:activity-detail-mode';

export function useActivityDetailMode(defaultMode: ActivityDetailMode = 'summary') {
  const [mode, setMode] = useState<ActivityDetailMode>(() => {
    if (typeof window === 'undefined') return defaultMode;
    try {
      const saved = window.localStorage.getItem(ACTIVITY_DETAIL_KEY);
      if (saved === 'summary' || saved === 'code') return saved;
    } catch {}
    return defaultMode;
  });
  const choose = (next: ActivityDetailMode) => {
    setMode(next);
    try { window.localStorage.setItem(ACTIVITY_DETAIL_KEY, next); } catch {}
  };
  return [mode, choose] as const;
}

export function ActivityDetailToggle({ mode, onChange }: { mode: ActivityDetailMode; onChange: (mode: ActivityDetailMode) => void }) {
  return <div className="ox-activity-mode" role="group" aria-label="Activity detail">
    {(['summary', 'code'] as ActivityDetailMode[]).map((value) => <button key={value} type="button" className={mode === value ? 'selected' : ''} aria-pressed={mode === value} onClick={() => onChange(value)}>{value === 'summary' ? 'Summary' : 'Code'}</button>)}
  </div>;
}

export function AgentWorkStream({ events, defaultDetailMode = 'summary' }: { events: { type: string; payload?: Record<string, unknown>; eventId?: string; sequence?: number; runId?: string; timestamp?: string }[]; defaultDetailMode?: ActivityDetailMode }) {
  const [expanded, setExpanded] = useState(false);
  const [detailMode, setDetailMode] = useActivityDetailMode(defaultDetailMode);
  const items = useMemo(() => toActivities(events), [events]);
  if (!items.length) return <div className="small" role="status">No agent activity yet.</div>;
  const currentIndex = items.reduce((current, item, index) => item.state === 'running' || item.state === 'waiting' ? index : current, -1);
  const startAt = expanded ? 0 : Math.max(0, Math.min(items.length - 7, currentIndex >= 0 ? currentIndex - 3 : items.length - 7));
  const visible = expanded ? items : items.slice(startAt, Math.max(startAt + 7, currentIndex + 1));
  const hidden = items.length - visible.length;
  const last = items[items.length - 1];
  const announcement = last.state === 'failed' ? `${last.title}${last.summary ? `. ${last.summary}` : ''}`
    : last.state === 'success' && ['test', 'build', 'agent', 'error'].includes(last.category) ? `${last.title}${last.summary ? `. ${last.summary}` : ''}`
      : '';
  return (
    <Card>
      <div className="ox-workstream-toolbar">
        <span className="small">Activity</span>
        <ActivityDetailToggle mode={detailMode} onChange={setDetailMode} />
      </div>
      <div className="ox-stream">
        {visible.map((item) => <TaskActivityRow key={item.key} item={item} detailMode={detailMode} isCurrent={items.indexOf(item) === currentIndex} />)}
      </div>
      {hidden > 0 && <Button tone="ghost" onClick={() => setExpanded(true)}>Show {hidden} earlier updates</Button>}
      {expanded && <Button tone="ghost" onClick={() => setExpanded(false)}>Show recent activity</Button>}
      <span className="ox-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </Card>
  );
}

export function LiveActivityPill({ active, label, status = active ? 'running' : 'idle', elapsed, onOpen, onPause, onStop }: { active: boolean; label: string; status?: string; elapsed?: string; onOpen: () => void; onPause?: () => void; onStop?: () => void }) {
  const [open, setOpen] = useState(false);
  const { tone, label: statusLabel } = runTone(status);
  return (
    <div className="ox-live-wrap">
      <div className="ox-live" data-tone={tone}>
        <Icon name={active ? 'dot' : status === 'completed' ? 'check' : status === 'failed' ? 'x' : 'ring'} />
        <button onClick={() => { setOpen(!open); onOpen(); }} aria-expanded={open}>{statusLabel}{elapsed ? ` · ${elapsed}` : ''}</button>
        <span className="ox-live-task">{label}</span>
        {active && onPause && <Button tone="ghost" onClick={onPause}>Pause</Button>}
        {active && onStop && <Button tone="ghost" onClick={onStop}>Stop</Button>}
      </div>
      {open && <div className="ox-live-detail"><Badge tone={tone}>{statusLabel}</Badge><span>{label}</span>{active && <span className="small">Current task. You can keep reading while activity continues below.</span>}</div>}
    </div>
  );
}

export function CloudTransition({ state }: { state?: string }) {
  const steps = ['Work on cloud', 'Preparing workspace', 'Connecting agent', 'Cloud ready'];
  const idx = !state ? 0 : state === 'preparing' ? 1 : state === 'ready' ? 3 : 2;
  return (
    <Card aria-label={`Cloud status: ${state || 'repository'}`}>
      <div className="ox-row">
        {steps.slice(0, idx + 1).map((s, i) => (
          <React.Fragment key={s}>
            <Badge tone={i < idx ? 'ok' : i === idx ? 'work' : 'neutral'}>{s}</Badge>
            {i < idx && <span aria-hidden>→</span>}
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
}
