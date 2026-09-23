# Agent UI Guidelines (Orlynx)

WHEN IMPLEMENTING UI:
1. Search `apps/web/src/ui/product.tsx` + `primitives.tsx` FIRST.
2. Search the registry SECOND: `searchUIComponents({ intent, category, platform, tags })` in `src/ui/registry.tsx`.
3. Search approved external intelligence providers THIRD (stubs: 21st.dev/shadcn — discovery only).
4. Only create a new primitive if nothing appropriate exists — never duplicate Button/Modal/Card/Toast/Loader/Badge/Tabs.
5. Never paste an external component without adaptation: tokens, 44px targets, focus-visible, reduced-motion, mobile 360px check.
6. Use semantic tokens (`--surface`, `--primary`, `--agent-*`, `--git-*`); no hardcoded hex.
7. Follow spacing (`--sp-*`), radii (`--radius-*`), type scale.
8. Verify mobile (360/390/412), desktop (1024/1440), loading/error/empty states.
9. Stream work via `AgentWorkStream` + `mapping.ts` — show ACTION + OUTCOME, never chain-of-thought.
10. Keep infra invisible: "Work on cloud", "Preparing workspace", "Cloud ready" — never SKUs/ports/containers.
11. Run `npx tsc -p apps/web/tsconfig.json --noEmit` + `npm run build --workspace=@orlynx/web` before completion.
