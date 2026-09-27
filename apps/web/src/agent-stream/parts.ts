// Typed message parts (assistant-ui/tool-ui inspired, Orlynx-native).
//
// A turn's work is a list of typed parts, not generic activity cards. The
// renderer registry dispatches on part kind so a terminal command never looks
// like a file change and a test result never looks like an approval request.
//
// Part kinds: text | terminal | file-change | file-read | test-result |
// build-result | git | preview | approval | error | status | generic

import type { AgentPartKind } from '@orlynx/shared';
import type { ActivityItem } from './view';

export type PartKind = AgentPartKind;

export interface ThreadPart {
  key: string;
  kind: PartKind;
  item: ActivityItem;
  /** Compact one-line label for the collapsed row. */
  title: string;
  /** Compact trailing summary (e.g. "42 passed", "Port 5173"). */
  summary?: string;
  state: ActivityItem['state'];
  runId?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function evidenceText(item: ActivityItem, ...keys: string[]): string {
  const evidence = asRecord(item.evidence);
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function commandOf(item: ActivityItem): string {
  return evidenceText(item, 'command');
}

// Legacy-only inference for pre-v1 history that has no semanticType.
function isPreviewCommand(command: string): boolean {
  return /vite|next dev|next start|npm run dev|pnpm dev|yarn dev|astro dev|remix dev|localhost|:\d{3,5}/i.test(command);
}

/** Classify a canonical activity row into a typed part. Pure + testable. */
export function toThreadPart(item: ActivityItem): ThreadPart {
  const evidence = asRecord(item.evidence);
  const command = commandOf(item);
  const sourceType = typeof evidence.sourceType === 'string' ? evidence.sourceType : '';
  const canonicalKind = typeof evidence.semanticType === 'string' ? evidence.semanticType as PartKind : undefined;

  // v1 server events already declare their semantic part type. Prefer that
  // authoritative meaning. Everything below is legacy-history fallback.
  if (canonicalKind && canonicalKind !== 'generic') {
    return {
      key: item.key,
      kind: canonicalKind,
      item,
      title: canonicalKind === 'approval' && item.state === 'waiting' ? 'Waiting for approval' : item.title,
      summary: item.summary,
      state: item.state,
      runId: item.runId,
    };
  }

  // Approvals are always first-class and interactive.
  if (item.category === 'approval' || /approval|permission/i.test(`${item.title} ${sourceType}`)) {
    return { key: item.key, kind: 'approval', item, title: item.state === 'waiting' ? 'Waiting for approval' : item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  // Errors/failures stay beside the thing that failed.
  if (item.category === 'error' || item.state === 'failed') {
    if (item.category === 'test' || /test/i.test(command)) {
      return { key: item.key, kind: 'test-result', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
    }
    if (item.category === 'build') {
      return { key: item.key, kind: 'build-result', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
    }
    if (item.category === 'cloud' || item.category === 'agent') {
      return { key: item.key, kind: item.category === 'cloud' ? 'status' : 'error', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
    }
    return { key: item.key, kind: 'error', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'test') {
    return { key: item.key, kind: 'test-result', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'build') {
    return { key: item.key, kind: 'build-result', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'git') {
    return { key: item.key, kind: 'git', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'preview' || (command && isPreviewCommand(command) && /dev|start|preview|serve/i.test(`${item.title} ${command}`))) {
    return { key: item.key, kind: 'preview', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'file') {
    const files = Array.isArray(evidence.files) ? evidence.files : [];
    if (files.length || /updat|edit|writ|change|creat|patch/i.test(`${item.title} ${command}`)) {
      return { key: item.key, kind: 'file-change', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
    }
    return { key: item.key, kind: 'file-read', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'search') {
    return { key: item.key, kind: 'file-read', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'command' || command) {
    return { key: item.key, kind: 'terminal', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  if (item.category === 'cloud') {
    return { key: item.key, kind: 'status', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
  }
  return { key: item.key, kind: 'generic', item, title: item.title, summary: item.summary, state: item.state, runId: item.runId };
}

export function toThreadParts(items: ActivityItem[]): ThreadPart[] {
  return items.map(toThreadPart);
}
