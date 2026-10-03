import { createHash } from 'node:crypto';
import type { HarnessCheckpoint, ProjectSession, TaskRecord } from '@orlynx/shared';
import { controlPlaneRepository, type AgentLessonKind, type AgentLessonRecord } from './storage.js';

const STOP = new Set([
  'about','after','again','also','and','are','because','before','being','but','can','could','does','doing','for','from',
  'have','into','just','like','more','not','now','only','our','please','should','that','the','their','them','then','there',
  'these','they','this','those','through','use','using','want','what','when','where','which','while','with','would','you','your',
]);

function clean(value: string, max = 1_400): string {
  const redacted = String(value || '')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/ig, '$1[redacted]')
    .replace(/((?:token|password|secret|api[_ -]?key)\s*[:=]\s*)[^\s,;]+/ig, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function words(value: string): string[] {
  return [...new Set(
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9._-]{2,}/g)
      ?.filter((word) => !STOP.has(word) && !/^\d+$/.test(word))
      || [],
  )].slice(0, 40);
}

function lessonScore(lesson: AgentLessonRecord, query: Set<string>, projectId?: string, provider?: string): number {
  const searchable = new Set([
    ...lesson.tags,
    ...words(lesson.title),
    ...words(lesson.problem),
    ...words(lesson.lesson),
  ]);
  let overlap = 0;
  for (const token of query) if (searchable.has(token)) overlap += 1;
  // Memory must be relevant before it can influence a new run. Repository or
  // environment scope alone is not enough; otherwise unrelated old lessons
  // gradually pollute every future prompt.
  if (overlap === 0) return 0;
  let score = overlap * 3;
  if (lesson.projectId && lesson.projectId === projectId) score += 4;
  else if (lesson.scope === 'environment') score += 1;
  if (provider && lesson.provider === provider) score += 1;
  score += Math.min(3, Math.max(0, lesson.successCount - 1));
  const confidence = Math.max(0, Math.min(1, lesson.confidence ?? 0.65));
  score += Math.round(confidence * 3);
  const verifiedAt = Date.parse(lesson.lastVerifiedAt || lesson.updatedAt);
  if (Number.isFinite(verifiedAt)) {
    const ageDays = Math.max(0, (Date.now() - verifiedAt) / 86_400_000);
    if (ageDays > 180) score -= 2;
    else if (ageDays > 60) score -= 1;
  }
  return Math.max(0, score);
}

