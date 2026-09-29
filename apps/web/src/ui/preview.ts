// Localhost → Preview: pure state-projection helpers. The backend /ports
// endpoint is the single source of truth (process → port → forwarded URL);
// everything here derives chat, tab and toolbar state from it. No mock state.

export interface PreviewPort {
  port: number;
  visibility?: string;
  url?: string;
}

/** Infrastructure ports that are never user previews (ssh/db/cache/debug). */
const NON_PREVIEW_PORTS = new Set([22, 23, 25, 2222, 3306, 5432, 6379, 6380, 27017, 27018, 9229, 9333, 5601]);

export function isPreviewablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536 && !NON_PREVIEW_PORTS.has(port);
}

/** Usable previews: previewable port + resolved URL, deduplicated by port. */
export function usablePreviews(ports: PreviewPort[]): PreviewPort[] {
  const seen = new Set<number>();
  const out: PreviewPort[] = [];
  for (const item of ports || []) {
    const port = Number(item?.port);
    if (!seen.has(port) && item?.url && isPreviewablePort(port)) {
      seen.add(port);
      out.push({ port, visibility: item.visibility, url: String(item.url) });
    }
  }
  return out;
}

export function requiresExternalPreview(item: PreviewPort | null | undefined): boolean {
  if (!item?.url || String(item.visibility || '').toLowerCase() !== 'private') return false;
  try {
    return /(?:^|\.)app\.github\.dev$/i.test(new URL(item.url).hostname);
  } catch {
    return false;
  }
}

/** Preferred frontend ports for the default selection (detection, not assumption). */
const FRONTEND_PORT_RANK = [5173, 3000, 3001, 8080, 4173, 8000, 5000, 3002, 4200, 9000, 8081];

/** Default selection: explicit hint first, then ranked frontend, then first. */
export function preferredPreviewPort(ports: PreviewPort[], hintPort?: number): PreviewPort | null {
  const usable = usablePreviews(ports);
  if (!usable.length) return null;
  if (hintPort && usable.some((p) => p.port === hintPort)) return usable.find((p) => p.port === hintPort)!;
  for (const rank of FRONTEND_PORT_RANK) {
    const match = usable.find((p) => p.port === rank);
    if (match) return match;
  }
  return usable[0];
}

