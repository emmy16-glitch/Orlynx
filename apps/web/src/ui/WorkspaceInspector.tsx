import React, { useMemo, useState } from 'react';
import type { ActivityItem } from '../agent-stream/view';

type InspectorTab = 'changes' | 'files' | 'checks';
type ChangeFile = { path: string; additions?: number; deletions?: number; action?: string };
type Props = {
  activities: ActivityItem[];
  changes: Array<{ id?: string; files?: ChangeFile[] }>;
  liveFiles: ChangeFile[];
  runActive: boolean;
  onOpenChanges: () => void;
  onOpenFiles: () => void;
};

/** Context for the active conversation. No independent polling or fake progress. */
export function WorkspaceInspector({ activities, changes, liveFiles, runActive, onOpenChanges, onOpenFiles }: Props) {
  const [tab, setTab] = useState<InspectorTab>('changes');
  const { files, checks, recent, plan } = useMemo(() => {
    const seen = new Map<string, ChangeFile>();
    for (const change of changes) for (const file of change.files || []) {
      if (file.path) seen.set(file.path, file);
    }
    for (const file of liveFiles) if (file.path) seen.set(file.path, file);
    const all = [...seen.values()];
    const checkRows = activities.filter((activity) => activity.category === 'test' || activity.category === 'build');
    const latestPlan = [...activities].reverse().find((activity) => Array.isArray(activity.evidence?.items));
    const planItems = latestPlan && Array.isArray(latestPlan.evidence?.items) ? latestPlan.evidence.items : [];
    return {
      files: all,
      checks: checkRows.slice(-12).reverse(),
      recent: activities.filter((activity) => activity.category !== 'approval').slice(-7).reverse(),
      plan: planItems.filter((item): item is { content: string; status: string } =>
        Boolean(item && typeof item === 'object' && typeof item.content === 'string')),
    };
  }, [activities, changes, liveFiles]);

  const doneSteps = plan.filter((item) => item.status === 'completed').length;
  return <aside className="context-panel workspace-inspector" aria-label="Session details">
    <section className="inspector-section inspector-activity">
      <div className="inspector-heading"><h2>Agent activity</h2>{runActive && <span className="inspector-running">Working</span>}</div>
      {plan.length > 0 && <div className="inspector-plan">
        <div className="inspector-subheading"><strong>Task plan</strong><span>{doneSteps} of {plan.length}</span></div>
        <div className="inspector-plan-progress" role="progressbar" aria-valuemin={0} aria-valuemax={plan.length} aria-valuenow={doneSteps} aria-label="Completed task steps"><span style={{ width: `${(doneSteps / plan.length) * 100}%` }} /></div>
        <ol>{plan.map((step, index) => <li key={index} data-state={step.status}>
          <span className="inspector-step-indicator" aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '•' : ''}</span>
          <span>{step.content}</span>
        </li>)}</ol>
      </div>}
      <div className="inspector-subheading"><strong>{plan.length ? 'Recent activity' : 'Activity'}</strong></div>
      {recent.length ? <ol className="inspector-events">{recent.map((item) => <li key={item.key} data-state={item.state}>
        <span className="inspector-event-marker" aria-hidden="true" />
        <div><strong>{item.title}</strong>{item.summary && <p>{item.summary}</p>}</div>
      </li>)}</ol> : <p className="inspector-empty">{runActive ? 'Waiting for the first agent event…' : 'Work performed in this session will appear here.'}</p>}
    </section>
    <section className="inspector-section inspector-results">
      <div className="inspector-tabs" role="tablist" aria-label="Session results">
        {(['changes', 'files', 'checks'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>
          {value === 'changes' ? 'Changes' : value === 'files' ? 'Files' : 'Checks'}
        </button>)}
      </div>
      <div className="inspector-tab-body" role="tabpanel">
        {tab === 'changes' && (files.length ? <>
          <div className="inspector-subheading"><strong>Changed files</strong><span>{files.length}</span></div>
          <ul className="inspector-files">{files.slice(0, 12).map((file) => <li key={file.path}><span title={file.path}>{file.path}</span><small>{typeof file.additions === 'number' && <em>+{file.additions}</em>}{typeof file.deletions === 'number' && <i>−{file.deletions}</i>}</small></li>)}</ul>
          <button type="button" className="inspector-text-action" onClick={onOpenChanges}>Review changes →</button>
        </> : <p className="inspector-empty">No changed files yet.</p>)}
        {tab === 'files' && (files.length ? <>
          <div className="inspector-subheading"><strong>Files touched</strong><span>{files.length}</span></div>
          <ul className="inspector-files">{files.slice(0, 12).map((file) => <li key={file.path}><span title={file.path}>{file.path}</span></li>)}</ul>
          <button type="button" className="inspector-text-action" onClick={onOpenFiles}>Browse repository →</button>
        </> : <><p className="inspector-empty">No files changed during this session.</p><button type="button" className="inspector-text-action" onClick={onOpenFiles}>Browse repository →</button></>)}
        {tab === 'checks' && (checks.length ? <ul className="inspector-checks">{checks.map((check) => <li key={check.key} data-state={check.state}><span aria-hidden="true">{check.state === 'success' ? '✓' : check.state === 'failed' ? '!' : '·'}</span><div><strong>{check.title}</strong>{check.summary && <p>{check.summary}</p>}</div></li>)}</ul> : <p className="inspector-empty">No test or build results recorded yet.</p>)}
      </div>
    </section>
  </aside>;
}
