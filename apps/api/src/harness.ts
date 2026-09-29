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

export const MAX_REFLECTION_ATTEMPTS = Math.max(2, Number(process.env.ORLYNX_MAX_REFLECTION_ATTEMPTS || 4));

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
  // "Any update on main?" is a status question, not a request to edit files.
  // Treat update as a mutation only when the prompt is not clearly asking for
  // progress/status. Strong mutation verbs remain authoritative.
  const statusUpdateQuery = /^(?:what(?:'s| is)?|any|give me|show me|tell me|check)\s+(?:the\s+)?(?:latest\s+|current\s+)?(?:update|updates|status|progress)\b/.test(value)
    || /^(?:update|updates)\s+(?:on|about|from|for)\b/.test(value)
    || /^(?:update|updates)\s*[?!.]*$/.test(value)
    || /\b(?:what(?:'s| is)|any)\s+(?:new\s+)?updates?\s+(?:on|in|from|for|about)\b/.test(value);
  const explicitMutation = /\b(fix|implement|edit|change|refactor|rewrite|add|remove|rename)\b/.test(value)
    || (/\bupdate\b/.test(value) && !statusUpdateQuery);

  if (explicitMutation) required.add('changes');
  if (/\b(test|tests|testing|pytest|npm test|unit test|e2e|playwright)\b/.test(value)) required.add('tests');
  if (/\b(build|compile|typecheck|lint)\b/.test(value)) required.add('build');
  if (/\bcommit\b/.test(value)) required.add('commit');
  if (/\b(push|publish)\b/.test(value) || /\bto\s+main\b/.test(value)) required.add('publish');
  if (/\b(deploy|deployment|redeploy)\b/.test(value)) required.add('deployment');
  if (/\b(localhost|local\s*host|preview|start\s+(?:the\s+)?(?:app|server|dev))\b/.test(value)) required.add('preview');
  if (/\b(?:check|search|look\s*up|research|browse)\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:latest|current|official)\s+(?:online\s+)?(?:docs|documentation)\b|\bweb(?:search|fetch)\b/.test(value)) required.add('browser');

  return [...required];
}

export function toolFamiliesFor(input: {
  mode: AgentMode;
  permission: PermissionProfile;
  phase: HarnessCheckpoint['phase'];
  required?: string[];
  budgetStage?: BudgetStage;
}): ToolFamily[] {
  if (input.budgetStage === 'force-final' || input.phase === 'waiting_input' || input.phase === 'finalizing' || input.phase === 'completed' || input.phase === 'failed' || input.phase === 'cancelled') {
    return [];
  }

  const readOnly: ToolFamily[] = ['repository'];
  if (input.mode !== 'build' || input.permission === 'read-only') return readOnly;
  if (input.phase === 'received' || input.phase === 'routing') return ['repository'];
  if (input.phase === 'context_loading') return readOnly;

  const families = new Set<ToolFamily>(['repository', 'filesystem', 'terminal']);
  const required = new Set(input.required || []);
  if (required.has('tests') || required.has('build') || input.phase === 'verifying') families.add('tests');
  if (required.has('commit') || required.has('publish') || input.phase === 'verifying') families.add('git');
  if (required.has('preview') || input.phase === 'verifying') families.add('preview');
  if (required.has('deployment')) families.add('deployment');
  if (required.has('browser')) families.add('browser');

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
    reflectionAttempts: 0,
    finalSynthesisAttempts: 0,
    contradictions: [],
    reflectionEvidence: [],
    stagnantReflections: 0,
    lessonsApplied: [],
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

export function queueIntentFor(text: string): boolean {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return /^(?:please\s+)?(?:queue|enqueue)\b|\b(?:queue|enqueue)\s+(?:this|that|it|the\s+(?:task|request))\b|\b(?:after|once)\s+(?:this|that|the\s+current\s+(?:task|work))\s+(?:is\s+)?(?:done|finished|complete)|\bwhen\s+(?:you(?:'re|\s+are)|this\s+is)\s+(?:done|finished)\b|^(?:next\s+task|do\s+this\s+next)\b/i.test(value);
}

export function steeringActionFor(text: string): SteeringAction {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return 'ignore';

  if (/^(?:please\s+)?(?:stop|cancel|abort|halt|never\s*mind|nevermind)(?:\s+(?:it|this|that|the\s+task|current\s+task|the\s+current\s+task|current\s+job|the\s+current\s+job|job))?[.!?\s]*$/.test(value)) return 'stop';
  if (/\b(?:forget|ignore)\s+(?:that|the\s+(?:previous|original)|what\s+i\s+said)|\binstead\b|\bchange\s+(?:the\s+)?request\b|\bonly\s+(?:do|check|fix|work)\b/.test(value)) return 'replace';
  if (/^(?:also|and\s+also|additionally|plus)\b|\bmake\s+sure\b|\bdon't\s+forget\b|\bwhile\s+you(?:'re|\s+are)\b/.test(value)) return 'append';
  // Referential status/follow-up language continues the active task. An
  // unrelated new imperative (for example "start localhost" while a status
  // check is still running) remains "ignore" so admission creates the next
  // distinct turn instead of silently merging two requests.
  if (/^(?:what(?:'s| is)\s+(?:the\s+)?(?:update|status|progress|happening|going\s+on)|any\s+(?:new\s+)?updates?|what\s+have\s+you\s+(?:done|found)|have\s+you\s+(?:done|fixed|finished)|how\s+far|finish(?:\s+it|\s+up)?|continue|carry\s+on|keep\s+going|check\s+again|still\s+check|try\s+again|retry)\b/.test(value)) return 'append';
  if (/^[?!.]{2,}$/.test(value)) return 'append';

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
      const semanticType = String(payload.semanticType || '').toLowerCase();
      const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : 0;
      if (exitCode === 0 && /\bgit\s+commit\b/.test(command)) found.add('commit');
      if (exitCode === 0 && /\bgit\s+push\b/.test(command)) found.add('publish');
      if (exitCode === 0 && (
        semanticType === 'build-result'
        || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint)\b/.test(command)
        || /\btsc\b/.test(command)
      )) found.add('build');
      const tool = String(payload.tool || payload.toolName || '').toLowerCase();
      if (exitCode === 0 && ['webfetch', 'websearch'].includes(tool)) found.add('browser');
      if (exitCode === 0 && (
        semanticType === 'test-result'
        || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(command)
        || /\bnode\s+--test\b|\bpytest\b|\bplaywright\b|\bvitest\b|\bjest\b/.test(command)
      )) found.add('tests');
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

function eventText(event: OrlynxEvent): string {
  const payload = event.payload || {};
  return [
    event.type,
    payload.command,
    payload.cmd,
    payload.out,
    payload.stderr,
    payload.outDelta,
    payload.delta,
    payload.summary,
    payload.error,
    payload.message,
    payload.state,
    payload.status,
  ].filter(Boolean).join(' ').slice(0, 2_000);
}

export function evidenceSummary(events: OrlynxEvent[]): string[] {
  return events.slice(-80).flatMap((event) => {
    if (![
      'tool.completed','tool.failed','tool.output','terminal.exited',
      'test.result','build.result','preview.ready','workspace.ready',
      'workspace.state','receipt.created',
    ].includes(event.type)) return [];
    const text = eventText(event).replace(/\s+/g, ' ').trim();
    return text ? [text.slice(0, 420)] : [];
  }).slice(-10);
}

export function detectEvidenceContradictions(events: OrlynxEvent[], missing: string[] = []): string[] {
  const contradictions: string[] = [];
  const text = events.map(eventText).join('\n').toLowerCase();

  if (
    missing.includes('preview')
    && /(?:http\/1\.[01]\s+200|code=200|http[_ -]?code[^\d]*200|\b200\s+ok\b)/.test(text)
    && /(?:localhost|127\.0\.0\.1|\blisten(?:ing)?\b|vite)/.test(text)
  ) {
    contradictions.push('The local web server appears healthy, but the externally usable Preview is still unverified. Diagnose preview forwarding/authentication/embedding instead of assuming the app server failed.');
  }
  if (
    missing.includes('build')
    && /(?:✓\s*built|build\s+(?:passed|successful|succeeded)|compiled successfully)/.test(text)
  ) {
    contradictions.push('Build output looks successful, but canonical build verification is missing. Reconcile the evidence/event mapping before rebuilding blindly.');
  }
  if (
    missing.includes('tests')
    && /(?:tests?\s+passed|\b\d+\s+passed\b|0\s+failed)/.test(text)
  ) {
    contradictions.push('Test output looks successful, but canonical test verification is missing. Reconcile the evidence/event mapping before rerunning the same tests.');
  }
  if (/adapter status[^\n]*ready|opencode=ready/.test(text) && /ai runtime unavailable/.test(text)) {
    contradictions.push('The adapter reports ready while another signal says the AI runtime is unavailable. Treat this as conflicting subsystem evidence and inspect the failing layer before concluding the provider is down.');
  }

  return [...new Set(contradictions)];
}

export function shouldReflect(checkpoint: HarnessCheckpoint, finalText: string): boolean {
  const text = String(finalText || '').trim();
  const attempts = checkpoint.reflectionAttempts ?? checkpoint.salvageAttempts ?? 0;
  if (attempts >= MAX_REFLECTION_ATTEMPTS) return false;
  if (harnessBudgetStatus(checkpoint).stage === 'force-final') return false;
  if (checkpoint.verification.status === 'needs_more_work') return true;
  if (!text) return true;
  if (text.length < 180 && /\b(?:working on|starting|checking|looking into|next i(?:'ll| will)|still working|in progress)\b/i.test(text)) return true;
  return false;
}

/** Backward-compatible name for existing callers/tests. */
export const shouldSalvage = shouldReflect;

export function prepareReflection(
  checkpoint: HarnessCheckpoint,
  events: OrlynxEvent[],
  now = new Date().toISOString(),
): HarnessCheckpoint {
  const attempts = (checkpoint.reflectionAttempts ?? checkpoint.salvageAttempts ?? 0) + 1;
  const contradictions = detectEvidenceContradictions(events, checkpoint.verification.missing);
  const evidence = evidenceSummary(events);
  const signature = JSON.stringify({
    missing: checkpoint.verification.missing.slice().sort(),
    contradictions,
    evidence: evidence.slice(-4),
  });
  const stagnant = checkpoint.lastReflectionSignature === signature
    ? (checkpoint.stagnantReflections || 0) + 1
    : 0;

  return {
    ...checkpoint,
    salvageAttempts: attempts,
    reflectionAttempts: attempts,
    reflectionTarget: checkpoint.reflectionTarget?.length
      ? checkpoint.reflectionTarget
      : [...checkpoint.verification.missing],
    contradictions,
    reflectionEvidence: evidence,
    lastReflectionSignature: signature,
    stagnantReflections: stagnant,
    phase: 'executing',
    lastCheckpointAt: now,
    updatedAt: now,
  };
}

export function reflectionInstruction(checkpoint: HarnessCheckpoint, lessons: string[] = []): string {
  const attempts = checkpoint.reflectionAttempts ?? checkpoint.salvageAttempts ?? 1;
  const missing = checkpoint.verification.missing.join(', ') || 'the requested outcome';
  const contradictionText = checkpoint.contradictions?.length
    ? `Observed contradictions: ${checkpoint.contradictions.join(' | ')}`
    : 'No explicit contradiction was detected; inspect the newest evidence before choosing the next action.';
  const evidenceText = checkpoint.reflectionEvidence?.length
    ? `Observable evidence: ${checkpoint.reflectionEvidence.join(' | ')}`
    : 'Observable evidence is sparse; inspect the environment before concluding.';
  const lessonText = lessons.length
    ? `Verified lessons from earlier successful work: ${lessons.join(' | ')}`
    : '';
  const stagnant = (checkpoint.stagnantReflections || 0) > 0
    ? 'The unresolved evidence is substantially the same as the previous reflection. Do not repeat the same failed command or hypothesis without gathering new evidence; choose a different diagnostic path.'
    : 'Do not repeat the same failed command or hypothesis without new evidence. Inspect first, then choose the next action.';

  return [
    `Reflection cycle ${attempts}/${MAX_REFLECTION_ATTEMPTS}. Orlynx still cannot verify: ${missing}.`,
    contradictionText,
    evidenceText,
    lessonText,
    stagnant,
    'You are the reasoning layer. Diagnose what the observations actually imply before acting. Distinguish the application, workspace, provider, forwarding, authentication, browser and UI layers instead of collapsing them into one generic failure.',
    'Before calling the next tool, stream exactly one concise public diagnostic line beginning with "Model → Orlynx:". State only the current hypothesis and next check; do not expose private chain-of-thought.',
    checkpoint.verification.missing.includes('preview')
      ? 'When localhost is healthy but Preview is not, diagnose Orlynx/provider forwarding before editing the repository. Orlynx already supplies cloud-preview compatibility to supported dev servers such as Vite. Change project config only when fresh evidence proves the application itself overrides or blocks the provider-safe defaults. If a diagnostic-only project change is no longer needed after the provider issue is resolved, revert it before completion.'
      : '',
    checkpoint.verification.missing.includes('preview')
      ? 'For long-running dev servers, detach the process cleanly from the tool invocation and redirect its stdio to a log before verifying the port. Do not keep retrying a shell command that timed out only because its background child kept the tool pipe open.'
      : '',
    'Use tools to test the next hypothesis. Prefer inspection and reversible actions. Do not tell the user a subsystem is broken unless the evidence supports that exact conclusion.',
    'If information or authorization can be obtained with available tools, obtain it yourself. Ask the user only when a required secret, choice, physical action, or permission genuinely cannot be derived or performed.',
    'If user input is genuinely unavoidable, begin the final response with [NEEDS_USER_INPUT] and ask one precise question. Otherwise continue autonomously until verification passes or the reflection budget is exhausted.',
  ].filter(Boolean).join('\n\n');
}

export function userInputRequest(finalText: string): string | undefined {
  const text = String(finalText || '').trim();
  const marker = /\[NEEDS_USER_INPUT\]\s*([\s\S]*)/i.exec(text);
  if (!marker) return undefined;
  const question = String(marker[1] || '').trim();
  return question || 'Orlynx needs information only you can provide before it can continue.';
}

export function openCodeToolsFor(checkpoint: HarnessCheckpoint): Record<string, boolean> {
  const enabled = new Set(checkpoint.toolFamilies);
  const repository = enabled.has('repository');
  const filesystem = enabled.has('filesystem');
  const shell = enabled.has('terminal') || enabled.has('tests') || enabled.has('git') || enabled.has('preview') || enabled.has('deployment');
  const browser = enabled.has('browser');

  return {
    read: repository || filesystem,
    grep: repository,
    glob: repository,
    list: repository,
    write: filesystem,
    edit: filesystem,
    patch: filesystem,
    bash: shell,
    shell,
    webfetch: browser,
    websearch: browser,
  };
}

export function needsFinalSynthesis(checkpoint: HarnessCheckpoint, finalText: string): boolean {
  const text = String(finalText || '').trim();
  if (!text) return true;
  return text.length < 220 && /\b(?:working on|starting|checking|looking into|next i(?:'ll| will)|still working|in progress|continuing)\b/i.test(text);
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
    checkpoint.verification.required.includes('preview')
      ? 'For a cloud-workspace development server, bind the app to 0.0.0.0 (for example Vite --host 0.0.0.0) unless the framework has a verified equivalent. Do not treat a loopback-only 127.0.0.1 listener as remotely previewable. Let Orlynx verify provider forwarding separately.'
      : '',
    'When an observation is unexpected or conflicts with another signal, do not guess. Inspect the evidence and let the connected reasoning model form the next hypothesis.',
    'Do not ask the user for information that repository, terminal, browser, provider, workspace, or other available tools can determine. Escalate only for genuinely human-only input or permission.',
    'Do not claim completion until Orlynx verification criteria are satisfied. Progress text is not a final answer.',
  ].filter(Boolean).join(' ');
}
