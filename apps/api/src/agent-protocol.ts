import { createHash } from 'node:crypto';
// Orlynx canonical agent protocol — server-authoritative boundary.
//
// Direction of travel (never reversed):
//
//   RawProviderEvent -> AgentAdapter -> CanonicalAgentEvent
//     -> Session/EventStore -> SSE -> ThreadProjection -> Typed UI
//
// This module is the server half. The browser adapter
// (apps/web/src/agent-stream/adapter.ts) is now only a compatibility layer
// for pre-v1 durable history. New server emissions use the canonical
// vocabulary directly so React never reconstructs provider semantics.
//
// Design influences (patterns adopted, implementation original):
// - AG-UI: small canonical run/message/tool/state lifecycle, stable IDs,
//   custom/extension events instead of silent drops.
// - ACP: explicit agent boundary (sessions, tool calls/results, permissions,
//   plans, terminal state, cancel/resume, capability negotiation).
// - Cline: agent execution separated from session/core state and transport.
// - OpenHands: runtime actions/observations exist independently of presentation.
// - assistant-ui/tool-ui: conversation-first typed message parts.
// - LangGraph: resumable streams via snapshot + idempotent event replay.
// - Bolt/E2B Surf: chat -> work -> preview is one workflow, one source of truth.

import { CANONICAL_PROTOCOL_VERSION, type EventType } from '@orlynx/shared';

export const PROTOCOL_VERSION = CANONICAL_PROTOCOL_VERSION;

export type CanonicalType = EventType;

// Bridge-sourced provider event names that carry first-class meaning. They
// must NEVER collapse into a generic activity tick: each maps to a canonical
// durable type (or to extension.event with its sourceType preserved).
const BRIDGE_CANONICAL_MAP: Record<string, CanonicalType> = {
  'message.delta': 'message.delta',
  'tool.requested': 'tool.requested',
  'tool.started': 'tool.started',
  'tool.output': 'tool.output',
  'tool.progress': 'tool.progress',
  'tool.completed': 'tool.completed',
  'tool.failed': 'tool.failed',
  // Terminal lifecycle stays terminal — never generic progress.
  'terminal.started': 'terminal.started',
  'terminal.output': 'terminal.output',
  'terminal.exited': 'terminal.exited',
  'pty.output': 'terminal.output',
  // File/test/build observations stay typed for the part renderer registry.
  'file.changed': 'file.changed',
  'files.changed': 'files.changed',
  'changes.updated': 'changes.updated',
  'test.result': 'test.result',
  'build.result': 'build.result',
  // Preview readiness is runtime truth, not chat decoration.
  'preview.ready': 'preview.ready',
  'preview.state': 'preview.state',
  // Human-in-the-loop stays first-class.
  'permission.request': 'permission.request',
  'permission.resolved': 'permission.resolved',
  'approval.required': 'approval.required',
  'approval.resolved': 'approval.resolved',
  // Delegation stays visible as one lifecycle, not N rows.
  'subagent.started': 'subagent.started',
  'subagent.finished': 'subagent.finished',
  'receipt.created': 'receipt.created',
  'run.state': 'run.state',
  'workspace.state': 'workspace.state',
};

const HEARTBEAT_TYPES = new Set(['heartbeat', 'ping', 'pong', 'adapter.heartbeat', 'bridge.heartbeat']);

export interface NormalizedBridgeEvent {
  /** Durable canonical type to persist. */
  type: CanonicalType;
  payload: Record<string, unknown>;
  /** True when the provider type had no canonical mapping; semantics are kept in payload.sourceType. */
  extension: boolean;
  /** True for transport noise that must not be persisted as history. */
  heartbeat: boolean;
}

/**
 * Server-side provider adapter for bridge EVENT frames.
 *
 * Unknown provider events are never silently flattened: they become either a
 * known canonical event, an extension.event carrying sourceType + payload, or
 * (heartbeats only) dropped telemetry.
 */
export function normalizeBridgeEvent(
  rawType: string,
  rawPayload: Record<string, unknown> = {},
): NormalizedBridgeEvent {
  const type = String(rawType || '').trim();
  if (!type || HEARTBEAT_TYPES.has(type)) {
    return { type: 'activity.progress', payload: rawPayload, extension: false, heartbeat: true };
  }
  const canonical = BRIDGE_CANONICAL_MAP[type];
  if (canonical) {
    return { type: canonical, payload: { ...rawPayload, protocolVersion: PROTOCOL_VERSION }, extension: false, heartbeat: false };
  }
  if (type === 'activity.progress' || type === 'activity.started' || type === 'activity.completed') {
    return { type: type as CanonicalType, payload: { ...rawPayload, protocolVersion: PROTOCOL_VERSION }, extension: false, heartbeat: false };
  }
  // Extension/custom event: meaning preserved, UI decides (debug vs render).
  return {
    type: 'extension.event',
    payload: { sourceType: type, ...rawPayload, protocolVersion: PROTOCOL_VERSION },
    extension: true,
    heartbeat: false,
  };
}

/** Scope a provider tool-call id to its run so id "1" in run A never merges run B. */
export function scopeToolCallId(runId: string | undefined, rawId: string): string {
  const run = runId || 'session';
  return `${run}:${rawId}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Stable idempotency key for a bridge EVENT frame.
 *
 * Provider/bridge retries may deliver the same frame more than once. The
 * durable event ledger must preserve one semantic event rather than assigning
 * a fresh UUID on every delivery. A source event id wins; otherwise hash the
 * canonical event content.
 */
export function bridgeEventKey(
  sessionId: string,
  runId: string | undefined,
  type: string,
  payload: Record<string, unknown>,
  sourceEventId?: string,
): string {
  const source = sourceEventId
    ? `source:${sourceEventId}`
    : createHash('sha256').update(stableJson({ runId: runId || null, type, payload })).digest('hex').slice(0, 32);
  return `bridge:${sessionId}:${source}`;
}