export async function relevantAgentLessons(
  session: ProjectSession & { userId: string; projectId: string },
  prompt: string,
  provider?: string,
): Promise<AgentLessonRecord[]> {
  const repository = controlPlaneRepository();
  const candidates = await repository.listAgentLessons(session.userId, session.projectId, 50);
  const query = new Set(words(prompt));
  const ranked = candidates
    .map((lesson) => ({ lesson, score: lessonScore(lesson, query, session.projectId, provider) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.lesson.updatedAt) - Date.parse(a.lesson.updatedAt))
    .slice(0, 5)
    .map((item) => item.lesson);
  if (ranked.length) await repository.touchAgentLessons(ranked.map((lesson) => lesson.id)).catch(() => {});
  return ranked;
}

export function agentMemoryInstruction(lessons: AgentLessonRecord[]): string {
  if (!lessons.length) return '';
  return [
    'Verified Orlynx experience from earlier successful work follows. Treat it as evidence, not as an infallible rule; compare it with the current environment before applying it.',
    ...lessons.map((lesson, index) => `${index + 1}. [id ${lesson.id}; ${lesson.kind || 'general'}; ${lesson.scope}; confidence ${Math.round((lesson.confidence ?? 0.65) * 100)}%] ${clean(lesson.title, 180)} — ${clean(lesson.lesson, 520)}`),
    'If current observations conflict with a remembered lesson, trust fresh verified evidence and update the diagnosis rather than forcing the old lesson.',
    'When fresh observable evidence clearly disproves one of these retrieved lessons, include [MEMORY_CONTRADICTION:<lesson-id>] in the public Model → Orlynx diagnostic so Orlynx can lower that lesson confidence. Do not mark a lesson contradicted merely because it was irrelevant.',
  ].join('\n');
}

function lessonId(userId: string, scope: string, projectId: string | undefined, kind: AgentLessonKind, target: string[], tags: string[]): string {
  return `lesson_${createHash('sha256')
    .update([userId, scope, projectId || 'global', kind, target.slice().sort().join(','), tags.slice(0, 12).join(',')].join('|'))
    .digest('hex')
    .slice(0, 24)}`;
}

function environmentRelevant(text: string): boolean {
  return /\b(codespaces?|render|opencode|preview|forward(?:ing|ed)?|app\.github\.dev|authentication|iframe|workspace|runner)\b/i.test(text);
}

function lessonKindFor(text: string): AgentLessonKind {
  const value = String(text || '').toLowerCase();
  if (/\bpreview|forward(?:ing|ed)?|localhost|port\b/.test(value)) return 'preview_pattern';
  if (/\b(render|codespaces?|runner|workspace|opencode|runtime|provider|bridge|connection|reconnect|timeout)\b/.test(value)) return 'infrastructure_recovery';
  if (/\b(test|vitest|jest|pytest|playwright|typecheck|build|compile|lint)\b/.test(value)) return 'build_test_recipe';
  if (/\b(deploy|deployment|publish|release|production)\b/.test(value)) return 'deployment_procedure';
  if (/\b(dependency|package|version|compatib|upgrade|downgrade|module)\b/.test(value)) return 'dependency_compatibility';
  if (/\b(convention|pattern|folder|directory|route|naming|architecture)\b/.test(value)) return 'repository_convention';
  return 'general';
}

export function memoryContradictionIds(finalText: string, allowedIds: string[] = []): string[] {
  const allowed = new Set(allowedIds.filter(Boolean));
  const ids = [...String(finalText || '').matchAll(/\[MEMORY_CONTRADICTION:([A-Za-z0-9_.:-]{3,160})\]/g)]
    .map((match) => match[1])
    .filter((id) => allowed.size === 0 || allowed.has(id));
  return [...new Set(ids)].slice(0, 20);
}

export async function recordMemoryContradictions(input: {
  session: ProjectSession & { userId: string; projectId: string };
  harness: HarnessCheckpoint;
  responseText: string;
}): Promise<string[]> {
  const allowed = input.harness.lessonsApplied || [];
  const ids = memoryContradictionIds(input.responseText, allowed);
  if (!ids.length) return [];
  const investigation = input.harness.investigation;
  const evidence = clean([
    investigation?.question || '',
    ...(investigation?.evidence || []),
    ...(input.harness.contradictions || []),
    investigation?.hypothesis || '',
  ].filter(Boolean).join(' | '), 1_000);
  await controlPlaneRepository().contradictAgentLessons(
    input.session.userId,
    ids,
    evidence || 'Fresh verified evidence contradicted a retrieved lesson.',
  );
  return ids;
}

async function persistLesson(value: AgentLessonRecord): Promise<void> {
  await controlPlaneRepository().putAgentLesson(value);
}

export async function rememberVerifiedLesson(input: {
  session: ProjectSession & { userId: string; projectId: string };
  task: TaskRecord;
  harness: HarnessCheckpoint;
  responseText: string;
  provider?: string;
}): Promise<string[]> {
  const attempts = Math.max(
    input.harness.reflectionAttempts ?? input.harness.salvageAttempts ?? 0,
    input.harness.modelReviewAttempts || 0,
  );
  if (attempts <= 0 || input.harness.verification.status !== 'passed') return [];

  const target = input.harness.reflectionTarget?.length
    ? input.harness.reflectionTarget
    : input.harness.verification.required;
  const contradictions = input.harness.contradictions || [];
  const investigation = input.harness.investigation;
  const evidence = [
    investigation?.question ? `Investigation question: ${investigation.question}` : '',
    investigation?.hypothesis ? `Verified hypothesis path: ${investigation.hypothesis}` : '',
    ...contradictions,
    ...(input.harness.reflectionEvidence || []),
    ...(investigation?.evidence || []),
    investigation?.repairAction ? `Repair action: ${investigation.repairAction}` : '',
    investigation?.outcome ? `Investigation outcome: ${investigation.outcome}` : '',
    `Verified acceptance: ${input.harness.verification.satisfied.join(', ') || 'requested outcome'}`,
    input.harness.modelReviewModelId
      ? `Selected-model review: ${input.harness.modelReviewModelId}`
      : '',
  ].map((item) => clean(item, 520)).filter(Boolean).slice(-16);
  const finalResolution = clean(input.responseText, 1_200);
  const resolution = clean([
    investigation?.outcome || '',
    investigation?.hypothesis ? `Working hypothesis that led to verification: ${investigation.hypothesis}` : '',
    finalResolution,
  ].filter(Boolean).join(' '), 1_400);
  if (!resolution) return [];

  const tags = words([
    input.task.prompt,
    input.provider || '',
    target.join(' '),
    contradictions.join(' '),
    evidence.join(' '),
  ].join(' '));
  const now = new Date().toISOString();
  const kind = lessonKindFor([
    input.task.prompt,
    target.join(' '),
    contradictions.join(' '),
    evidence.join(' '),
    resolution,
  ].join(' '));
  const title = clean(
    contradictions[0]
      || investigation?.question
      || `Resolved after reflection: ${target.join(', ') || 'task verification'}`,
    220,
  );

  const repositoryLesson: AgentLessonRecord = {
    id: lessonId(input.session.userId, 'repository', input.session.projectId, kind, target, tags),
    userId: input.session.userId,
    projectId: input.session.projectId,
    sessionId: input.session.id,
    scope: 'repository',
    kind,
    title,
    problem: clean(input.task.prompt, 1_000),
    lesson: resolution,
    evidence,
    tags,
    provider: input.provider,
    successCount: 1,
    confidence: 0.65,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await persistLesson(repositoryLesson);
  const ids = [repositoryLesson.id];

  const environmentText = `${input.task.prompt} ${contradictions.join(' ')} ${evidence.join(' ')}`;
  if (environmentRelevant(environmentText)) {
    const environmentLesson: AgentLessonRecord = {
      ...repositoryLesson,
      id: lessonId(input.session.userId, 'environment', undefined, kind, target, tags),
      projectId: undefined,
      scope: 'environment',
      title: clean(`Environment lesson: ${title}`, 220),
    };
    await persistLesson(environmentLesson);
    ids.push(environmentLesson.id);
  }

  return ids;
}
