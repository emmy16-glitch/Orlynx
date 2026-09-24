// Canonical public origin. Production GitHub configuration must use exactly
// this URL — never localhost, preview, or tunnel URLs.
export function publicSiteUrl(): string {
  const raw = (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return raw;
  } catch { /* not configured */ }
  return '';
}
