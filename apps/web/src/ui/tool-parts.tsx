// Typed tool/part renderer registry (tool-ui inspired, Orlynx-native).
//
// One logical tool = one UI object that mutates in place. Each part kind gets
// a purpose-built row with meaningful evidence visible directly underneath.
// Generic fallback exists but is never the default for terminal/file/test/git/
// approval/preview. Raw output stays bounded so observability does not turn the
// conversation into an unbounded terminal dump.

import React from 'react';
import { Icon } from './primitives';
import type { ThreadPart } from '../agent-stream/parts';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function filesOf(part: ThreadPart): { path: string; action?: string; diff?: string }[] {
  const evidence = asRecord(part.item.evidence);
  const files = Array.isArray(evidence.files) ? evidence.files : [];
  return files.flatMap((file) => {
    const record = asRecord(file);
    const path = str(record.path);
    if (!path) return [];
    return [{ path, action: str(record.action) || undefined, diff: str(record.diff) || undefined }];
  });
}

type ApprovalDecision = 'allow_once' | 'deny';
type ResolveApproval = (approvalId: string, decision: ApprovalDecision) => Promise<void>;

function hasRenderableDetail(part: ThreadPart): boolean {
  const evidence = asRecord(part.item.evidence);
  const raw = Boolean(part.item.rawOutput);
  const command = Boolean(str(evidence.command));
  const path = Boolean(str(evidence.path));
  const code = Boolean(str(evidence.code));
  const files = filesOf(part).length > 0;
  const counts = typeof evidence.passed === 'number' || typeof evidence.failed === 'number' || typeof evidence.skipped === 'number';
  const failures = Array.isArray(evidence.failures) && evidence.failures.length > 0;
  const branch = Boolean(str(evidence.branch));
  const port = Boolean(str(evidence.port));
  const action = Boolean(str(evidence.action));
  const approval = Boolean(str(evidence.approvalId));

  switch (part.kind) {
    case 'terminal': return command || path || raw;
    case 'test-result': return counts || failures || raw;
    case 'build-result': return command || typeof evidence.exitCode === 'number' || raw;
    case 'file-change': return files || raw;
    case 'file-read': return path || code || raw;
    case 'git': return command || branch || raw;
    case 'preview': return command || port || raw;
    case 'approval': return action || approval || raw;
    case 'status':
      return str(evidence.sourceType) === 'agent.reflection'
        ? Boolean(str(evidence.orlynxText) || str(evidence.modelText))
        : command || path || raw;
    case 'error':
    case 'generic':
    default: return command || path || raw;
  }
}

function Shell({ part, label, onResolveApproval }: { part: ThreadPart; label: string; onResolveApproval?: ResolveApproval }) {
  const item = part.item;
  const active = item.state === 'running';
  const failed = item.state === 'failed';
  const waiting = item.state === 'waiting' || item.state === 'queued';
  const hasDetail = hasRenderableDetail(part);
  return (
    <div className="ox-part" data-kind={part.kind} data-state={item.state} data-active={active ? 'true' : undefined}>
      <div
        className="ox-part-row"
        aria-label={`${item.title}${failed ? ', failed' : active ? ', in progress' : waiting ? ', waiting' : ''}`}
      >
        <span className="ox-part-mark" aria-hidden>
          {failed ? <Icon name="x" size={14} /> : item.state === 'success' ? <Icon name="check" size={14} /> : active ? <span className="ox-live-dot" /> : <Icon name="ring" size={14} />}
        </span>
        <span className="ox-part-title">{part.title}</span>
        {part.summary && <span className="ox-part-summary">{part.summary}</span>}
        {label && <span className="ox-part-kind">{label}</span>}
      </div>
      {hasDetail && (
        <div className="ox-part-detail is-visible">
          {childrenFor(part, onResolveApproval)}
        </div>
      )}
    </div>
  );
}

function childrenFor(part: ThreadPart, onResolveApproval?: ResolveApproval): React.ReactNode {
  switch (part.kind) {
    case 'terminal':
      return <TerminalDetail part={part} />;
    case 'test-result':
      return <TestDetail part={part} />;
    case 'build-result':
      return <BuildDetail part={part} />;
    case 'file-change':
      return <FileChangeDetail part={part} />;
    case 'file-read':
      return <FileReadDetail part={part} />;
    case 'git':
      return <GitDetail part={part} />;
    case 'preview':
      return <PreviewDetail part={part} />;
    case 'approval':
      return <ApprovalDetail part={part} onResolveApproval={onResolveApproval} />;
    case 'status':
      return <StatusDetail part={part} />;
    case 'error':
    case 'generic':
    default:
      return <GenericDetail part={part} />;
  }
}

