import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCodeAccountKey } from './zen.js';

type ModelProviderConfig = {
  npm?: string;
  api?: string;
  shape?: 'responses' | 'completions';
  headers?: Record<string, string>;
};

type CatalogModel = {
  id: string;
  name?: string;
  cost?: { input?: number; output?: number };
  provider?: ModelProviderConfig;
};

type CatalogProvider = {
  id: string;
  npm: string;
  api?: string;
  models: Record<string, CatalogModel>;
};

const require = createRequire(import.meta.url);
const AI_ROOT = path.join(process.cwd(), '.render-ai');
const moduleCache = new Map<string, Promise<any>>();
let catalogPromise: Promise<CatalogProvider> | undefined;

function isFree(model: CatalogModel): boolean {
  return Number(model.cost?.input ?? -1) === 0 && Number(model.cost?.output ?? -1) === 0;
}

function fallbackNpm(modelId: string): string {
  const id = modelId.toLowerCase();
  if (/^(gpt-|o[134]-|muse-|grok-)/.test(id)) return '@ai-sdk/openai';
  if (/^(claude-|qwen3\.[5-8]-)/.test(id)) return '@ai-sdk/anthropic';
  if (/^(gemini-|gemma-)/.test(id)) return '@ai-sdk/google';
  return '@ai-sdk/openai-compatible';
}

async function importAiPackage(name: string): Promise<any> {
  let pending = moduleCache.get(name);
  if (!pending) {
    pending = (async () => {
      const resolved = require.resolve(name, { paths: [AI_ROOT, process.cwd()] });
      return import(pathToFileURL(resolved).href);
    })();
    moduleCache.set(name, pending);
  }
  return pending;
}

async function openCodeCatalog(): Promise<CatalogProvider> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const response = await fetch('https://models.dev/api.json', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const providers = await response.json() as Record<string, CatalogProvider>;
      const provider = providers.opencode;
      if (!provider?.models) throw new Error('OpenCode provider metadata is unavailable from models.dev.');
      return provider;
    })().catch((error) => {
      catalogPromise = undefined;
      throw error;
    });
  }
  return catalogPromise;
}

export function warmOpenCodeProviderLayer(): void {
  void Promise.all([
    openCodeCatalog(),
    importAiPackage('ai'),
    importAiPackage('@ai-sdk/openai-compatible'),
    importAiPackage('@ai-sdk/openai'),
    importAiPackage('@ai-sdk/anthropic'),
    importAiPackage('@ai-sdk/google'),
  ]).catch(() => {});
}

async function languageModel(input: { userId: string; modelId: string }) {
  const id = input.modelId.replace(/^opencode\//, '');
  let provider: CatalogProvider | undefined;
  let model: CatalogModel | undefined;

  try {
    provider = await openCodeCatalog();
    model = provider.models[id];
  } catch {
    // The live catalog is a routing aid, not a hard dependency. OpenCode Zen's
    // default provider is OpenAI-compatible, so retain a safe fallback.
  }

  const npm = model?.provider?.npm || provider?.npm || fallbackNpm(id);
  const baseURL = model?.provider?.api || provider?.api || 'https://opencode.ai/zen/v1';
  const free = model ? isFree(model) : /-free$|-contributor-free$|^big-pickle$/i.test(id);
  const apiKey = free ? 'public' : await openCodeAccountKey(input.userId);
  const headers = model?.provider?.headers || {};

  let sdk: any;
  if (npm === '@ai-sdk/openai') {
    const mod = await importAiPackage('@ai-sdk/openai');
    sdk = mod.createOpenAI({ name: 'opencode', baseURL, apiKey, headers });
  } else if (npm === '@ai-sdk/anthropic') {
    const mod = await importAiPackage('@ai-sdk/anthropic');
    sdk = mod.createAnthropic({ name: 'opencode', baseURL, apiKey, headers });
  } else if (npm === '@ai-sdk/google') {
    const mod = await importAiPackage('@ai-sdk/google');
    sdk = mod.createGoogleGenerativeAI({ name: 'opencode', baseURL, apiKey, headers });
  } else if (npm === '@ai-sdk/openai-compatible') {
    const mod = await importAiPackage('@ai-sdk/openai-compatible');
    sdk = mod.createOpenAICompatible({
      name: 'opencode',
      baseURL,
      apiKey,
      headers,
      includeUsage: true,
    });
  } else {
    throw new Error(`OpenCode model ${id} uses unsupported provider package ${npm}.`);
  }

  const language = typeof sdk.languageModel === 'function'
    ? sdk.languageModel(id)
    : typeof sdk === 'function'
      ? sdk(id)
      : undefined;
  if (!language) throw new Error(`OpenCode could not initialize model ${id}.`);
  return { language, free, id };
}

export async function streamWithOfficialOpenCode(input: {
  runtimeKey: string;
  userId: string;
  modelId: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
}): Promise<string> {
  input.onStatus?.('Thinking…');
  const [{ streamText }, resolved] = await Promise.all([
    importAiPackage('ai'),
    languageModel({ userId: input.userId, modelId: input.modelId }),
  ]);

  let full = '';
  try {
    const result = streamText({
      model: resolved.language,
      system: input.system,
      prompt: input.prompt,
      abortSignal: input.signal,
      maxRetries: 2,
    });

    for await (const delta of result.textStream) {
      if (!delta) continue;
      full += delta;
      input.onDelta(delta);
    }

    if (!full.trim()) {
      const finalText = String(await result.text || '');
      if (finalText) {
        full = finalText;
        input.onDelta(finalText);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (resolved.free && /403|forbidden|unauthorized/i.test(detail)) {
      throw new Error(`OpenCode rejected the public route for ${resolved.id}. The model is free, so this is not a paid-account quota or credential error. ${detail}`);
    }
    throw error;
  }

  if (!full.trim()) throw new Error('OpenCode completed without returning visible text.');
  return full;
}
