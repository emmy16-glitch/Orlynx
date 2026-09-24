# Agent engine (OpenCode)

OpenCode is the default and only coding engine. The frontend never calls it
directly — every call goes through the Orlynx API (`apps/api/src/opencode.ts`
→ `agents.ts` → routes).

## Adapter surface (`opencode.ts`)

- `openCodeStatus(project?)` — `/global/health` plus `/agent` and `/provider`
  catalogs. Fail-closed with a plain-language message.
- `getOrCreateOpenCodeSession` — maps Orlynx session → OpenCode session,
  persisted in `store.db.openCodeSessions`.
- `promptOpenCode(project, sessionId, text, { model, agent })` — per-task model
  (`{providerID, modelID}`) and agent overrides. Falls back to
  `OPENCODE_AGENT` / `OPENCODE_MODEL` env defaults.
- `runOpenCodeShell` — terminal execution inside the imported repository.
- `abortOpenCodeSession`, `openCodeMessages`, `openCodeSessionStatus`,
  `openCodeDiff` — lifecycle, streaming, change capture.

## Task lifecycle (`agents.ts`)

`startRun(session, project, text, 'opencode', { modelId, mode,
tempPermission })` resolves session prefs, verifies engine health, maps the
mode to a verified engine agent (`resolveAgentForMode` checks the live `/agent`
list; unknown agents fall back to the default with a visible note), prepends
mode/permission guardrail instructions, and monitors until completion, timeout,
failure (classified via `classifyError`: rate_limit/quota/auth/engine/model/
permission/unknown) or cancellation. Each run persists
engine/provider/model/mode/permission as its receipt.

Advanced engine details (URL, version, agent list) appear only in
Settings → Agents. Normal UI shows only the unified AI state.