const DEV_SERVER_PATTERN = /(^|[\s;"'`])(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|web)([\s;"'`]|$)|(^|[\s;"'`])(vite|next|nuxt|remix|astro|parcel|webpack\s+serve|expo\s+start|flutter\s+run|rails\s+s|django.*runserver|python3?\s+(-m\s+http\.server|.*(app|server|main)\.py)|http-server|live-server|serve\s)/i;
const NON_SERVER_PATTERN = /\b(build|test|lint|typecheck|tsc|jest|vitest|pytest|e2e|storybook:build|prisma\s+(migrate|generate|studio))\b/i;

/** True when a shell command looks like starting a dev server (not build/test). */
export function isDevServerCommand(command: string): boolean {
  if (!command) return false;
  return DEV_SERVER_PATTERN.test(command) && !NON_SERVER_PATTERN.test(command);
}

/** Sniff an explicit port hint from command text or server output. */
export function extractPortHint(text: string): number | undefined {
  if (!text) return undefined;
  const patterns = [
    /localhost:(\d{2,5})/i,
    /127\.0\.0\.1:(\d{2,5})/,
    /(?:port|PORT)[^\d]{0,12}(\d{2,5})/,
    /Local:\s*https?:\/\/[^\s:]+:(\d{2,5})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

export type PathResolution =
  | { kind: 'preview'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'invalid' };

type PreviewGateway = { prefix: string; token: string };

function previewGateway(url: URL): PreviewGateway | null {
  const match = url.pathname.match(/^(\/preview\/[^/]+\/\d+)(?:\/(.*))?$/);
  const token = url.searchParams.get('t') || '';
  if (!match || !token) return null;
  return { prefix: `${match[1]}/`, token };
}

function appLocation(base: URL, target: URL): { pathname: string; search: string; hash: string } | null {
  if (target.origin !== base.origin) return null;
  const gateway = previewGateway(base);
  let pathname = target.pathname || '/';
  if (gateway && pathname.startsWith(gateway.prefix)) {
    pathname = `/${pathname.slice(gateway.prefix.length)}`;
  }
  const params = new URLSearchParams(target.search);
  params.delete('t');
  return { pathname: pathname || '/', search: params.toString() ? `?${params.toString()}` : '', hash: target.hash };
}

function gatewayPreviewUrl(base: URL, location: { pathname: string; search?: string; hash?: string }): string {
  const gateway = previewGateway(base);
  if (!gateway) return new URL(`${location.pathname}${location.search || ''}${location.hash || ''}`, base.origin).toString();
  const target = new URL(base.toString());
  target.pathname = `${gateway.prefix}${String(location.pathname || '/').replace(/^\/+/, '')}`;
  const params = new URLSearchParams(base.search);
  params.set('t', gateway.token);
  const appParams = new URLSearchParams(location.search || '');
  for (const [key, value] of appParams) params.append(key, value);
  target.search = params.toString() ? `?${params.toString()}` : '';
  target.hash = location.hash || '';
  return target.toString();
}

/**
 * Resolve address-bar input against the selected preview.
 *
 * Codespaces use a dedicated forwarded origin. Warm Render runners use a
 * signed path gateway (/preview/<runner>/<port>/). Preserve that gateway path
 * until it has set the preview cookie; stripping it navigates to the runner
 * service itself rather than the user's app.
 */
export function resolvePreviewInput(baseUrl: string, input: string): PathResolution {
  const raw = (input || '').trim();
  if (!raw) return { kind: 'invalid' };
  let base: URL;
  try { base = new URL(baseUrl); } catch { return { kind: 'invalid' }; }

  if (/^https?:\/\//i.test(raw)) {
    let target: URL;
    try { target = new URL(raw); } catch { return { kind: 'invalid' }; }
    if (target.origin !== base.origin) return { kind: 'external', url: target.toString() };
    if (!previewGateway(base)) return { kind: 'preview', url: target.toString() };
    const location = appLocation(base, target);
    return location ? { kind: 'preview', url: gatewayPreviewUrl(base, location) } : { kind: 'invalid' };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { kind: 'invalid' };
  let target: URL;
  try { target = new URL(raw.startsWith('/') ? raw : `/${raw}`, 'https://preview.local'); }
  catch { return { kind: 'invalid' }; }

  if (previewGateway(base)) {
    return {
      kind: 'preview',
      url: gatewayPreviewUrl(base, { pathname: target.pathname, search: target.search, hash: target.hash }),
    };
  }
  return { kind: 'preview', url: new URL(`${target.pathname}${target.search}${target.hash}`, base.origin).toString() };
}

/** Expiry of a signed warm-runner preview URL, in epoch milliseconds. */
export function previewAuthorizationExpiresAt(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (!previewGateway(parsed)) return undefined;
    const raw = String(parsed.searchParams.get('t') || '').split('.')[0];
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-sign the current app location with the newest warm-runner gateway URL.
 * Dedicated-origin previews are already stable and are returned unchanged.
 */
export function refreshPreviewAuthorization(baseUrl: string, currentUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const current = new URL(currentUrl);
    if (current.origin !== base.origin) return undefined;
    if (!previewGateway(base)) return current.toString();
    const location = appLocation(base, current);
    return location ? gatewayPreviewUrl(base, location) : undefined;
  } catch {
    return undefined;
  }
}

/** Human-facing app path; hides the warm-runner gateway prefix and auth token. */
export function previewDisplayPath(baseUrl: string | undefined, currentUrl: string | null): string {
  if (!currentUrl) return '/';
  try {
    const current = new URL(currentUrl);
    if (!baseUrl) return `${current.pathname}${current.search}` || '/';
    const base = new URL(baseUrl);
    const location = appLocation(base, current);
    return location ? `${location.pathname}${location.search}` || '/' : '/';
  } catch {
    return '/';
  }
}

/** Open the current app route externally, renewing signed gateway auth when needed. */
export function externalPreviewUrl(baseUrl: string, currentUrl: string): string {
  try {
    const base = new URL(baseUrl);
    const current = new URL(currentUrl);
    if (current.origin !== base.origin) return baseUrl;
    return refreshPreviewAuthorization(baseUrl, currentUrl) || baseUrl;
  } catch {
    return baseUrl;
  }
}
