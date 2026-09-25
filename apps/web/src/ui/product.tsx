// Level 2 — Orlynx product components. Composed from primitives + tokens only.
import React from 'react';
import { Badge, Button, Card, Icon } from './primitives';
import { runTone, toState, type ActivityItem } from './mapping';

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

export type ActivityDetailMode = 'summary' | 'code';

export function TaskActivityRow({ item, detailMode = 'summary', isCurrent = false }: { item: ActivityItem; detailMode?: ActivityDetailMode; isCurrent?: boolean }) {
  const [showEvidence, setShowEvidence] = React.useState(detailMode === 'code');
  const [showRaw, setShowRaw] = React.useState(false);
  React.useEffect(() => {
    if (detailMode === 'code') setShowEvidence(true);
  }, [detailMode, item.id]);

  const { title, summary, evidence, rawOutput, category, state } = item;
  const uiState = toState(state);
  const files = Array.isArray(evidence?.files) ? evidence.files as { path: string; action?: string; diff?: string }[] : [];
  const failures = Array.isArray(evidence?.failures) ? evidence.failures as string[] : [];
  const command = typeof evidence?.command === 'string' ? evidence.command : '';
  const path = typeof evidence?.path === 'string' ? evidence.path : '';
  const toolTitle = typeof evidence?.toolTitle === 'string' ? evidence.toolTitle : '';
  const hasEvidence = Boolean(evidence && Object.keys(evidence).length);
  const detailsVisible = detailMode === 'code' || showEvidence;
  const technical = Boolean(command || path || files.length || failures.length || rawOutput || typeof evidence?.exitCode === 'number');

  const details = detailsVisible && (hasEvidence || rawOutput) ? <div className={`ox-evidence ${detailMode === 'code' ? 'ox-evidence-code' : ''}`}>
    {toolTitle && detailMode === 'code' && toolTitle !== title && <div className="ox-code-caption">{toolTitle}</div>}
    {command && <div className="ox-code-block">
      <span className="ox-code-label">Command</span>
      <pre className="ox-command" aria-label="Command"><span aria-hidden>$ </span>{command}</pre>
    </div>}
    {path && <div className="ox-code-path"><span className="ox-code-label">Path</span><code>{path}</code></div>}
    {typeof evidence?.exitCode === 'number' && <div className="small">Exit code {evidence.exitCode}</div>}
    {typeof evidence?.passed === 'number' && <div className="small">{evidence.passed} passed{typeof evidence.failed === 'number' ? ` · ${evidence.failed} failed` : ''}{typeof evidence.skipped === 'number' ? ` · ${evidence.skipped} skipped` : ''}</div>}
    {files.length > 0 && <div className="ox-code-files">
      <span className="ox-code-label">Files</span>
      <ul className="ox-file-list">{files.map((file) => <li key={file.path}><span aria-hidden>{file.action === 'delete' ? '−' : file.action === 'create' ? '+' : '~'}</span> <code>{file.path}</code></li>)}</ul>
      {files.filter((file) => Boolean(file.diff)).map((file, index) => <details className="ox-inline-diff" key={`diff:${file.path}`} open={detailMode === 'code' && index === 0}>
        <summary>{file.path} <span>{file.action || 'modify'}</span></summary>
        <pre aria-label={`Diff for ${file.path}`}>{file.diff}</pre>
      </details>)}
    </div>}
    {failures.length > 0 && <ul className="ox-failure-list">{failures.map((failure) => <li key={failure}>{failure}</li>)}</ul>}
    {rawOutput && <div className="ox-raw">
      <Button tone="ghost" className="ox-detail-toggle" aria-expanded={showRaw} onClick={() => setShowRaw((value) => !value)}>{showRaw ? 'Hide raw output' : 'Show raw output'}</Button>
      {showRaw && <pre aria-label="Raw command output">{rawOutput}</pre>}
    </div>}
  </div> : null;

  return (
    <div className="ox-activity" data-state={uiState} data-current={isCurrent ? 'true' : undefined}>
      <span className="mark" aria-hidden>{uiState === 'done' ? <Icon name="check" /> : uiState === 'fail' ? <Icon name="x" /> : uiState === 'active' && isCurrent ? <Icon name="dot" /> : <Icon name="ring" />}</span>
      <div className="ox-activity-content">
        <div className="ox-activity-title"><span>{title}</span>{isCurrent && <span className="ox-current-label">Current</span>}</div>
        {summary && <div className="small">{summary}</div>}
        {detailMode === 'summary' && (hasEvidence || rawOutput) && <Button tone="ghost" className="ox-detail-toggle" aria-expanded={showEvidence} onClick={() => setShowEvidence((value) => !value)}>{showEvidence ? 'Hide details' : category === 'file' ? 'View files' : category === 'test' ? 'View results' : category === 'approval' ? 'Review request' : technical ? 'View code & details' : 'View details'}</Button>}
        {details}
      </div>
    </div>
  );
}

export function AgentApprovalCard({ title, detail, onApprove, onCancel, busy }: { title: string; detail?: string; onApprove: () => void; onCancel?: () => void; busy?: boolean }) {
  return (
    <Card role="group" aria-label={`Approval: ${title}`}>
      <div className="ox-row"><Icon name="warn" /><b>{title}</b></div>
      {detail && <div className="small" style={{ margin: '6px 0' }}>{detail}</div>}
      <div className="ox-row">
        {onCancel && <Button tone="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button onClick={onApprove} disabled={busy}>{busy ? 'Approving…' : 'Approve changes'}</Button>
      </div>
    </Card>
  );
}

export function AgentErrorCard({ title, hint, onRetry, onReconnect, retryLabel = 'Retry' }: { title: string; hint?: string; onRetry?: () => void; onReconnect?: () => void; retryLabel?: string }) {
  return (
    <Card role="alert">
      <div className="ox-row"><Icon name="x" /><b>{title}</b></div>
      {hint && <div className="small" style={{ margin: '6px 0' }}>{hint} Your changes are preserved.</div>}
      <div className="ox-row">
        {onReconnect && <Button onClick={onReconnect}>Reconnect workspace</Button>}
        {onRetry && <Button tone="ghost" onClick={onRetry}>{retryLabel}</Button>}
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
