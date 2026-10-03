export type PortableAdapterId = 'mini-swe' | 'cline';

export const PORTABLE_OPENAI_BASE = 'https://openrouter.ai/api/v1';
export const PORTABLE_DEFAULT_MODEL = 'openrouter/poolside/laguna-s-2.1:free';

export function portableAdapterConfig(id: PortableAdapterId) {
  const prefix = id === 'cline' ? 'ORLYNX_CLINE' : 'ORLYNX_MINI_SWE';
  const apiBase = process.env[`${prefix}_API_BASE`] || PORTABLE_OPENAI_BASE;
  const model = process.env[`${prefix}_MODEL`] || PORTABLE_DEFAULT_MODEL;
  const apiKey = process.env[`${prefix}_API_KEY`] || process.env.ORLYNX_OPENROUTER_API_KEY || '';
  return {
    apiBase,
    model,
    apiKey,
    configured: Boolean(apiBase && model && apiKey),
    reason: apiKey ? undefined : 'OpenRouter key is not configured.',
  };
}
