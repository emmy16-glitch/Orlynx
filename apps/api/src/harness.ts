import type {
  AgentMode,
  HarnessCheckpoint,
  HarnessVerification,
  OrlynxEvent,
  PermissionProfile,
  SteeringAction,
  TaskRecord,
  ToolFamily,
} from '@orlynx/shared';

export type BudgetStage = 'normal' | 'warn' | 'finalize' | 'force-final';

export interface HarnessBudgetStatus {
  step: number;
  budget: number;
  remaining: number;
  stage: BudgetStage;
  instruction?: string;
}

export interface HarnessInitInput {
  prompt: string;
  mode: AgentMode;
  permission: PermissionProfile;
  plane: 'direct' | 'workspace';
  now?: string;
  stepBudget?: number;
}

const DEFAULT_BUDGETS: Record<'direct' | 'workspace', number> = {
  direct: 10,
  workspace: 30,
};

export function verificationRequirementsFor(prompt: string): string[] {
  const value = String(prompt || '').toLowerCase();
  const required = new Set<string>();

  if (/\b(fix|implement|edit|change|update|refactor|rewrite|add|remove|rename)\b/.test(value)) required.add('changes');
  if (/\b(test|tests|testing|pytest|npm test|unit test|e2e|playwright)\b/.test(value)) required.add('tests');
  if (/\b(build|compile|typecheck|lint)\b/.test(value)) required.add('build');
  if (/\bcommit\b/.test(value)) required.add('commit');
  if (/\b(push|publish)\b/.test(value) || /\bto\s+main\b/.test(value)) required.add('publish');
  if (/\b(deploy|deployment|redeploy)\b/.test(value)) required.add('deployment');
  if (/\b(localhost|local\s*host|preview|start\s+(?:the\s+)?(?:app|server|dev))\b/.test(value)) required.add('preview');

  return [...required];
}

export function toolFamiliesFor(input: {
  mode: AgentMode;
  permission: PermissionProfile;
  phase: HarnessCheckpoint['phase'];
  required?: string[];
  budgetStage?: BudgetStage;
}): ToolFamily[] {
  if (input.budgetStage === 'force-final' || input.phase === 'finalizing' || input.phase === 'completed' || input.phase === 'failed' || input.phase === 'cancelled') {
    return [];
  }

  const readOnly: ToolFamily[] = ['repository', 'filesystem'];
  if (input.mode !== 'build' || input.permission === 'read-only') return readOnly;
  if (input.phase === 'received' || input.phase === 'routing') return ['repository'];
  if (input.phase === 'context_loading') return readOnly;

  const families = new Set<ToolFamily>(['repository', 'filesystem', 'terminal']);
  const required = new Set(input.required || []);
  if (required.has('tests') || required.has('build') || input.phase === 'verifying') families.add('tests');
  if (required.has('commit') || required.has('publish') || input.phase === 'verifying') families.add('git');
  if (required.has('preview') || input.phase === 'verifying') families.add('preview');
  if (required.has('deployment')) families.add('deployment');

  return [...families];
}

export function createHarnessCheckpoint(input: HarnessInitInput): HarnessCheckpoint {
  const now = input.now || new Date().toISOString();
  const required = verificationRequirementsFor(input.prompt);
  const verification: HarnessVerification = {
    required,
    satisfied: [],
    missing: [...required],
    status: required.length ? 'pending' : 'passed',
  };
  const stepBudget = Math.max(4, input.stepBudget || DEFAULT_BUDGETS[input.plane]);

  const checkpoint: HarnessCheckpoint = {
    phase: 'received',
    step: 0,
    stepBudget,
    steeringRevision: 0,
    inbox: [],
    toolFamilies: [],
    verification,
    salvageAttempts: 0,
    lastCheckpointAt: now,
    updatedAt: now,
  };
  checkpoint.toolFamilies = toolFamiliesFor({
    mode: input.mode,
    permission: input.permission,
    phase: checkpoint.phase,
    required,
  });
  return checkpoint;
}

