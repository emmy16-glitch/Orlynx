# Agent UI Guidelines (Orlynx)

WHEN IMPLEMENTING UI:
1. Search `apps/web/src/ui/product.tsx` + `primitives.tsx` FIRST.
2. Search the registry SECOND: `searchUIComponents({ intent, category, platform, tags })` in `src/ui/registry.tsx`.
3. Search approved external intelligence providers THIRD (stubs: 21st.dev/shadcn — discovery only).
4. Only create a new primitive if nothing appropriate exists — never duplicate Button/Modal/Card/Toast/Loader/Badge/Tabs.
5. Never paste an external component without adaptation: tokens, 44px targets, focus-visible, reduced-motion, mobile 360px check.
6. Match the supplied warm cream/espresso/sand/blue visual reference; use semantic tokens (`--surface`, `--accent`, `--info`, `--agent-*`, `--git-*`) and no hardcoded component hex.
7. Follow spacing (`--sp-*`), radii (`--radius-*`), type scale.
8. Verify mobile (360/390/412), desktop (1024/1440), loading/error/empty states.
9. Stream work through the existing normalized `ActivityEvent` → `mapping.ts` → `AgentWorkStream` pipeline; show ACTION + OUTCOME, never chain-of-thought or raw event objects.
10. Keep infra invisible: "Work on cloud", "Preparing workspace", "Cloud ready" — never SKUs/ports/containers.
11. Preserve progressive disclosure: concise summary by default, structured evidence on first expansion, raw logs on a separate explicit action.
12. Keep IDs stable across lifecycle transitions/replay; group files and repeated low-level events rather than rendering one card per event.
13. Preserve page scroll follow-mode rules and batch stream updates; never pull a reader away from content they are inspecting.
14. Screen-reader announcements are polite, milestone-only; never announce tokens/log lines. Keep all state understandable without color and honor reduced-motion.
15. Run `npm test`, `npm run build`, and relevant web/API typechecks before completion; document device-only checks not covered by automation.
16. Keep GitHub credentials server-managed. Distinguish server authorization, imported remote repositories, local commits, and remote pushes in both state and copy.
