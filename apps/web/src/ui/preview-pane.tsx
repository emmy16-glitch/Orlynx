// Orlynx Preview: one canonical embedded-browser surface for the running app.
// Chat navigates here; the backend /ports list stays the single source of
// truth. History is Orlynx-tracked (we own every src change we make).
import React from 'react';
import { Icon } from './primitives';
import { externalPreviewUrl, isDevServerCommand, preferredPreviewPort, usablePreviews, type PreviewPort } from './preview';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'unreachable' | 'blocked';

/** Compact action attached to a dev-server startup activity result. */
export function ServerPreviewAction({ command, output, isPreview = false, activityState, runActive, ports, onViewPreview, onOpenExternal }: {
  command: string;
  output?: string;
  isPreview?: boolean;
  activityState: string;
  runActive: boolean;
  ports: PreviewPort[];
  onViewPreview: (port: number) => void;
  onOpenExternal: (url: string) => void;
}) {
  // Canonical v1 preview parts are authoritative. Command-name detection is
  // retained only for legacy activity history that predates semanticType.
  if (!isPreview && !isDevServerCommand(command)) return null;
  if (activityState === 'failed') return null; // failure stays on the row itself.
  const usable = usablePreviews(ports);
  // Exact hint match only: never point this command at another server's port.
  // Without a hint, a lone preview (or the ranked frontend) is the honest default.
  const hint = hintedPort(command, output);
  const match = hint ? usable.find((p) => p.port === hint) || null : preferredPreviewPort(ports);
  if (!match) {
    if (activityState !== 'running' && activityState !== 'waiting') return null;
    return <div className="server-preview-line" role="status"><span className="ox-spinner server-preview-spin" aria-hidden /><span>Starting application…</span></div>;
  }
  return (
    <div className="server-preview-line" role="group" aria-label={`Development server on port ${match.port}`}>
      <span className="server-preview-ok" aria-hidden><Icon name="check" size={14} /></span>
      <span className="server-preview-text">
        {runActive || activityState === 'running' ? 'Development server started' : 'Development server is running'} · Port {match.port}
      </span>
      <button type="button" className="server-preview-cta" onClick={() => onViewPreview(match.port)}>View preview</button>
      <button type="button" className="server-preview-ext" onClick={() => onOpenExternal(match.url!)} aria-label={`Open port ${match.port} in browser`} title="Open in browser">
        <span aria-hidden>↗</span>
      </button>
    </div>
  );
}