export function advanceHarnessPhase(
  checkpoint: HarnessCheckpoint,
  phase: HarnessCheckpoint['phase'],
  input: { mode: AgentMode; permission: PermissionProfile; now?: string },
): HarnessCheckpoint {
  const now = input.now || new Date().toISOString();
  const next: HarnessCheckpoint = {
    ...checkpoint,
    phase,
    lastCheckpointAt: now,
    updatedAt: now,
  };
  next.toolFamilies = toolFamiliesFor({
    mode: input.mode,
    permission: input.permission,
    phase,
    required: checkpoint.verification.required,
    budgetStage: harnessBudgetStatus(next).stage,
  });
  return next;
}

export function harnessBudgetStatus(checkpoint: HarnessCheckpoint): HarnessBudgetStatus {
  const remaining = Math.max(0, checkpoint.stepBudget - checkpoint.step);
  let stage: BudgetStage = 'normal';
  let instruction: string | undefined;

  if (remaining <= 0) {
    stage = 'force-final';
    instruction = 'Tool budget exhausted. Do not call another tool. Produce the best final result from existing evidence now.';
  } else if (remaining === 1) {
    stage = 'force-final';
    instruction = 'This is the final reasoning boundary. Do not launch new work; synthesize and finish from current evidence.';
  } else if (remaining <= 3) {
    stage = 'finalize';
    instruction = `${remaining} steps remain. Finish verification and wrap up; do not begin unrelated work.`;
  } else if (remaining <= 7) {
    stage = 'warn';
    instruction = `${remaining} steps remain. Prioritize the acceptance criteria and avoid unnecessary investigation.`;
  }

  return { step: checkpoint.step, budget: checkpoint.stepBudget, remaining, stage, instruction };
}

export function consumeHarnessStep(
  checkpoint: HarnessCheckpoint,
  input: { mode: AgentMode; permission: PermissionProfile; now?: string },
): HarnessCheckpoint {
  const now = input.now || new Date().toISOString();
  const next: HarnessCheckpoint = {
    ...checkpoint,
    step: Math.min(checkpoint.stepBudget, checkpoint.step + 1),
    lastProgressAt: now,
    lastCheckpointAt: now,
    updatedAt: now,
  };
  const budget = harnessBudgetStatus(next);
  next.toolFamilies = toolFamiliesFor({
    mode: input.mode,
    permission: input.permission,
    phase: next.phase,
    required: next.verification.required,
    budgetStage: budget.stage,
  });
  return next;
}

export function steeringActionFor(text: string): SteeringAction {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return 'ignore';

  if (/^(?:stop|cancel|abort|halt|never\s*mind|nevermind)(?:\s+(?:it|this|that|the\s+task|current\s+task))?[.!?\s]*$/.test(value)) return 'stop';
  if (/\b(?:forget|ignore)\s+(?:that|the\s+(?:previous|original)|what\s+i\s+said)|\binstead\b|\bchange\s+(?:the\s+)?request\b|\bonly\s+(?:do|check|fix|work)\b/.test(value)) return 'replace';
  if (/^(?:also|and\s+also|additionally|plus)\b|\bmake\s+sure\b|\bdon't\s+forget\b|\bwhile\s+you(?:'re|\s+are)\b/.test(value)) return 'append';

  return 'ignore';
}

export function applySteering(
  task: TaskRecord,
  text: string,
  action = steeringActionFor(text),
  now = new Date().toISOString(),
): TaskRecord {
  const harness = task.harness || createHarnessCheckpoint({
    prompt: task.prompt,
    mode: task.mode || 'build',
    permission: task.permission || 'full',
    plane: task.plane || 'workspace',
    now,
  });

  if (action === 'ignore') return { ...task, harness };
  if (action === 'stop') {
    return {
      ...task,
      state: 'cancelled',
      harness: {
        ...harness,
        phase: 'cancelled',
        steeringRevision: harness.steeringRevision + 1,
        updatedAt: now,
        lastCheckpointAt: now,
      },
      updatedAt: now,
    };
  }

  const message = {
    id: `steer_${harness.steeringRevision + 1}`,
    action,
    text: String(text || '').trim(),
    createdAt: now,
  } as const;

  const prompt = action === 'replace' ? message.text : task.prompt;
  const verification = action === 'replace'
    ? {
        required: verificationRequirementsFor(prompt),
        satisfied: [],
        missing: verificationRequirementsFor(prompt),
        status: verificationRequirementsFor(prompt).length ? 'pending' as const : 'passed' as const,
      }
    : harness.verification;

  return {
    ...task,
    prompt,
    harness: {
      ...harness,
      steeringRevision: harness.steeringRevision + 1,
      inbox: [...harness.inbox, message],
      verification,
      updatedAt: now,
      lastCheckpointAt: now,
    },
    updatedAt: now,
  };
}

