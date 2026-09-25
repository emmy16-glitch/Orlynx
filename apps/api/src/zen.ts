import type { AIModel } from '@orlynx/shared';
import { decryptCredential } from './credentials.js';
import { controlPlaneRepository } from './storage.js';
import { openCodeCatalog, refreshOpenCodeCatalog } from './opencode-catalog.js';

export async function savedOpenCodeAccountKey(userId: string): Promise<string | undefined> {
  const row = await controlPlaneRepository().getProviderConnection(userId, 'opencode');
  if (!row || row.state !== 'connected' || !row.credential) return undefined;
  return decryptCredential(row.credential);
}

export async function openCodeAccountKey(userId: string): Promise<string> {
  const key = await savedOpenCodeAccountKey(userId);
  if (!key) throw new Error('Connect your OpenCode account before using a paid model.');
  return key;
}

export async function listZenModels(userId?: string, force = false): Promise<AIModel[]> {
  if (force) void refreshOpenCodeCatalog();
  const provider = openCodeCatalog();
  const connected = userId ? Boolean(await savedOpenCodeAccountKey(userId)) : false;
  return Object.values(provider.models).map((model): AIModel => {
    const free = model.cost?.input === 0;
    return {
      id: `opencode/${model.id}`,
      providerId: 'opencode', providerName: 'OpenCode',
      displayName: model.name + (free && !/free/i.test(model.name) ? ' · Free' : ''),
      family: model.family || 'OpenCode',
      connected: connected || free,
      status: connected || free ? 'available' : 'needs-connection',
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