function hintedPort(command: string, output?: string): number | undefined {
  const text = `${command}\n${output || ''}`;
  const patterns = [/localhost:(\d{2,5})/i, /127\.0\.0\.1:(\d{2,5})/, /(?:port|PORT)[^\d]{0,12}(\d{2,5})/, /Local:\s*https?:\/\/[^\s:]+:(\d{2,5})/i];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

export function PreviewPane(props: {
  workspaceReady: boolean;
  online: boolean;
  ports: PreviewPort[];
  selected: PreviewPort | null;
  currentUrl: string | null;
  displayPath: string;
  status: PreviewStatus;
  slow: boolean;
  canBack: boolean;
  canForward: boolean;
  reloadKey: number;
  externalSuggest: string | null;
  onSelectPort: (port: number) => void;
  onSubmitPath: (input: string) => void;
  onDismissSuggest: () => void;
  onOpenExternalSuggest: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  onViewOutput: () => void;
  onLoad: () => void;
  onFrameError: () => void;
}) {
  const [draft, setDraft] = React.useState(props.displayPath);
  React.useEffect(() => { setDraft(props.displayPath); }, [props.displayPath]);
  const externalUrl = props.currentUrl && props.selected ? externalPreviewUrl(props.selected.url!, props.currentUrl) : props.selected?.url || null;

  if (!props.workspaceReady) {
    return <PreviewShell title="Preview" subtitle="Start the development workspace first."><p className="preview-empty-note">Preview becomes available once the workspace is ready.</p></PreviewShell>;
  }
  if (!props.ports.length) {
    return (
      <PreviewShell title="Preview" subtitle="Apps running in this workspace appear here.">
        <p className="preview-empty-note">No preview is running yet. Ask Orlynx to start the development server, or start one from the terminal.</p>
      </PreviewShell>
    );
  }
  return (
    <section className="screen-section preview-pane" aria-label="Application preview">
      <div className="preview-toolbar" role="toolbar" aria-label="Preview navigation">
        {props.ports.length > 1 && (
          <label className="preview-port-select">
            <span className="ox-sr-only">Select preview</span>
            <select value={props.selected?.port ?? ''} onChange={(e) => props.onSelectPort(Number(e.target.value))} aria-label="Select running preview">
              {props.ports.map((p) => <option key={p.port} value={p.port}>Port {p.port}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="preview-tool" onClick={props.onBack} disabled={!props.canBack} aria-label="Preview back"><span aria-hidden>‹</span></button>
        <button type="button" className="preview-tool" onClick={props.onForward} disabled={!props.canForward} aria-label="Preview forward"><span aria-hidden>›</span></button>
        <button type="button" className="preview-tool" onClick={props.onReload} aria-label="Reload preview"><Icon name="refresh" size={15} /></button>
        <form className="preview-address" onSubmit={(e) => { e.preventDefault(); props.onSubmitPath(draft); }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="/" aria-label="Preview path" spellCheck={false} autoComplete="off" />
        </form>
        <button type="button" className="preview-tool" onClick={props.onOpenExternal} disabled={!externalUrl} aria-label="Open preview in browser" title="Open in browser"><span aria-hidden>↗</span></button>
      </div>
      {props.externalSuggest && (
        <div className="preview-suggest" role="status">
          <span>That address is outside this preview.</span>
          <button type="button" onClick={props.onOpenExternalSuggest}>Open in browser</button>
          <button type="button" onClick={props.onDismissSuggest} aria-label="Dismiss">✕</button>
        </div>
      )}
      <div className="preview-stage">
        {!props.online && (
          <div className="preview-state" role="status"><b>You’re offline.</b><p>Preview will reconnect when your connection returns.</p></div>
        )}
        {props.online && props.status === 'loading' && (
          <div className="preview-state" role="status">
            <span className="ox-spinner" aria-hidden /><b>Loading preview…</b>
            {props.slow && <p>Still waiting for the development server…</p>}
            {props.slow && (
              <div className="preview-state-actions">
                <button type="button" onClick={props.onReload}>Retry</button>
                <button type="button" onClick={props.onOpenExternal}>Open in browser</button>
                <button type="button" onClick={props.onViewOutput}>View server output</button>
              </div>
            )}
          </div>
        )}
        {props.online && props.status === 'blocked' && (
          <div className="preview-state" role="alert">
            <b>This preview can’t be embedded here.</b>
            <p>The application itself is fine — embedding is restricted.</p>
            <div className="preview-state-actions">
              <button type="button" onClick={props.onOpenExternal}>Open in browser</button>
              <button type="button" onClick={props.onReload}>Retry</button>
            </div>
          </div>
        )}
        {props.online && props.status === 'unreachable' && (
          <div className="preview-state" role="alert">
            <b>Preview couldn’t load.</b>
            <p>The server is running, but the application isn’t responding yet.</p>
            <div className="preview-state-actions">
              <button type="button" onClick={props.onReload}>Retry</button>
              <button type="button" onClick={props.onOpenExternal}>Open in browser</button>
              <button type="button" onClick={props.onViewOutput}>View server output</button>
            </div>
          </div>
        )}
        {props.online && props.currentUrl && props.status !== 'blocked' && (
          <iframe
            key={props.reloadKey}
            className="preview-frame"
            title="Application preview"
            src={props.currentUrl}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onLoad={props.onLoad}
            onError={props.onFrameError}
            hidden={props.status !== 'ready'}
          />
        )}
      </div>
    </section>
  );
}

function PreviewShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="screen-section">
      <div className="screen-heading"><div><p className="eyebrow">PROJECT</p><h1>{title}</h1><p className="screen-subtitle">{subtitle}</p></div></div>
      {children}
    </section>
  );
}
