import type { AgentAdapterCapabilities, AgentFailure, AgentFailureCode, TaskRecord } from '@orlynx/shared';
import type { WorkspaceAgentAdapterRecord } from './storage.js';

export function classifyAgentFailure(detail: string): AgentFailure {
  const patterns: Array<[AgentFailureCode, RegExp]> = [
    ['user_cancelled', /user.cancel|cancelled by user/i],
    ['permission_denied', /permission.denied|not.allowed|denied by.*policy/i],
    ['workspace_conflict', /conflict|unreconciled|still.running|lease/i],
    ['provider_auth', /401|403|unauthoriz|authentication|api.key/i],
    ['provider_rate_limit', /429|rate.?limit/i],
    ['context_limit', /context.*(?:limit|length)|too.many.tokens/i],
    ['verification_failed', /verification.failed/i],
    ['stream_start_timeout', /first.*(?:response|progress).*tim|did not start streaming/i],
    ['stream_stall', /stall|stopped making.*progress/i],
    ['command_timeout', /command.*tim/i],
    ['runtime_timeout', /timeout|timed.out/i],
    ['workspace_unavailable', /workspace.*(?:unavailable|disconnected)|bridge.*(?:lost|closed)/i],
    ['provider_unavailable', /502|503|504|provider.*unavailable|ServiceUnavailable|APIConnectionError/i],
    ['adapter_protocol_error', /protocol|invalid.*json|unsupported.*runtime/i],
    ['runtime_unavailable', /unavailable|ECONN|fetch failed|socket|not installed|\bno (?:shell|terminal)\b|missing (?:shell|exec)(?:\/exec)? capability|(?:shell|terminal|command tool|exec tool) (?:is )?not available/i],
    ['runtime_crash', /crash|exited|signal/i],
    ['tool_failure', /tool.*fail|command not found|executable.*(?:missing|not found)|spawn \S+ ENOENT/i],
  ];
  // Adapters emit machine codes. Preserve those before applying heuristics to
  // unstructured upstream diagnostics (which may mention another error code).
  const explicit = patterns.find(([code]) => new RegExp(`^${code}(?=[:\\s]|$)`).test(detail.trim()))?.[0];
  const code = explicit || patterns.find(([, pattern]) => pattern.test(detail))?.[0] || 'unknown';
  const adapterFailover = ['provider_rate_limit','provider_unavailable','runtime_unavailable','runtime_crash','runtime_timeout','stream_start_timeout','stream_stall','context_limit','adapter_protocol_error'].includes(code);
  return { code, retryable: ['provider_rate_limit','provider_unavailable','runtime_unavailable','stream_start_timeout'].includes(code),
    adapterFailover, workspaceFailover: code === 'workspace_unavailable',
    humanActionRequired: ['provider_auth','permission_denied'].includes(code) };
}

export function taskCapabilities(task: Pick<TaskRecord, 'mode' | 'permission' | 'tempPermission'>): Partial<AgentAdapterCapabilities> {
  const write = (task.mode || 'build') === 'build' && (task.tempPermission || task.permission) === 'full';
  return { repositoryRead: true, streaming: true, ...(write ? { repositoryWrite: true, shell: true, tests: true } : { planning: true }) };
}
export function compatibleCapabilities(capabilities: AgentAdapterCapabilities, required: Partial<AgentAdapterCapabilities>): boolean {
  return Object.entries(required).every(([key,value]) => !value || capabilities[key as keyof AgentAdapterCapabilities] === true);
}
export function adapterEligible(health: WorkspaceAgentAdapterRecord | undefined, now = Date.now()): boolean {
  if (!health || health.state !== 'ready') return false;
  // Durable readiness is a recent application-level Bridge probe, not process existence.
  const updated = Date.parse(health.updatedAt);
  if (!Number.isFinite(updated) || updated > now + 5000 || now - updated > 90_000) return false;
  return !health.circuitOpenUntil || Date.parse(health.circuitOpenUntil) <= now;
}
export function currentExecution(task: TaskRecord, payload: Record<string, unknown>): boolean {
  return !task.harness?.adapterTransition && String(payload.adapterId || 'opencode') === (task.adapterId || 'opencode')
    && Number(payload.executionGeneration || 0) === Number(task.harness?.executionGeneration || 0);
}
