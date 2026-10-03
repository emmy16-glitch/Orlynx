# Orlynx-owned agent execution

Orlynx owns tasks, conversation history, repository/workspace identity,
Investigation, evidence, verification, memory, publication and deployment
receipts. Agent sessions are disposable execution handles. OpenCode remains the
default; mini-SWE and Cline execute actual upstream runtimes in the same workspace.

## Contract and routing

`agent-runtime.ts` is the production adapter contract. Workspace payloads carry
Orlynx IDs, objective, system constraints, model selection, permission, execution
generation and an observable handoff. Native session methods are optional;
portable adapters do not fabricate OpenCode sessions. Capability requirements,
health freshness, configured model availability and durable circuit state filter
routing. `Auto` is a controller preference, not a fourth runtime. Model selection
is independent of adapter selection. Same-model routes take priority. A fallback to a different model requires catalog evidence of zero prompt/completion pricing and is announced in the stream. Set `ORLYNX_ALLOW_FREE_MODEL_FAILOVER=0` for strict model pinning. No automatic paid-model substitution occurs.
An unavailable or incompatible manual choice returns a clear error.

`adapter-policy.ts` classifies provider, runtime, stream, workspace, command,
permission and verification failures. Attempts are bounded; previously attempted
adapters are excluded from automatic switching. Two failed runs open a two-minute
circuit. A successful execution closes it. Application probes remain necessary
before traffic returns after cooldown.

## Switching and recovery

`agent-handoff.ts` persists transition intent before cancellation. A PostgreSQL
workspace lease allocates monotonically increasing execution generations. The
bridge execution journal independently refuses simultaneous/stale writers.
Cancellation waits for the prior execution and registered command groups; unresolved
writers or user terminals block takeover. Repository HEAD, branch, dirty files,
public evidence, pending work and Investigation are checkpointed. The same task,
run, conversation and workspace are requeued. Old events/results and stale
whole-task writes cannot overwrite the next generation.

A stopped direct response can move into its existing prepared workspace. Direct
transport cancellation must acknowledge first. A workspace must be ready, owned
by the session, and have a compatible model/adapter configured. A cold direct
conversation without that workspace receives an explicit availability error.

The existing Compute Broker still owns compute provider recovery. Missing live
task heartbeats now attempt bounded reconciled same-task recovery or a compatible
adapter. API restarts reload PostgreSQL checkpoints. A bridge restart with an
unfinished local execution journal blocks automatically: process death alone is
not proof that detached commands stopped. This intentionally preserves edits
rather than replaying uncertain side effects. Full automatic orphan-process
reconciliation remains incomplete (see status document).

## Actual runtime integrations

mini-SWE uses pinned `mini-swe-agent==2.4.6` `DefaultAgent` and `LitellmModel`.
Its custom Environment requests commands over stdio; Orlynx runs them. No
trajectory is persisted as durable task state. Cline uses pinned
`@cline/agents@0.0.90` headless SDK with an Orlynx command tool; it does not run
OpenCode or require VS Code. No VS Code extension state is transferred.
Both use tool-compatible configurable endpoints. Local unauthenticated endpoints
are supported; authenticated endpoints receive optional adapter-specific keys.
The adapter executes the explicitly selected or visibly routed model; it never substitutes a model privately. OpenRouter readiness
requires a valid key plus the requested model in the model catalog. Listing a
public catalog alone does not establish readiness.

Set `ORLYNX_MINI_SWE_API_BASE`, `ORLYNX_MINI_SWE_MODEL`,
`ORLYNX_MINI_SWE_API_KEY`, and corresponding `ORLYNX_CLINE_*` variables on runner
services. For OpenRouter the Orlynx model ID includes the provider prefix:
`openrouter/poolside/laguna-s-2.1:free`. The SDK receives the model part.
One `ORLYNX_OPENROUTER_API_KEY` can serve both adapters and the workspace OpenCode provider; adapter-specific keys override it. The shared key is used only for OpenRouter endpoints. Never put provider keys in a prompt, repository or public checkpoint.
Native runners can install Python runtime asynchronously at startup with
`ORLYNX_INSTALL_MINI_SWE=1`; failure leaves OpenCode available. Docker includes
mini-SWE by default (`INSTALL_MINI_SWE=false` opts out). Native Python 3/venv
availability remains a deployment prerequisite. Cline is shipped by npm lockfile.

## Roles and security

Architect/executor/reviewer roles use isolated runtime contexts. Optional
`ORLYNX_ARCHITECT_ADAPTER` and `ORLYNX_REVIEWER_ADAPTER` choose compatible healthy
engines. Reviewer findings are challenges; the controller still requires current
verification. Portable read-only roles use direct argument-vector execution,
without shell expansion, write programs, outside paths, symlink traversal or
Git plugin hooks. Full executor commands have stripped credential environments;
adapters receive no GitHub publication credentials. Shell publication is denied.
Authenticated GitHub publication remains in the existing control plane.

The native bridge and tool processes currently share an OS account. Environment
stripping and command policy are not a complete hostile-code sandbox: arbitrary
write-capable code may inspect same-user processes or host files. Stronger OS
separation and egress enforcement are still required before claiming resistance
to a malicious executor. Neither adapter gets database access through its
contract, and all bridge frames remain authenticated/scoped to their workspace.

## Verification, knowledge and learning

Workspace results carry file bytes, hashes, adapter/task/generation and timestamp
provenance. An immutable task base commit preserves changes across local commits
and handoffs. Current workspace content fingerprints bind test/command evidence;
old-generation or pre-edit successful tests cannot verify the new state. Only
control-plane publication receipts satisfy publication requirements.

Verified scoped knowledge edges contain subject/predicate/object, supporting
commit/files/task/evidence, confidence and verification times. Initial facts
include lesson relations and package manifest dependency edges. Retrieval
rechecks referenced files against the supporting commit and current dirty state;
changed/deleted references stale the affected facts and repository lessons.
Unknown provenance is excluded. Existing confidence decay, contradictions and
supersession remain in effect. This is a bounded project knowledge system, not a
complete symbol graph. Dependency relationships (`depends_on`, `uses`, `calls`) propagate staleness through scoped edges.

Postdeploy observation is optional (`ORLYNX_POST_DEPLOY_HEALTH_URLS`, window
30 seconds–10 minutes). A durable claimed observation samples HTTPS health and
Render exact-commit identity. Learning requires healthy matching observations.
Replay is idempotent by deployment commit; regressions stale deployment lessons.
It does not yet inspect application log error rates or runtime resource metrics.

## Validation and migration

Existing PostgreSQL schema initialization adds tables/JSON metadata without
renaming task, session, event or memory identities. Existing rows default to
OpenCode and generation zero; legacy knowledge lacking provenance is excluded
when a workspace can revalidate it. Roll out all runners and controller together
before selecting portable adapters. Old runner bridges do not implement the new
reconciliation command; do not select new adapters on stale builds.

Run `npm run typecheck`, `npm test`, `npm run build`. Set
`ORLYNX_MINI_SWE_PYTHON` to the pinned Python executable to run the actual mini
integration test; CI installs it. `node scripts/evaluate-adapters.mjs report.json`
measures deterministic real-engine execution, PostgreSQL switching/recovery,
routing and learning gates without provider billing. It is not a comparative
coding-quality benchmark. Existing Chromium/container smoke remains required.
