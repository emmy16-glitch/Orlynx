import snapshot from './opencode-models.json' with { type: 'json' };

export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number; input?: number; output?: number };
  reasoning?: boolean;
  attachment?: boolean;
  tool_call?: boolean;
  status?: string;
  provider?: { npm?: string; api?: string };
}
export interface CatalogProvider {
  id: string;
  npm?: string;
  api?: string;
  models: Record<string, CatalogModel>;
}

let cached: CatalogProvider = snapshot;
let refresh: Promise<void> | undefined;
let refreshAfter = 0;

// The bundled catalog is immediately usable. Slow/outage-prone discovery never
// blocks the picker or a known model's first request.
export function openCodeCatalog(): CatalogProvider {
  if (Date.now() >= refreshAfter) void refreshOpenCodeCatalog();
  return cached;
}

export function refreshOpenCodeCatalog(): Promise<void> {
  if (refresh) return refresh;
  refreshAfter = Date.now() + 5 * 60_000;
  refresh = (async () => {
    const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('catalog_http_' + response.status);
    const data = await response.json() as Record<string, CatalogProvider>;
    const provider = data.opencode;
    if (!provider?.models || !Object.keys(provider.models).length) throw new Error('catalog_empty');
    for (const [id, model] of Object.entries(provider.models)) {
      if (model.id !== id || typeof model.name !== 'string') throw new Error('catalog_invalid');
      resolveModel(provider, id); // Validate routing before replacing the last good catalog.
    }
    cached = provider;
  })().catch(() => {
    console.warn('[direct-chat] catalog refresh unavailable; retaining last good snapshot');
  }).finally(() => { refresh = undefined; });
  return refresh;
}

export function resolveModel(provider: CatalogProvider, modelId: string) {
  const id = modelId.replace(/^opencode\//, '');
  const model = provider.models[id];
  if (!model) throw new Error('Model is not present in the OpenCode catalog: ' + id);
  const npm = model.provider?.npm ?? provider.npm ?? '@ai-sdk/openai-compatible';
  const baseURL = model.provider?.api ?? provider.api;
  if (!baseURL) throw new Error('OpenCode catalog has no endpoint for ' + id);
  const url = new URL(baseURL);
  // Catalog metadata must never send saved Zen credentials to another host.
  if (url.origin !== 'https://opencode.ai' || !url.pathname.startsWith('/zen/')) {
    throw new Error('OpenCode catalog contains an untrusted endpoint for ' + id);
  }
  return { id, model, npm, baseURL, free: model.cost?.input === 0 };
}

export function resolveAuth(free: boolean, savedKey?: string): { apiKey: string; publicAccess: boolean } {
  // Matches OpenCode's provider loader: saved credentials win; public is the
  // fallback only for zero-input-cost models when no account key is configured.
  if (savedKey) return { apiKey: savedKey, publicAccess: false };
  if (free) return { apiKey: 'public', publicAccess: true };
  throw new Error('Connect your OpenCode account to use this paid model.');
}
