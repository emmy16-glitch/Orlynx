# Workspace runtime (execution plane)

Long-lived work NEVER runs in Vercel functions: no OpenCode server process, no
PTY, no shell, no dev servers, no filesystem watchers, no persistent workers.

## Topology

Browser → Vercel control plane → workspace bridge endpoint → OpenCode instance
bound to `workspaceId`/session → GitHub (installation token, minted
server-side per installation).

Today `OPENCODE_BASE_URL` addresses a single engine instance: acceptable as
temporary single-workspace infrastructure, NOT multi-user production. The
provider abstraction (`apps/api/src/ai.ts` + engine adapter in `opencode.ts`)
is per-session (`openCodeSessions[lynxSessionId]`), so routing by workspace is
a config change, not an architecture change.

## Bridge security

`bridge/` is fail-closed: no `dev-token`/`ws_local` defaults, refuses to run
without explicit `ORLYNX_CONTROL` + `ORLYNX_WORKSPACE_TOKEN` +
`ORLYNX_WORKSPACE_ID`, allowlisted exec only. Production hardening (short-lived
signed per-workspace credentials bound to user/session/workspace/expiry)
is required before exposing the bridge beyond a trusted Codespace.
