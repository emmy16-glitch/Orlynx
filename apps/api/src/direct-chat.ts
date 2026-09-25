import type { AgentMode, ProjectSession } from '@orlynx/shared';
import { controlPlaneRepository } from './storage.js';
import { githubRepositoryFile, githubRepositoryFiles } from './github.js';
import { streamWithOfficialOpenCode } from './opencode-local.js';

const active = new Map<string, AbortController>();

export type ExecutionPlane = 'direct' | 'workspace';

export function executionPlaneFor(text: string, mode: AgentMode): ExecutionPlane {
  if (mode === 'ask' || mode === 'plan') return 'direct';
  const value = text.toLowerCase();
  if (/^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|thanks?|thank you)[!.?\s]*$/i.test(text)) return 'direct';
  const requiresMachine = /\b(npm|pnpm|yarn|bun|pip|pytest|cargo|gradle|mvn|docker|compose|ffmpeg|terminal|shell|command|install|uninstall|compile|run\s+(the\s+)?(tests?|build|app|server|dev)|start\s+(the\s+)?(app|server|dev)|preview|deploy|migration|migrate|benchmark)\b/i.test(value);
  const mutatesRepo = /\b(fix|implement|edit|modify|change|update|delete|create|add|remove|rename|refactor|rewrite|commit|push|merge|revert|patch)\b/i.test(value);
  return requiresMachine || mutatesRepo ? 'workspace' : 'direct';
}

async function safeFile(project: string, branch: string, path: string, installationId?: number): Promise<string | null> {
  try {
    const text = await githubRepositoryFile(project, branch, path, installationId);
    return text.slice(0, 30_000);
  } catch { return null; }
}

async function repositoryContext(session: ProjectSession): Promise<string> {
  let root: { name: string; dir: boolean }[] = [];
  try { root = await githubRepositoryFiles(session.project, session.branch, '', session.installationId); } catch {}
  const names = root.map((item) => item.dir ? `${item.name}/` : item.name).slice(0, 120);
  const candidates = ['README.md','README','package.json','pyproject.toml','requirements.txt','Cargo.toml','go.mod','pom.xml','build.gradle','docker-compose.yml','compose.yml']
    .filter((name) => root.some((item) => !item.dir && item.name.toLowerCase() === name.toLowerCase()))
    .slice(0, 6);
  const loaded = await Promise.all(candidates.map(async (name) => ({ name, content: await safeFile(session.project, session.branch, name, session.installationId) })));
  const snippets: string[] = [];
  let used = 0;
  for (const item of loaded) {
    if (!item.content || used >= 55_000) continue;
    const remaining = 55_000 - used;
    const content = item.content.slice(0, remaining);
    snippets.push(`--- ${item.name} ---\n${content}`);
    used += content.length;
  }
  return [
    `Repository: ${session.project}`,
    `Branch: ${session.branch}`,
    names.length ? `Root entries:\n${names.join('\n')}` : '',
    ...snippets,
  ].filter(Boolean).join('\n\n');
}

export async function streamDirectRepositoryChat(input: {
  runId: string;
  session: ProjectSession & { userId: string; projectId: string };
  modelId: string;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
}): Promise<string> {
  const controller = new AbortController();
  active.set(input.runId, controller);
  try {
    const repository = controlPlaneRepository();
    const history = await repository.listMessages(input.session.id);
    const turns = history.slice(-16).filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.text,
    }));
    const latestUser = [...turns].reverse().find((turn) => turn.role === 'user')?.content || '';
    const casual = /^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|thanks?|thank you)[!.?'\s]*$/i.test(latestUser);
    if (!casual) input.onStatus?.('Reading repository…');
    const context = casual
      ? `Repository: ${input.session.project}\nBranch: ${input.session.branch}`
      : await repositoryContext(input.session);
    const system = [
      'You are Orlynx AI, assisting inside a GitHub-native coding workspace.',
      'For this direct chat turn you can reason about the repository context supplied below, but you do not have a shell or mutable checkout.',
      'Do not claim you ran commands, tests, builds, or changed files unless the execution plane actually did so.',
      'If the user asks for machine execution or repository mutation, explain that Orlynx will use the development environment for that work.',
      'Be concise, practical, and repository-aware.',
      context,
    ].join('\n\n');
    const transcript = turns.map((turn) => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`).join('\n\n');
    const prompt = [
      transcript ? 'Conversation so far:\n' + transcript : '',
      'Respond to the latest user message above. Do not repeat the transcript.',
    ].filter(Boolean).join('\n\n');

    return await streamWithOfficialOpenCode({
      runtimeKey: input.session.id,
      userId: input.session.userId,
      modelId: input.modelId,
      system,
      prompt,
      signal: controller.signal,
      onDelta: input.onDelta,
      onStatus: input.onStatus,
    });
  } finally {
    active.delete(input.runId);
  }
}

export function hasDirectRun(runId: string): boolean {
  return active.has(runId);
}

export function cancelDirectRun(runId: string): boolean {
  const controller = active.get(runId);
  if (!controller) return false;
  controller.abort(new Error('Cancelled by user.'));
  active.delete(runId);
  return true;
}
