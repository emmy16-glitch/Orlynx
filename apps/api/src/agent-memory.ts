import { createHash } from 'node:crypto';
import type { HarnessCheckpoint, ProjectSession, TaskRecord } from '@orlynx/shared';
import { controlPlaneRepository, type AgentLessonRecord } from './storage.js';

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
  return score;
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
    ...lessons.map((lesson, index) => `${index + 1}. [${lesson.scope}] ${clean(lesson.title, 180)} — ${clean(lesson.lesson, 520)}`),
    'If current observations conflict with a remembered lesson, trust fresh verified evidence and update the diagnosis rather than forcing the old lesson.',
  ].join('\n');
}

function lessonId(userId: string, scope: string, projectId: string | undefined, target: string[], tags: string[]): string {
  return `lesson_${createHash('sha256')
    .update([userId, scope, projectId || 'global', target.slice().sort().join(','), tags.slice(0, 12).join(',')].join('|'))
    .digest('hex')
    .slice(0, 24)}`;
}

function environmentRelevant(text: string): boolean {
  return /\b(codespaces?|render|opencode|preview|forward(?:ing|ed)?|app\.github\.dev|authentication|iframe|workspace|runner)\b/i.test(text);
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
  const attempts = input.harness.reflectionAttempts ?? input.harness.salvageAttempts ?? 0;
  if (attempts <= 0 || input.harness.verification.status !== 'passed') return [];

  const target = input.harness.reflectionTarget?.length
    ? input.harness.reflectionTarget
    : input.harness.verification.required;
  const contradictions = input.harness.contradictions || [];
  const evidence = [
    ...contradictions,
    ...(input.harness.reflectionEvidence || []),
    `Verified acceptance: ${input.harness.verification.satisfied.join(', ') || 'requested outcome'}`,
  ].map((item) => clean(item, 520)).filter(Boolean).slice(-12);
  const resolution = clean(input.responseText, 1_200);
  if (!resolution) return [];

  const tags = words([
    input.task.prompt,
    input.provider || '',
    target.join(' '),
    contradictions.join(' '),
    evidence.join(' '),
  ].join(' '));
  const now = new Date().toISOString();
  const title = clean(
    contradictions[0]
      || `Resolved after reflection: ${target.join(', ') || 'task verification'}`,
    220,
  );

  const repositoryLesson: AgentLessonRecord = {
    id: lessonId(input.session.userId, 'repository', input.session.projectId, target, tags),
    userId: input.session.userId,
    projectId: input.session.projectId,
    sessionId: input.session.id,
    scope: 'repository',
    title,
    problem: clean(input.task.prompt, 1_000),
    lesson: resolution,
    evidence,
    tags,
    provider: input.provider,
    successCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  await persistLesson(repositoryLesson);
  const ids = [repositoryLesson.id];

  const environmentText = `${input.task.prompt} ${contradictions.join(' ')} ${evidence.join(' ')}`;
  if (environmentRelevant(environmentText)) {
    const environmentLesson: AgentLessonRecord = {
      ...repositoryLesson,
      id: lessonId(input.session.userId, 'environment', undefined, target, tags),
      projectId: undefined,
      scope: 'environment',
      title: clean(`Environment lesson: ${title}`, 220),
    };
    await persistLesson(environmentLesson);
    ids.push(environmentLesson.id);
  }

  return ids;
}