function evidenceKeys(events: OrlynxEvent[]): Set<string> {
  const found = new Set<string>();
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === 'file.changed' || event.type === 'files.changed' || event.type === 'changes.updated') found.add('changes');

    if (event.type === 'test.result') {
      const failed = Number(payload.failed || 0);
      if (!Number.isFinite(failed) || failed <= 0) found.add('tests');
    }

    if (event.type === 'build.result') {
      const state = String(payload.state || payload.status || '').toLowerCase();
      const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : undefined;
      if (state === 'success' || state === 'passed' || exitCode === 0) found.add('build');
    }

    if (event.type === 'preview.ready') found.add('preview');

    if (event.type === 'receipt.created') {
      if (payload.commitSha || payload.commit) found.add('commit');
      if (payload.pushedAt || payload.pushedBranch || payload.pullRequestUrl || payload.publish === true) found.add('publish');
      if (payload.deploymentUrl || payload.deployed === true) found.add('deployment');
    }

    if (event.type === 'tool.completed' || event.type === 'terminal.exited') {
      const command = String(payload.command || '').toLowerCase();
      const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : 0;
      if (exitCode === 0 && /\bgit\s+commit\b/.test(command)) found.add('commit');
      if (exitCode === 0 && /\bgit\s+push\b/.test(command)) found.add('publish');
      if (exitCode === 0 && /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint)\b/.test(command)) found.add('build');
      if (exitCode === 0 && /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bpytest\b|\bplaywright\b/.test(command)) found.add('tests');
    }
  }
  return found;
}

export function verifyHarness(checkpoint: HarnessCheckpoint, events: OrlynxEvent[], now = new Date().toISOString()): HarnessCheckpoint {
  const evidence = evidenceKeys(events);
  const required = checkpoint.verification.required;
  const satisfied = required.filter((item) => evidence.has(item));
  const missing = required.filter((item) => !evidence.has(item));
  return {
    ...checkpoint,
    verification: {
      required: [...required],
      satisfied,
      missing,
      status: missing.length ? 'needs_more_work' : 'passed',
      checkedAt: now,
    },
    phase: missing.length ? 'executing' : 'verifying',
    updatedAt: now,
    lastCheckpointAt: now,
  };
}

export function shouldSalvage(checkpoint: HarnessCheckpoint, finalText: string): boolean {
  const text = String(finalText || '').trim();
  if (checkpoint.salvageAttempts >= 1) return false;
  if (checkpoint.verification.status === 'needs_more_work') return true;
  if (!text) return true;
  if (text.length < 180 && /\b(?:working on|starting|checking|looking into|next i(?:'ll| will)|still working|in progress)\b/i.test(text)) return true;
  return false;
}

export function harnessSystemInstruction(checkpoint: HarnessCheckpoint): string {
  const budget = harnessBudgetStatus(checkpoint);
  const criteria = checkpoint.verification.required.length
    ? `Acceptance criteria: ${checkpoint.verification.required.join(', ')}.`
    : 'No extra acceptance criteria were inferred; still verify the requested outcome before finishing.';
  const steering = checkpoint.inbox.filter((item) => !item.appliedAt);
  const steeringText = steering.length
    ? `Live user updates: ${steering.map((item) => `[${item.action.toUpperCase()}] ${item.text}`).join(' | ')}`
    : '';

  return [
    `Orlynx harness phase: ${checkpoint.phase}. Step ${checkpoint.step}/${checkpoint.stepBudget}.`,
    criteria,
    `Active tool families: ${checkpoint.toolFamilies.length ? checkpoint.toolFamilies.join(', ') : 'none'}.`,
    budget.instruction || '',
    steeringText,
    'Do not claim completion until Orlynx verification criteria are satisfied. Progress text is not a final answer.',
  ].filter(Boolean).join(' ');
}
