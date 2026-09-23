// Level 2 — Orlynx product components. Composed from primitives + tokens only.
import React from 'react';
import { Badge, Button, Card, Icon } from './primitives';
import { runTone } from './mapping';

export function AgentStatusPill({ state, elapsed }: { state: string; elapsed?: string }) {
  const { tone, label } = runTone(state);
  return <Badge tone={tone}>{label}{elapsed ? ` · ${elapsed}` : ''}</Badge>;
}

export function CloudStatus({ state }: { state?: string }) {
  if (!state) return <Badge>Repository ready</Badge>;
  if (state === 'ready') return <Badge tone="ok">Cloud ready</Badge>;
  if (state === 'preparing') return <Badge tone="work">Preparing workspace</Badge>;
  if (state === 'reconnecting') return <Badge tone="wait">Reconnecting</Badge>;
  if (state === 'stopped') return <Badge>Cloud stopped</Badge>;
  return <Badge tone="fail">Cloud {state}</Badge>;
}

export function TaskActivityRow({ label, detail, state }: { label: string; detail?: string; state: 'done' | 'active' | 'todo' | 'fail' }) {
  return (
    <div className="ox-activity" data-state={state}>
      <span className="mark" aria-hidden>{state === 'done' ? <Icon name="check" /> : state === 'fail' ? <Icon name="x" /> : state === 'active' ? <Icon name="dot" /> : <Icon name="ring" />}</span>
      <div><div>{label}</div>{detail && <div className="small">{detail}</div>}</div>
    </div>
  );
}

export function AgentApprovalCard({ title, detail, onApprove, onCancel, busy }: { title: string; detail?: string; onApprove: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <Card role="group" aria-label={`Approval: ${title}`}>
      <div className="ox-row"><Icon name="warn" /><b>{title}</b></div>
      {detail && <div className="small" style={{ margin: '6px 0' }}>{detail}</div>}
      <div className="ox-row">
        <Button tone="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={onApprove} disabled={busy}>{busy ? 'Approving…' : 'Approve & push'}</Button>
      </div>
    </Card>
  );
}

export function AgentErrorCard({ title, hint, onRetry, onReconnect }: { title: string; hint?: string; onRetry?: () => void; onReconnect?: () => void }) {
  return (
    <Card role="alert">
      <div className="ox-row"><Icon name="x" /><b>{title}</b></div>
      {hint && <div className="small" style={{ margin: '6px 0' }}>{hint} Your changes are preserved.</div>}
      <div className="ox-row">
        {onReconnect && <Button onClick={onReconnect}>Reconnect workspace</Button>}
        {onRetry && <Button tone="ghost" onClick={onRetry}>View logs</Button>}
      </div>
    </Card>
  );
}

export function DiffSummary({ files }: { files: { path: string; action: string }[] }) {
  if (!files.length) return <div className="small">No changes yet. Ask the agent to edit.</div>;
  return (
    <div>
      <b>{files.length} file{files.length === 1 ? '' : 's'} changed</b>
      {files.map((f) => (
        <div key={f.path} className="ox-row" style={{ justifyContent: 'space-between' }}>
          <span><Icon name="file" /> {f.path}</span>
          <Badge tone={f.action === 'delete' ? 'fail' : f.action === 'create' ? 'ok' : 'neutral'}>{f.action}</Badge>
        </div>
      ))}
    </div>
  );
}

export function AttachmentChip({ name, state }: { name: string; state?: 'attached' | 'agent' }) {
  return <Badge tone={state === 'agent' ? 'ok' : 'neutral'}><Icon name="file" /> {name} · {state === 'agent' ? 'Available to agent' : 'Attached'}</Badge>;
}

export function PreviewStatus({ available }: { available: boolean }) {
  return available ? <Badge tone="ok">Preview available</Badge> : <Badge>No preview</Badge>;
}

export function CloudWorkspaceButton({ state, onStart }: { state?: string; onStart: () => void }) {
  if (state === 'ready') return <Badge tone="ok"><Icon name="cloud" /> Cloud ready</Badge>;
  if (state === 'preparing') return <Badge tone="work"><Icon name="cloud" /> Preparing workspace…</Badge>;
  return <Button onClick={onStart}>Work on cloud</Button>;
}

export function SessionResumeCard({ project, branch, onOpen }: { project: string; branch: string; onOpen: () => void }) {
  return (
    <Card>
      <div className="ox-row"><b>{project}</b><Badge>{branch}</Badge></div>
      <div className="ox-row" style={{ marginTop: 8 }}><Button tone="ghost" onClick={onOpen}>Resume session</Button></div>
    </Card>
  );
}
