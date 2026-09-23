# End-to-End Verification (2026-09-23)

## Automated
- `npx tsc -p apps/api/tsconfig.json --noEmit` → clean
- `npx tsc -p apps/web/tsconfig.json --noEmit` → clean
- `npm run test --workspace=@orlynx/api` → **12/12 pass** (3 guards, 5 UI-intelligence, 4 integration)
- `npm run build --workspace=@orlynx/web` → pass (167KB JS / 53.6KB gzip, 8.5KB CSS)
- `npm run build --workspace=@orlynx/api` → pass
- `node apps/api/test/e2e.js` (live :4000) → ALL E2E CHECKS PASSED
- No lint config exists (documented limitation; typecheck+tests are the gate).

## Runtime (live :4000)
Session create → message → run completed → changeset (base SHA) → cloud
(preparing→ready) → exec ok → SSE replay ordered → conflict guard — all verified
via curl/Node. Browser-viewport checks were static (CSS audit): `overflow-x: clip`,
44px targets, safe-area insets, truncated header names, `role=tablist`, polite
live regions. Interactive device testing on 360/390/412/1024/1440 remains for a
device pass (no emulator in this environment).

## Known limits
GitHub OAuth, real Codespaces, OpenCode/Cline processes, PTY terminal, preview
detection, and multi-device sync are stubs/mocks. Terminal helper keys are labels
only (no key injection into a PTY).
