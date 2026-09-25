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

  // Model discovery must never depend on decrypting a stored credential.
  // A broken/stale credential may affect paid execution, but it must not hide
  // the local catalog or free public models from the picker.
  let accountConnected = false;
  if (userId) {
    try {
      const row = await controlPlaneRepository().getProviderConnection(userId, 'opencode');
      accountConnected = Boolean(row && row.state === 'connected' && row.credential);
    } catch {
      accountConnected = false;
    }
  }

  return Object.values(provider.models).map((model): AIModel => {
    const free = model.cost?.input === 0;
    return {
      id: `opencode/${model.id}`,
      providerId: 'opencode',
      providerName: 'OpenCode',
      displayName: model.name,
      free,
      family: model.family || 'OpenCode',
      connected: accountConnected || free,
      status: accountConnected || free ? 'available' : 'needs-connection',
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
