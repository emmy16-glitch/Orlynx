// Localhost → Preview: pure state-projection helpers. The backend /ports
// endpoint is the single source of truth (process → port → forwarded URL);
// everything here derives chat, tab and toolbar state from it. No mock state.

export interface PreviewPort {
  port: number;
  visibility?: string;
  url?: string;
}

/** Infrastructure ports that are never user previews (ssh/db/cache/debug). */
const NON_PREVIEW_PORTS = new Set([22, 23, 25, 3306, 5432, 6379, 6380, 27017, 27018, 9229, 9333, 5601]);

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

/**
 * Resolve address-bar input against the selected preview origin.
 * Relative paths stay in-preview; same-origin absolute URLs are allowed;
 * anything else is offered externally, never silently loaded.
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
    return { kind: 'preview', url: target.toString() };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { kind: 'invalid' };
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return { kind: 'preview', url: `${base.origin}${path}` };
}

/** Append the current preview path when opening externally (same origin only). */
export function externalPreviewUrl(baseUrl: string, currentUrl: string): string {
  try {
    const base = new URL(baseUrl);
    const current = new URL(currentUrl);
    if (current.origin === base.origin) return current.toString();
  } catch { /* fall through to base */ }
  return baseUrl;
}
