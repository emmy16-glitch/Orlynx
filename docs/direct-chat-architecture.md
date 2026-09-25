# Direct chat and development execution

Normal chat runs in the persistent Node API through AI SDK 6. It does not spawn
OpenCode, install packages, start a localhost server, clone a repository, or
request a Codespace. The existing messages, task queue, event ledger and SSE
connection remain the source of truth. Development execution still uses the
workspace adapter for commands, builds, tests and repository edits.

## Provider runtime and packaging

`apps/api/package.json` owns `ai`, `@ai-sdk/openai`,
`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, and `@ai-sdk/google` as pinned
production dependencies. Install at the monorepo root using `npm ci` with the
committed lockfile. No `.render-ai` directory or custom `require.resolve` path
is used. Provider imports use literal module specifiers and normal Node ESM
resolution. `npm run verify:provider-runtime --workspace=@orlynx/api` must pass
AFTER compiling the API, in CI and in the Render build. Startup checks the
same dependencies before listening, so broken packaging fails deployment
instead of the user's first message.

The original deployment installed runtime packages in a separate prefix after
`npm run build`. TypeScript could not check the dynamically resolved packages,
and warmup swallowed failures. The reported missing-module error demonstrates
that this layout did not yield a resolvable runtime. The exact deployed working
directory/filesystem still requires Render logs to confirm.

## Catalog and transport selection

The picker and transport share the same models.dev catalog. A bundled snapshot
loads immediately. One background refresh runs at most every five minutes;
failure retains the last good snapshot. Regenerate intentionally with
`node scripts/refresh-opencode-catalog.mjs` and review the result. The initial
snapshot was assembled on 2026-09-25 from the official models.dev TOML definitions
and their canonical `models/` base models, including capability and cost fields.

Resolution is model `provider.npm` / `provider.api`, then provider-level
`npm` / `api`, with the official OpenAI-compatible package default. There are
no model-name routing guesses, endpoint retries across protocols, random model
switches or model blacklists. Unknown model IDs fail explicitly. Catalog URLs
must remain on the OpenCode Zen origin before any saved credential is used.

Examples from the inspected catalog:

| Models | Package / protocol |
| --- | --- |
| Muse Spark, GPT | `@ai-sdk/openai` / Responses |
| MiMo, Big Pickle, Nemotron | `@ai-sdk/openai-compatible` / Chat Completions |
| Claude, Qwen 3.8 Flash | `@ai-sdk/anthropic` / Messages |
| Gemini | `@ai-sdk/google` / Gemini |
| Qwen 3.8 Max | `@ai-sdk/openai-compatible` / Chat Completions |

This is a text-chat adapter, not the complete OpenCode agent runtime. It uses
provider-default reasoning, has no executable tools in direct chat, caps output
at 8192 tokens or the model's smaller declared limit, and disables Responses
storage. OpenCode's tool replay, OAuth plugins, agent transforms and full
reasoning-variant UI are not imported into the API. Execution continues to use
the full runtime outside this resource-constrained API.

## Authentication and errors

OpenCode's provider loader prefers a configured credential. Only when none is
configured does it use `public` for zero-input-cost models. Orlynx follows this
precedence, reading/decrypting credentials server-side for each generation.
Client caches are bounded and scoped by user, credential fingerprint, endpoint,
package and model, so credential rotation selects a new client.

HTTP 403 on a public request is not presented as paid quota or an expired saved
credential. Error events retain numeric upstream status, not arbitrary provider
response bodies, request text or credential values. HTTP 429 means rate limiting;
only a saved-credential HTTP 401 asks the user to reconnect.

## Conversation, latency and resource behavior

Each queued run receives its originating message ID and prompt. Later queued
user messages cannot replace the current request. History is bounded. Greetings
and general questions bypass repository reads. Repository-aware questions use
up to three explicitly named text files, or limited README/package context, cached for 60 seconds, scoped by user,
installation, repository and branch; the cache holds at most 32 entries.

The actual SDK event stream feeds existing batched message deltas. No response
is buffered completely and then animated. The existing task snapshot heartbeat
persists partial text; closing the browser detaches SSE only. Stale runs after process death retain their partial text and terminate with an interruption message instead of silently replaying an upstream request. Explicit Cancel
aborts the provider request after marking the durable task cancelled. Request
failure and abort are not successful completions.

Timing logs contain history/context/provider initialization, model request,
first token and total durations. They contain session/run/model identifiers,
RSS before/after and process CPU time, not prompts or keys. Process CPU is shared
with other requests; before/after RSS is not peak RAM. Use Render metrics during
real concurrent chat to verify resource peaks and restarts. Do not claim a RAM
or latency target based only on unit tests.

## Verification and remaining production gate

Run typecheck, tests, build and the compiled-runtime import check. Provider tests
use real SDK packages with deterministic HTTP/SSE fixtures: they verify early
deltas, cancellation, public rejection classification and saved credentials.
These fixtures do not prove live model availability.

Before release, verify Render's current build command and deployed SHA, then
health, frontend, catalog, AI overview, session retrieval, SSE, authenticated
Hello on multiple free models, reload and cancellation, followed by memory/CPU
and restart metrics. Test account-backed models only if the account has access.
Render workspace selection and a signed-in Orlynx session are required for the
corresponding private production checks. CI and production evidence must be
recorded separately; until those gates pass this remains a draft repair.

Inspected upstream sources:
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/request.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/models-dev.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/auth/index.ts
- https://github.com/anomalyco/models.dev/tree/dev/providers/opencode
- https://opencode.ai/docs/zen/

The bundled models.dev metadata is distributed under [its MIT license](models-dev-LICENSE.txt).
