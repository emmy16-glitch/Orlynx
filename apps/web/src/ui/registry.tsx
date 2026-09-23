// Approved component registry (typed TS over registry-data.json).
// External candidates: copy-and-own → sanitize → tokens → a11y → registry. Never runtime-fetch.
import data from './registry-data.json';

export type RegistrySource = 'orlynx' | 'shadcn' | 'beautiful-ui' | '21st' | 'beui' | 'custom';
export interface UIRegistryItem {
  id: string; name: string; category: string; description: string;
  source: RegistrySource; path: string; platforms: string[];
  mobileFriendly: boolean; accessibility: 'verified' | 'review' | 'unknown';
  motion: 'low' | 'medium' | 'high'; useFor: string[]; avoidFor: string[];
  dependencies: string[]; license: string; status: 'approved' | 'candidate' | 'deprecated';
  tags: string[];
}

export const REGISTRY = data as UIRegistryItem[];

export function getComponent(id: string): UIRegistryItem | undefined {
  return REGISTRY.find((r) => r.id === id);
}

// ---- UI intelligence providers (Phase 4/22). Internal TS service, no network in V1.
export interface UISearchQuery { intent?: string; category?: string; platform?: 'mobile' | 'desktop'; tags?: string[]; }
export interface UIIntelligenceProvider { name: string; search(q: UISearchQuery): UIRegistryItem[]; }

export const OrlynxRegistryProvider: UIIntelligenceProvider = {
  name: 'orlynx-registry',
  search(q) {
    const needle = `${q.intent || ''} ${q.category || ''} ${(q.tags || []).join(' ')}`.toLowerCase();
    return REGISTRY.filter((r) => {
      if (q.platform === 'mobile' && !r.mobileFriendly) return false;
      if (q.category && r.category !== q.category) return false;
      if (!needle.trim()) return true;
      const hay = `${r.name} ${r.description} ${r.tags.join(' ')} ${r.category}`.toLowerCase();
      return needle.split(/\s+/).some((w) => w.length > 2 && hay.includes(w));
    });
  },
};

// Optional discovery stubs: kept offline-first; wire CLI/MCP only as dev tool.
export const TwentyFirstProvider: UIIntelligenceProvider = {
  name: '21st-dev (discovery only)',
  search() { return []; }, // candidates must pass quality gate + copy-and-own before entering REGISTRY
};
export const ShadcnRegistryProvider: UIIntelligenceProvider = {
  name: 'shadcn (adaptation source)',
  search() { return []; },
};

const PROVIDERS: UIIntelligenceProvider[] = [OrlynxRegistryProvider, TwentyFirstProvider, ShadcnRegistryProvider];

export function searchUIComponents(q: UISearchQuery): UIRegistryItem[] {
  const seen = new Map<string, UIRegistryItem>();
  for (const p of PROVIDERS) for (const r of p.search(q)) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}
