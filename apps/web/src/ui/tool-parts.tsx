// Typed tool/part renderer registry (tool-ui inspired, Orlynx-native).
//
// One logical tool = one UI object that mutates in place. Each part kind gets
// a purpose-built collapsed row + typed detail panel. Generic fallback exists
// but is never the default for terminal/file/test/git/approval/preview.
//
// Row contract (all kinds):
//   `✓ Title · summary                              ›`  (completed, compact)
//   `◌ Title · summary                              ›`  (running, single motion cue)
//   `✕ Title · summary                              ›`  (failed, recovery nearby)
// Chevron is always visible when evidence exists — never inside ⋯.

import React from 'react';
import { Icon } from './primitives';
import type { ThreadPart } from '../agent-stream/parts';

function useDisclosure(defaultOpen = false) {
  const [open, setOpen] = React.useState(defaultOpen);
  return { open, setOpen, toggle: () => setOpen((v) => !v) };
}

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

function Shell({ part, label }: { part: ThreadPart; label: string }) {
  const { open, toggle } = useDisclosure(false);
  const item = part.item;
  const active = item.state === 'running';
  const failed = item.state === 'failed';
  const waiting = item.state === 'waiting' || item.state === 'queued';
  const expandable = Boolean(item.evidence && Object.keys(item.evidence).length) || Boolean(item.rawOutput);
  const evidenceId = `ox-part-${item.id}`;
  return (
    <div className="ox-part" data-kind={part.kind} data-state={item.state} data-active={active ? 'true' : undefined}>
      <button
        type="button"
        className="ox-part-row"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? evidenceId : undefined}
        aria-label={`${item.title}${failed ? ', failed' : active ? ', in progress' : waiting ? ', waiting' : ''}`}
        onClick={() => expandable && toggle()}
        disabled={!expandable}
      >
        <span className="ox-part-mark" aria-hidden>
          {failed ? <Icon name="x" size={14} /> : item.state === 'success' ? <Icon name="check" size={14} /> : active ? <span className="ox-live-dot" /> : <Icon name="ring" size={14} />}
        </span>
        <span className="ox-part-title">{part.title}</span>
        {part.summary && <span className="ox-part-summary">{part.summary}</span>}
        {label && <span className="ox-part-kind">{label}</span>}
        {expandable && (
          <span className="ox-part-chevron" aria-hidden>
            <Icon name="chevron" size={14} />
          </span>
        )}
      </button>
      {expandable && open && (
        <div id={evidenceId} className="ox-part-detail">
          {childrenFor(part)}
        </div>
      )}
    </div>
  );
}

function childrenFor(part: ThreadPart): React.ReactNode {
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
      return <ApprovalDetail part={part} />;
    case 'error':
    case 'status':
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
  const [show, setShow] = React.useState(false);
  return (
    <div className="ox-raw">
      <button type="button" className="ox-detail-toggle" aria-expanded={show} onClick={() => setShow((v) => !v)}>
        {show ? 'Hide raw output' : 'Show raw output'}
      </button>
      {show && <pre aria-label="Raw command output">{output.slice(-50_000)}</pre>}
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
        <details className="ox-inline-diff" key={`diff:${file.path}`}>
          <summary>{file.path} <span>{file.action || 'modify'}</span></summary>
          <pre aria-label={`Diff for ${file.path}`}>{file.diff}</pre>
        </details>
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

function ApprovalDetail({ part }: { part: ThreadPart }) {
  return (
    <div>
      {part.item.summary && <div className="small">{part.item.summary}</div>}
      <div className="small">Approve from the run controls when prompted. Only actions supported by backend permission semantics are offered.</div>
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
export const partRenderers: Record<ThreadPart['kind'], (part: ThreadPart) => React.ReactNode> = {
  terminal: (part) => <Shell part={part} label={KIND_LABEL.terminal} />,
  'file-change': (part) => <Shell part={part} label={KIND_LABEL['file-change']} />,
  'file-read': (part) => <Shell part={part} label={KIND_LABEL['file-read']} />,
  'test-result': (part) => <Shell part={part} label={KIND_LABEL['test-result']} />,
  'build-result': (part) => <Shell part={part} label={KIND_LABEL['build-result']} />,
  git: (part) => <Shell part={part} label={KIND_LABEL.git} />,
  preview: (part) => <Shell part={part} label={KIND_LABEL.preview} />,
  approval: (part) => <Shell part={part} label={KIND_LABEL.approval} />,
  error: (part) => <Shell part={part} label={KIND_LABEL.error} />,
  status: (part) => <Shell part={part} label={KIND_LABEL.status} />,
  generic: (part) => <Shell part={part} label={KIND_LABEL.generic} />,
};

export function PartRow({ part }: { part: ThreadPart }) {
  const render = partRenderers[part.kind] || partRenderers.generic;
  return <>{render(part)}</>;
}
