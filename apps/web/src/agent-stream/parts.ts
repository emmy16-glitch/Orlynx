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

  // A live Orlynx ↔ Model Investigation is already coalesced by the stream
  // store into one ordered semantic object. Render it directly as status
  // instead of letting it fall through to a generic activity row.
  if (sourceType === 'agent.reflection') {
    return { key: item.key, kind: 'status', item, title: item.title || 'Investigation', summary: item.summary, state: item.state, runId: item.runId };
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

function reflectionMeta(item: ActivityItem): { id: number; side: 'orlynx' | 'model'; text: string } | null {
  const evidence = asRecord(item.evidence);
  const sourceType = typeof evidence.sourceType === 'string' ? evidence.sourceType : '';
  if (sourceType !== 'agent.dialogue.orlynx' && sourceType !== 'agent.dialogue.model') return null;
  const id = Number(evidence.reflectionId || 0);
  const raw = typeof evidence.text === 'string' ? evidence.text : item.title;
  const text = String(raw || '')
    .replace(/^Orlynx\s*[→>-]\s*Model:\s*/i, '')
    .replace(/^Model\s*[→>-]\s*Orlynx:\s*/i, '')
    .trim();
  return { id: Number.isFinite(id) && id > 0 ? id : 1, side: sourceType.endsWith('.model') ? 'model' : 'orlynx', text };
}

export function toThreadParts(items: ActivityItem[]): ThreadPart[] {
  const result: ThreadPart[] = [];
  const reflectionIndex = new Map<string, number>();

  for (const item of items) {
    const reflection = reflectionMeta(item);
    if (!reflection) {
      result.push(toThreadPart(item));
      continue;
    }

    const key = `reflection:${item.runId || 'run'}:${reflection.id}`;
    const existingIndex = reflectionIndex.get(key);
    if (existingIndex === undefined) {
      const evidence: Record<string, unknown> = {
        sourceType: 'agent.reflection',
        reflectionId: reflection.id,
        ...(reflection.side === 'orlynx' ? { orlynxText: reflection.text } : { modelText: reflection.text }),
      };
      const groupedItem: ActivityItem = {
        ...item,
        key,
        id: key,
        category: 'agent',
        title: `Investigation ${reflection.id}`,
        summary: reflection.side === 'model' ? reflection.text : 'Orlynx and the connected model are diagnosing the remaining issue.',
        evidence,
        rawOutput: undefined,
        collapsible: true,
      };
      reflectionIndex.set(key, result.length);
      result.push({
        key,
        kind: 'status',
        item: groupedItem,
        title: groupedItem.title,
        summary: groupedItem.summary,
        state: groupedItem.state,
        runId: groupedItem.runId,
      });
      continue;
    }

    const prior = result[existingIndex];
    const priorEvidence = asRecord(prior.item.evidence);
    const evidence: Record<string, unknown> = {
      ...priorEvidence,
      ...(reflection.side === 'orlynx' ? { orlynxText: reflection.text } : { modelText: reflection.text }),
    };
    const groupedItem: ActivityItem = {
      ...prior.item,
      state: item.state === 'failed' ? 'failed' : item.state === 'running' || prior.item.state === 'running' ? 'running' : item.state,
      summary: reflection.side === 'model' && reflection.text ? reflection.text : prior.item.summary,
      evidence,
    };
    result[existingIndex] = {
      ...prior,
      item: groupedItem,
      summary: groupedItem.summary,
      state: groupedItem.state,
    };
  }

  return result;
}
