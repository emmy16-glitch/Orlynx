# Orlynx UI Intelligence Layer

## 1. Repository state before implementation
- Monorepo (npm workspaces): `apps/api` (Express+TS, SSE, sessions/changes/attachments/cloud stubs), `apps/web` (React 18 + Vite 5, no UI lib), `packages/shared` (event/session types), `bridge/` (outbound-WS prototype), `data/` runtime dir (untracked).
- Git: only `Initial commit` on `main`; all product code untracked.
- Baseline: API `tsc` clean, 3/3 guard tests pass; **web `npm run build` FAILED** (`src/api.ts` used `import.meta.env` without `vite/client` types). No Tailwind/shadcn/Radix/motion/icons. Styling: 19-line `styles.css` with hardcoded hex + `.pri/.gho/.pill/.card` classes duplicated across `App.tsx`.

## 2. Architecture discovered
- Frontend: React 18, Vite 5, ReactDOM, TS strict (bundler resolution). No router (tab state), no store (useState), SSE via `EventSource ?after=seq` with replay.
- Chat: `POST /v1/sessions/:id/messages` → `startRun` → normalized events (`run.*`, `activity.*`, `message.*`, `tool.*`, `changes.updated`, `receipt.created`).
- Sessions: `POST /v1/sessions`, checkpoint goal/branch, `GET /v1/sessions/:id` (+head/workspace).
- Cloud: `POST /v1/sessions/:id/cloud` (preparing → ready @900ms) / `cloud/stop`; `LocalProvider` default, `createCodespaceViaGitHub` present but unwired (no token in localhost).
- Agents: `Engine = native|opencode|cline` (string only; native simulates planner + patch).
- Mobile: bottom tabs Agent/Files/Changes/Preview/More, chat-first, composer fixed above tabs — good IA, kept.
- Desktop: same 920px column (no adaptation). A11y: minimal (no live regions/focus rings).
- Duplication: buttons/pills/cards/pre blocks inline; raw event dump (`events.slice(-6)`) in chat; single `liveActivity` line.

## 3. Problems discovered
1. No design system — hex scattered, no semantic tokens, no light theme, no reduced-motion.
2. No primitive reuse — every screen reinvents Button/Badge/Card.
3. Agent work invisible — raw event types shown, no collapse, no receipts, no error recovery copy.
4. Approval uses generic flow; verbs not explicit everywhere.
5. Cloud language leaks provider concepts in places; no stepped transition.
6. Build broken (vite/client types). No UI tests. No registry — agents will invent Button #6.

## 4. Proposed architecture (implemented)
```
tokens.css (semantic) → components.css (motion, low-GPU)
  → Level 1 primitives.tsx (Button/IconButton/Badge/Card/Input/Spinner/Skeleton/Empty/Error/Icon)
  → Level 2 product.tsx (AgentStatusPill, CloudStatus, TaskActivityRow, ApprovalCard, ErrorCard, DiffSummary, AttachmentChip, PreviewStatus, CloudWorkspaceButton, SessionResumeCard)
  → Level 3 workstream.tsx (AgentWorkStream, LiveActivityPill, CloudTransition)
  → registry-data.json + registry.tsx (typed, searchable) + intelligence providers
  → App.tsx wires all of the above into REAL flows (same /v1 API, no backend change)
  → lab.tsx (?lab=1) replaces Storybook weight
```

## 5. Implementation decisions
- **Zero new runtime UI deps** (perf §19: low-end Android; no Radix/shadcn install — copy-and-own patterns instead).
- **Single icon family**: inline 1.8px-stroke SVGs (no icon lib).
- **CSS-only motion** honoring `prefers-reduced-motion`; `aria-live="polite"` only on workstream summaries.
- **Backend untouched**: event names consumed as-is (`file.changed` cast, not renamed).
- **Desktop**: max-width widen ≥1024px + `.ox-desktop` grid utility (chat stays first-class; no VS Code clone).
- **Lab**: `?lab=1` route, no Storybook dep.

## 6. External sources used
None vendored. shadcn/Radix **patterns** (focus-visible, 44px targets, explicit-verb approvals) adapted into owned code. 21st.dev/beUI/Beautiful UI/Transitions.dev used as **interaction inspiration only** (see `docs/ui-component-sources.md`). No remote runtime fetches.

## 7. License considerations
All UI code is Orlynx-internal (no copied files → no license obligations). If a future candidate is copied in, record URL/license/modifications in `docs/ui-component-sources.md` and convert to tokens before registry entry.

## 8. Migration notes
- `styles.css` now imports tokens; legacy `.pill/.card/.pri/.gho` remain as aliases — old markup renders identically.
- `App.tsx` header/tabs/approval/diff/activity replaced incrementally; fetch paths and SSE logic unchanged.
- `src/vite-env.d.ts` added (build fix).

## 9. Future extension points
- `searchUIComponents({intent, category, platform, tags})` internal API (Phase 22) — add providers without touching call sites.
- `TwentyFirstProvider` stub ready to shell to 21st.dev MCP/CLI as **dev-time discovery only**.
- Registry statuses: `candidate → approved → deprecated`.
- Light theme via `[data-theme="light"]` (tokens ready; toggle not yet exposed in Settings).
