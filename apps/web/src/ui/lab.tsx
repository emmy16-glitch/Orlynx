// Lightweight component lab (no Storybook dep). Open with ?lab=1.
import React from 'react';
import { Badge, Button, Card, EmptyState, Spinner } from './primitives';
import { AgentApprovalCard, AgentErrorCard, AgentStatusPill, CloudStatus, DiffSummary } from './product';
import { AgentWorkStream, CloudTransition, LiveActivityPill } from './workstream';

const DEMO_EVENTS = [
  { type: 'activity.started', payload: { text: 'Searching repository for authentication handlers' } },
  { type: 'tool.started', payload: { tool: 'fs.read' } },
  { type: 'tool.completed', payload: { tool: 'fs.read' } },
  { type: 'activity.progress', payload: { text: 'Updating middleware' } },
  { type: 'tool.started', payload: { tool: 'exec', cmd: 'npm test' } },
  { type: 'receipt.created', payload: { code: 1, out: '154 passed, 2 failed' } },
  { type: 'run.completed', payload: { summary: 'Done — review Changes' } },
];

export function Lab() {
  return (
    <div style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
      <h2>Orlynx UI Lab</h2>
      <p className="small">States: idle/connecting/working/waiting/complete/failed · ?lab=1 · no Storybook weight</p>
      <Card><h4>AgentStatusPill</h4>{['queued', 'running', 'waiting_approval', 'paused', 'completed', 'failed'].map((s) => <span key={s} style={{ marginRight: 6 }}><AgentStatusPill state={s} /></span>)}</Card>
      <Card><h4>Badges</h4><Badge>neutral</Badge> <Badge tone="work">working</Badge> <Badge tone="ok">done</Badge> <Badge tone="wait">waiting</Badge> <Badge tone="fail">failed</Badge> <Spinner /></Card>
      <Card><h4>Buttons</h4><div className="ox-row"><Button>Primary</Button><Button tone="ghost">Ghost</Button><Button tone="danger">Danger</Button></div></Card>
      <Card><h4>AgentWorkStream (live)</h4><AgentWorkStream events={DEMO_EVENTS} /></Card>
      <Card><h4>Cloud</h4><CloudStatus state="preparing" /><div style={{ height: 8 }} /><CloudTransition state="preparing" /></Card>
      <AgentApprovalCard title="Push 4 changed files to experiment/vetting-ui" detail="Review changes first." onApprove={() => {}} onCancel={() => {}} />
      <AgentErrorCard title="Tests could not finish because the cloud workspace disconnected." hint="Reconnect to resume." onReconnect={() => {}} onRetry={() => {}} />
      <Card><h4>DiffSummary</h4><DiffSummary files={[{ path: 'auth.ts', action: 'modify' }, { path: 'auth.test.ts', action: 'create' }]} /></Card>
      <Card><h4>Live pill</h4><LiveActivityPill active label="Running tests" elapsed="02:14" onOpen={() => {}} /></Card>
      <EmptyState title="No preview" hint="Start a dev server to preview." />
    </div>
  );
}
