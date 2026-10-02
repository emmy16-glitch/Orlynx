// Level 2 — Orlynx product components. Composed from primitives + tokens only.
import React from 'react';
import { Badge, Button, Card, Icon } from './primitives';
import { runTone, toState, type ActivityItem } from './mapping';

/** Copy readable text only — never telemetry. Brief inline confirmation. */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = React.useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    };
    try {
      const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      if (clipboard?.writeText) { void clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done)); return; }
    } catch { /* fall through to legacy path */ }
    fallbackCopy(text, done);
  }, []);
  return { copied, copy };
}
function fallbackCopy(text: string, done: () => void) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  } catch { /* clipboard unavailable; leave state unchanged */ return; }
  done();
}

function MsgMenu({ onClose, children, label }: { onClose: () => void; children: React.ReactNode; label: string }) {
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={menuRef} className="msg-menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

export interface AssistantActions {
  text: string;
  userPrompt: string;
  isLatest: boolean;
  runActive: boolean;
  runFailed: boolean;
  runCancelled: boolean;
  modelIssue: boolean;
  resumeLabel: string | null; // non-null when Build-with-changes needs confirm
  changesCount: number;
  retryState: 'idle' | 'pending' | 'failed';
  runDetails: { model?: string; mode?: string; state?: string };
  onRetry: () => void;
  onOpenChanges: () => void;
  onOpenModels: () => void;
}

/** Quiet contextual row attached to a completed assistant response. */
export function AssistantMessageActions(props: AssistantActions) {
  const { copied, copy } = useCopyFeedback();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmResume, setConfirmResume] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);
  const moreRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => { if (!menuOpen && moreRef.current && document.activeElement?.closest?.('.msg-menu')) moreRef.current.focus(); }, [menuOpen]);
  const closeMenu = React.useCallback(() => setMenuOpen(false), []);

  const failed = props.runFailed || props.runCancelled;
  // Retry attaches to the latest completed response only, never while streaming.
  const showRetry = !props.runActive && props.isLatest && Boolean(props.userPrompt);
  const retryLabel = props.runCancelled ? 'Run again' : props.resumeLabel ? 'Resume task' : failed ? 'Retry' : 'Retry response';
  const retryAria = props.runCancelled ? 'Run again' : props.resumeLabel ? 'Resume task from current state' : failed ? 'Retry task' : 'Retry response';

  const startRetry = () => {
    if (props.resumeLabel && !confirmResume) { setConfirmResume(true); return; }
    setConfirmResume(false);
    props.onRetry();
  };

  return (
    <div className="message-actions assistant-actions" role="group" aria-label="Response actions">
      <button type="button" className="msg-action msg-icon-action assistant-action-icon" onClick={() => copy(props.text)} aria-label={copied ? 'Copied response' : 'Copy response'} title={copied ? 'Copied' : 'Copy'}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
      {showRetry && (
        props.retryState === 'pending' ? (
          <span className="msg-action msg-pending" role="status"><span className="ox-spinner msg-spinner" aria-hidden /> Retrying…</span>
        ) : (
          <button type="button" className="msg-action msg-icon-action assistant-action-icon" onClick={startRetry} aria-label={retryAria} title={retryLabel}>
            <Icon name="refresh" size={14} />
          </button>
        )
      )}
      <div className="msg-menu-wrap">
        <button ref={moreRef} type="button" className="msg-action msg-icon-action assistant-action-icon" aria-label="More actions" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => { setMenuOpen((v) => !v); setShowDetails(false); }}>
          <Icon name="more" size={14} />
        </button>
        {menuOpen && (
          <MsgMenu label="More actions" onClose={closeMenu}>
            <button type="button" role="menuitem" onClick={() => { copy(props.text); closeMenu(); }}>Copy response</button>
            {props.changesCount > 0 && (
              <button type="button" role="menuitem" onClick={() => { closeMenu(); props.onOpenChanges(); }}>
                View {props.changesCount} changed file{props.changesCount === 1 ? '' : 's'}
              </button>
            )}
            {failed && props.modelIssue && (
              <button type="button" role="menuitem" onClick={() => { closeMenu(); props.onOpenModels(); }}>Change model</button>
            )}
            <button type="button" role="menuitem" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>View run details</button>
            {showDetails && (
              <dl className="msg-run-details">
                {props.runDetails.model && (<><dt>Model</dt><dd>{props.runDetails.model}</dd></>)}
                {props.runDetails.mode && (<><dt>Mode</dt><dd>{props.runDetails.mode}</dd></>)}
                {props.runDetails.state && (<><dt>State</dt><dd>{props.runDetails.state}</dd></>)}
              </dl>
            )}
          </MsgMenu>
        )}
      </div>
      {confirmResume && props.resumeLabel && (
        <span className="msg-confirm" role="group" aria-label="Confirm resume">
          <span>{props.resumeLabel}</span>
          <button type="button" className="msg-action" onClick={() => setConfirmResume(false)}>Cancel</button>
          <button type="button" className="msg-action msg-confirm-go" onClick={startRetry}>Resume</button>
        </span>
      )}
      {props.retryState === 'failed' && !props.runActive && (
        <span className="msg-retry-note" role="status">Retry couldn’t start. The previous result is unchanged.</span>
      )}
    </div>
  );
}