function CommandBlock({ command }: { command: string }) {
  if (!command) return null;
  return (
    <div className="ox-code-block">
      <span className="ox-code-label">Command</span>
      <pre className="ox-command" aria-label="Command"><span aria-hidden>$ </span>{command}</pre>
    </div>
  );
}

function RawOutput({ output }: { output?: string }) {
  if (!output) return null;
  return (
    <div className="ox-raw ox-raw-visible">
      <pre aria-label="Raw command output">{output.slice(-50_000)}</pre>
    </div>
  );
}

function TerminalDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  return (
    <div>
      <CommandBlock command={str(evidence.command)} />
      {str(evidence.path) && <div className="ox-code-path"><span className="ox-code-label">Path</span><code>{str(evidence.path)}</code></div>}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

function TestDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  const failures = Array.isArray(evidence.failures) ? evidence.failures.map(String) : [];
  return (
    <div>
      {(typeof evidence.passed === 'number' || typeof evidence.failed === 'number') && (
        <div className="small">
          {typeof evidence.passed === 'number' ? `${evidence.passed} passed` : ''}
          {typeof evidence.failed === 'number' ? ` · ${evidence.failed} failed` : ''}
          {typeof evidence.skipped === 'number' ? ` · ${evidence.skipped} skipped` : ''}
        </div>
      )}
      {failures.length > 0 && (
        <ul className="ox-failure-list">{failures.slice(0, 8).map((failure) => <li key={failure}>{failure}</li>)}</ul>
      )}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

function BuildDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  return (
    <div>
      <CommandBlock command={str(evidence.command)} />
      {typeof evidence.exitCode === 'number' && <div className="small">Exit code {evidence.exitCode}</div>}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

function FileChangeDetail({ part }: { part: ThreadPart }) {
  const files = filesOf(part);
  if (!files.length) return <GenericDetail part={part} />;
  return (
    <div className="ox-code-files">
      <ul className="ox-file-list">
        {files.slice(0, 20).map((file) => (
          <li key={file.path}>
            <span aria-hidden>{file.action === 'delete' ? '−' : file.action === 'create' ? '+' : '~'}</span>{' '}
            <code>{file.path}</code>
          </li>
        ))}
      </ul>
      {files.filter((file) => file.diff).slice(0, 3).map((file) => (
        <div className="ox-inline-diff ox-inline-diff-visible" key={`diff:${file.path}`}>
          <div className="ox-inline-diff-title">{file.path} <span>{file.action || 'modify'}</span></div>
          <pre aria-label={`Diff for ${file.path}`}>{file.diff}</pre>
        </div>
      ))}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

function FileReadDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  const code = str(evidence.code);
  return (
    <div>
      {str(evidence.path) && <div className="ox-code-path"><span className="ox-code-label">Path</span><code>{str(evidence.path)}</code></div>}
      {code && <div className="ox-code-preview"><span className="ox-code-label">Snippet</span><pre>{code.slice(0, 4_000)}</pre></div>}
      {!str(evidence.path) && !code && <GenericDetail part={part} />}
    </div>
  );
}

function GitDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  return (
    <div>
      <CommandBlock command={str(evidence.command)} />
      {str(evidence.branch) && <div className="small">Branch {str(evidence.branch)}</div>}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

function PreviewDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  const port = str(evidence.port) || (/[:](\d{3,5})/.exec(`${str(evidence.command)} ${part.item.rawOutput || ''}`)?.[1] ?? '');
  return (
    <div>
      <CommandBlock command={str(evidence.command)} />
      {port && <div className="small">Port {port}</div>}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

function ApprovalDetail({ part, onResolveApproval }: { part: ThreadPart; onResolveApproval?: ResolveApproval }) {
  const evidence = asRecord(part.item.evidence);
  const approvalId = str(evidence.approvalId);
  const action = str(evidence.action);
  const [busy, setBusy] = React.useState<ApprovalDecision | null>(null);
  const [error, setError] = React.useState('');

  const resolve = async (decision: ApprovalDecision) => {
    if (!approvalId || !onResolveApproval || busy) return;
    setBusy(decision);
    setError('');
    try {
      await onResolveApproval(approvalId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval could not be resolved.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ox-approval-detail">
      {part.item.summary && <div className="small">{part.item.summary}</div>}
      {action && <div className="ox-code-path"><span className="ox-code-label">Action</span><code>{action}</code></div>}
      {part.item.state === 'waiting' && approvalId && onResolveApproval && (
        <div className="ox-approval-actions" role="group" aria-label="Approval actions">
          <button type="button" className="pri" disabled={Boolean(busy)} onClick={() => void resolve('allow_once')}>
            {busy === 'allow_once' ? 'Approving…' : 'Allow once'}
          </button>
          <button type="button" className="gho" disabled={Boolean(busy)} onClick={() => void resolve('deny')}>
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
        </div>
      )}
      {part.item.state === 'waiting' && !approvalId && <div className="small">This permission request cannot be acted on from chat because it came from legacy history.</div>}
      {error && <div className="small ox-inline-error" role="alert">{error}</div>}
    </div>
  );
}

function StatusDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  if (str(evidence.sourceType) !== 'agent.reflection') return <GenericDetail part={part} />;
  const reflectionId = Number(evidence.reflectionId || 1);
  const orlynxText = str(evidence.orlynxText);
  const modelText = str(evidence.modelText);
  return (
    <div className="ox-investigation" aria-label={`Investigation ${reflectionId} dialogue`}>
      {orlynxText && <div className="ox-investigation-line" data-speaker="orlynx">
        <span className="ox-investigation-speaker">Orlynx</span>
        <p>{orlynxText}</p>
      </div>}
      {modelText ? <div className="ox-investigation-line" data-speaker="model">
        <span className="ox-investigation-speaker">Model</span>
        <p>{modelText}</p>
      </div> : <div className="ox-investigation-line is-pending" data-speaker="model">
        <span className="ox-investigation-speaker">Model</span>
        <p>Reviewing the evidence and choosing the next check…</p>
      </div>}
    </div>
  );
}

function GenericDetail({ part }: { part: ThreadPart }) {
  const evidence = asRecord(part.item.evidence);
  const command = str(evidence.command);
  const path = str(evidence.path);
  return (
    <div>
      {command && <CommandBlock command={command} />}
      {path && <div className="ox-code-path"><span className="ox-code-label">Path</span><code>{path}</code></div>}
      {part.item.summary && !command && !path && <div className="small">{part.item.summary}</div>}
      <RawOutput output={part.item.rawOutput} />
    </div>
  );
}

const KIND_LABEL: Record<ThreadPart['kind'], string> = {
  terminal: '',
  'file-change': '',
  'file-read': '',
  'test-result': '',
  'build-result': '',
  git: '',
  preview: '',
  approval: '',
  error: '',
  status: '',
  generic: '',
};

/** Renderer registry: typed part -> purpose-built row. Generic is fallback only. */
export const partRenderers: Record<ThreadPart['kind'], (part: ThreadPart, onResolveApproval?: ResolveApproval) => React.ReactNode> = {
  terminal: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.terminal} onResolveApproval={onResolveApproval} />,
  'file-change': (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL['file-change']} onResolveApproval={onResolveApproval} />,
  'file-read': (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL['file-read']} onResolveApproval={onResolveApproval} />,
  'test-result': (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL['test-result']} onResolveApproval={onResolveApproval} />,
  'build-result': (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL['build-result']} onResolveApproval={onResolveApproval} />,
  git: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.git} onResolveApproval={onResolveApproval} />,
  preview: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.preview} onResolveApproval={onResolveApproval} />,
  approval: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.approval} onResolveApproval={onResolveApproval} />,
  error: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.error} onResolveApproval={onResolveApproval} />,
  status: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.status} onResolveApproval={onResolveApproval} />,
  generic: (part, onResolveApproval) => <Shell part={part} label={KIND_LABEL.generic} onResolveApproval={onResolveApproval} />,
};

export function PartRow({ part, onResolveApproval }: { part: ThreadPart; onResolveApproval?: ResolveApproval }) {
  const render = partRenderers[part.kind] || partRenderers.generic;
  return <>{render(part, onResolveApproval)}</>;
}
