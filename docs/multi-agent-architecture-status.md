# Multi-agent architecture implementation status

Audit baseline: main `2b1751e40dfe604c4ba062f6350707b602da8d6e`.
This document distinguishes implemented/tested code from production proof.
The full specification is not yet complete; this release preserves safe blocking
where effect reconciliation cannot establish that takeover is safe.

| Feature | Status | Evidence / remaining work |
| --- | --- | --- |
| Orlynx task/conversation/Investigation ownership | COMPLETE | Existing durable identities preserved by PostgreSQL switch/reload tests |
| Generic AgentAdapter | COMPLETE | Capability/model/workspace payload contract; optional native sessions; all three consume one handoff |
| OpenCode adapter | COMPLETE | Existing runtime/recovery/publication regressions retained; primary/default adapter |
| mini-SWE runtime integration | COMPLETE | Actual pinned DefaultAgent/LiteLLM loop runs writes/tests/cancellation against deterministic endpoint |
| Cline runtime integration | COMPLETE | Actual pinned headless SDK runs host tools, writes/tests/cancellation; no VS Code dependency or OpenCode alias |
| New adapters in production | BLOCKED BY EXTERNAL REQUIREMENT | OpenRouter endpoint/free model configured; runner API keys and real authenticated execution need verification |
| Durable public handoff checkpoint | COMPLETE | Task/run/workspace/Investigation IDs, public evidence, changed files, pending updates, verification preserved |
| Manual switching | PARTIAL | Active workspace and stopped direct task identity tested; cold direct task needs prepared compatible workspace; browser production flow unverified |
| Automatic failover | PARTIAL | Compatible routing, bounded attempts, failure result and health/ghost-task paths; full production mid-write OpenCode→portable execution not verified |
| Adapter health/circuit registry | COMPLETE | Durable application probes, exact configured models, authentication, freshness, failure counts/cooldown; tests reject stale/circuit-open routes |
| Capability-aware routing / Auto | COMPLETE | Read/write/tool requirements and explicit same-model compatibility; manual errors instead of aliases |
| Workspace/task locking | PARTIAL | DB lease/generation, task-write fences and bridge singleton; orphan OpenCode tool process proof after restart incomplete |
| Durable event replay | COMPLETE | Existing canonical sequence/idempotency replay preserved; handoff/failure/provenance persisted |
| Crash/restart recovery | PARTIAL | Restart gate, transition-intent replay, late-write fencing and observation reclaim tested; uncertain restarted writer blocks |
| Crash-at-every-stage integration suite | PARTIAL | Real transition/crash/reconciliation boundaries tested; exhaustive fault injection through reviewer/publication/deployment remains missing |
| Architect / executor / reviewer roles | COMPLETE | Isolated contexts through selected compatible adapters; reviewer challenges remain evidence, not authority |
| Knowledge graph | PARTIAL | Scoped verified relation/package edges with provenance, retrieval revalidation; no complete code-symbol graph |
| Knowledge invalidation | PARTIAL | Changed/deleted referenced files stale lessons/edges; transitive dependency invalidation not implemented |
| Verified memory | COMPLETE | Verification-gated lessons, confidence/contradiction/decay foundations preserved; task/commit/file provenance and idempotent learning added |
| Production outcome learning | COMPLETE | Existing exact-commit deployment gate retained; durable observation learning replay idempotent by source commit |
| Postdeploy observation | PARTIAL | Optional bounded HTTPS health + Render identity window; application-log and runtime-metric feedback not implemented |
| Evaluation harness | PARTIAL | Deterministic real-engine and PostgreSQL suite reports time/results/skips without billing; no broad agent-quality benchmark |
| Streaming observability / selector | PARTIAL | Dynamic server agent metadata, generic model labels, visible transitions, existing stream/reconnect behavior preserved; production browser validation pending |
| File changes / evidence ledger | COMPLETE | Adapter/task/generation/time + content hashes and current-byte verification; task base commit preserves local committed work |
| GitHub publication authority | COMPLETE | Existing control-plane publisher retained; native shell push cannot satisfy verification |
| Permission / tenancy boundaries | PARTIAL | Scoped frame/task writes; stripped credentials; read-only argument vectors reject shell/host paths/hooks; full native hostile-code OS sandbox still missing |
| Runner packaging | PARTIAL | Pinned SDK lockfile, optional native Python install, Docker pinned mini-SWE; Python transitive dependency set not fully locked |
| Migration safety | COMPLETE | Additive tables/JSON fields; legacy defaults preserved; lease/reclaim/stale-holder tests |
| CI / exact production release proof | PARTIAL | Local checks recorded below; final CI/Render release evidence must be checked after publication |

Local verification: baseline 505 tests passed before edits. The deterministic
adapter evaluation passed 30 tests with no skips, using actual mini-SWE 2.4.6 and
Cline SDK 0.0.90 and a local scripted model endpoint. The full build and production
provider import smoke passed. The full final suite and container/CI outcomes are
reported in the final release record rather than inferred from these results.

Observed deployment baseline: four active runner services; original fifth
`srv-das677u0tbcc73e0f1ng` suspended. Production API baseline deploy
`dep-db05ln8ae00c73ea7k10` served exact baseline commit. Public API health was alive;
startup logs reported four healthy runners, direct-runtime readiness and GitHub
App readiness. These observations are not proof of new-adapter production runs.

See [architecture](multi-agent-architecture.md), [gap matrix](agent-architecture-gap-matrix.md),
real runtime tests, controller tests, existing memory/publication/recovery suites
and `scripts/evaluate-adapters.mjs`. No hidden/private model reasoning is used as
handoff state, durable evidence or a completion criterion.