export function UserMessageActions({ text, onEdit }: { text: string; onEdit: () => void }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <div className="message-actions user-actions" role="group" aria-label="Message actions">
      <button
        type="button"
        className="msg-action msg-icon-action user-action-icon"
        onClick={() => copy(text)}
        aria-label={copied ? 'Copied message' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy'}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
      <button
        type="button"
        className="msg-action msg-icon-action user-action-icon"
        onClick={onEdit}
        aria-label="Edit and resend as a new message"
        title="Edit and resend"
      >
        <Icon name="edit" size={14} />
      </button>
    </div>
  );
}

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
  // Observable work is visible by default. The transcript should show what the
  // agent actually did without forcing the user through empty disclosure rows.
  // Only duplicate raw output stays optional when richer structured evidence is
  // already visible.
  const [showRaw, setShowRaw] = React.useState(false);
  React.useEffect(() => {
    if (detailMode === 'code') setShowRaw(true);
  }, [detailMode, item.id]);

  const { title, summary, evidence, rawOutput, state, timestamp } = item;
  const timeLabel = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const uiState = toState(state);
  const files = Array.isArray(evidence?.files) ? evidence.files as { path: string; action?: string; diff?: string }[] : [];
  const failures = Array.isArray(evidence?.failures) ? evidence.failures as string[] : [];
  const command = typeof evidence?.command === 'string' ? evidence.command : '';
  const path = typeof evidence?.path === 'string' ? evidence.path : '';
  const toolTitle = typeof evidence?.toolTitle === 'string' ? evidence.toolTitle : '';
  const codePreview = typeof evidence?.code === 'string' ? evidence.code : '';
  const structuredEvidence = Boolean(
    command
    || path
    || codePreview
    || files.length
    || failures.length
    || typeof evidence?.exitCode === 'number'
    || typeof evidence?.passed === 'number'
  );
  const hasVisibleDetail = structuredEvidence || Boolean(rawOutput);
  const rawVisible = detailMode === 'code' || !structuredEvidence || showRaw;

  const details = hasVisibleDetail ? <div id={`ox-evidence-${item.id}`} className={`ox-evidence ${detailMode === 'code' ? 'ox-evidence-code' : ''}`}>
    {toolTitle && detailMode === 'code' && toolTitle !== title && <div className="ox-code-caption">{toolTitle}</div>}
    {command && <div className="ox-code-block">
      <span className="ox-code-label">Command</span>
      <pre className="ox-command" aria-label="Command"><span aria-hidden>$ </span>{command}</pre>
    </div>}
    {path && <div className="ox-code-path"><span className="ox-code-label">Path</span><code>{path}</code></div>}
    {codePreview && <div className="ox-code-preview"><span className="ox-code-label">Code</span><pre>{codePreview}</pre></div>}
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
      {structuredEvidence && detailMode !== 'code' && <Button type="button" tone="ghost" className="ox-detail-toggle" aria-expanded={showRaw} onClick={() => setShowRaw((value) => !value)}>{showRaw ? 'Hide duplicate raw output' : 'Show raw output'}</Button>}
      {rawVisible && <pre aria-label="Raw command output">{rawOutput}</pre>}
    </div>}
  </div> : null;

  return (
    <div className="ox-activity" data-state={uiState} data-current={isCurrent ? 'true' : undefined}>
      <span className="mark" aria-hidden>{uiState === 'done' ? <Icon name="check" /> : uiState === 'fail' ? <Icon name="x" /> : uiState === 'active' && isCurrent ? <Icon name="dot" /> : <Icon name="ring" />}</span>
      <div className="ox-activity-content">
        <div className="ox-activity-title">
          <span className="ox-activity-title-text">{title}</span>
          {isCurrent && <span className="ox-current-label">Current</span>}
          {timeLabel && <time className="ox-activity-time">{timeLabel}</time>}
        </div>
        {summary && <div className="small">{summary}</div>}
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

export function DiffSummary({ files }: { files: { path: string; action: string; additions?: number; deletions?: number }[] }) {
  if (!files.length) return <div className="small">No changes yet. Ask the agent to edit.</div>;
  const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
  const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);
  return (
    <div className="diff-summary">
      <div className="ox-row" style={{ justifyContent: 'space-between' }}>
        <b>{files.length} file{files.length === 1 ? '' : 's'} changed</b>
        {(additions > 0 || deletions > 0) && <span className="diff-stats" aria-label={`${additions} additions, ${deletions} deletions`}><i>+${additions}</i><i>−${deletions}</i></span>}
      </div>
      {files.map((f) => (
        <div key={f.path} className="ox-row" style={{ justifyContent: 'space-between' }}>
          <span><Icon name="file" /> {f.path}</span>
          <span className="ox-row" style={{ gap: 8 }}>
            {(Number(f.additions) > 0 || Number(f.deletions) > 0) && <span className="diff-stats"><i>+{Number(f.additions) || 0}</i><i>−{Number(f.deletions) || 0}</i></span>}
            <Badge tone={f.action === 'delete' ? 'fail' : f.action === 'create' ? 'ok' : 'neutral'}>{f.action}</Badge>
          </span>
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
