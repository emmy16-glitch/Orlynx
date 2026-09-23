// Level 3 — Experience: AgentWorkStream + LiveActivityPill (live, reconnect-safe).
import React, { useMemo, useState } from 'react';
import { toActivities } from './mapping';
import { TaskActivityRow } from './product';
import { Badge, Button, Card, Icon } from './primitives';

export function AgentWorkStream({ events }: { events: { type: string; payload?: Record<string, unknown>; eventId?: string; sequence?: number }[] }) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => toActivities(events), [events]);
  if (!items.length) return <div className="small" role="status">No agent activity yet.</div>;
  const visible = expanded ? items : items.slice(-5);
  const hidden = items.length - visible.length;
  return (
    <Card>
      {/* aria-live polite: announces progress without chattering on every token */}
      <div aria-live="polite" className="ox-stream">
        {visible.map((it, i) => <TaskActivityRow key={`${it.key}-${i}`} label={it.label} detail={it.detail} state={it.state} />)}
      </div>
      {hidden > 0 && <Button tone="ghost" onClick={() => setExpanded(true)}>Show {hidden} earlier steps</Button>}
      {expanded && <Button tone="ghost" onClick={() => setExpanded(false)}>Collapse</Button>}
    </Card>
  );
}

export function LiveActivityPill({ active, label, elapsed, onOpen, onPause, onStop }: { active: boolean; label: string; elapsed?: string; onOpen: () => void; onPause?: () => void; onStop?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!active) return null;
  return (
    <>
      <div className="ox-pill-float" role="status" aria-label={`Agent working: ${label}`}>
        <Icon name="dot" />
        <button onClick={() => { setOpen(!open); onOpen(); }} style={{ background: 'none', border: 0, color: 'inherit', font: 'inherit' }} aria-expanded={open}>
          Agent working{elapsed ? ` · ${elapsed}` : ''}
        </button>
        {onPause && <Button tone="ghost" onClick={onPause}>Pause</Button>}
        {onStop && <Button tone="ghost" onClick={onStop}>Stop</Button>}
      </div>
      {open && (
        <Card>
          <div className="ox-row"><Badge tone="work">{label}</Badge></div>
          <div className="small">Tap Stop to cancel the current run. Completed work is preserved.</div>
        </Card>
      )}
    </>
  );
}

export function CloudTransition({ state }: { state?: string }) {
  const steps = ['Work on cloud', 'Preparing workspace', 'Connecting agent', 'Cloud ready'];
  const idx = !state ? 0 : state === 'preparing' ? 1 : state === 'ready' ? 3 : 2;
  return (
    <Card aria-label={`Cloud status: ${state || 'repository'}`}>
      <div className="ox-row">
        {steps.map((s, i) => (
          <React.Fragment key={s}>
            <Badge tone={i < idx ? 'ok' : i === idx ? 'work' : 'neutral'}>{s}</Badge>
            {i < steps.length - 1 && <span aria-hidden>→</span>}
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
}
