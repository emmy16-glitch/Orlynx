# Production architecture

## Summary

Render is the active Orlynx control plane. Postgres is production truth.

The current production architecture has:

- Render API/control plane;
- durable workspace orchestrator;
- Postgres;
- direct OpenCode conversational runtime;
- adaptive Compute Broker;
- five direct Render runner hosts;
- E2B workspace provider;
- GitHub Codespaces provider;
- authenticated workspace bridge;
- OpenCode Agent Adapter #1.

Vercel is not part of the active production runtime.

## Topology

~~~text
Browser / PWA
    |
    | HTTPS + SSE
    v
Render Orlynx control plane
    |
    +-- auth + GitHub App
    +-- durable messages/tasks/queue
    +-- direct Ask/Plan runtime
    +-- Compute Broker
    +-- harness/verification
    +-- event replay/redaction
    +-- controlled publication
    +-- bridge gateway
    |
    +-----------------------> Postgres
    |
    +-- direct-runtime health
    |
    v
Workspace execution
    |
    +-- Orlynx runner pool (5 direct Render services)
    +-- E2B
    +-- GitHub Codespaces
    |
    v
Orlynx workspace bridge
    |
    +-- fs / PTY / Git
    +-- tests / build
    +-- ports / Preview
    +-- browser evidence where supported
    +-- OpenCode adapter
~~~

## Control-plane boundary

The control plane owns identity, authorization, session/task state, queue semantics, compute selection, harness, verification, memory, events, credentials, approvals, publication, and audit.

Repository code executes outside the control-plane process.

## API and orchestrator processes

The production supervisor launches:

- `dist/index.js` for API/websocket/SSE/control-plane HTTP;
- `dist/orchestrator-worker.js` when durable Postgres storage exists.

Workspace jobs are durable and leased, so the worker can restart without forgetting accepted Build work.

## Compute Broker

Workspace selection is no longer a static “runner then Codespaces” rule.

The broker ranks configured compute using health/history/capability.

Workspace providers:

- `orlynx-runner`;
- `e2b`;
- `github-codespaces`.

The direct runtime is health-tracked as an additional fast path.

A healthy existing workspace stays sticky where possible.

See [compute-broker.md](compute-broker.md).

## Current direct runner pool

Production is configured with five direct Render runner services.

Each direct runner currently supplies one workspace slot.

The control plane authenticates to runners with an internal runner credential. Runner health is application-level and reports usable capacity/capability, not merely whether Render says the service deployed.

The broker consumes this health.

## Docker runner architecture

The repository also contains the scalable runner-manager/runtime model:

- runner manager controls Docker;
- runner runtime is a prebuilt development image;
- one container can represent one isolated workspace.

This path is CI-built and browser-smoke-tested but is distinct from the current five direct Render runner services.

See [runner-runtime-and-docker.md](runner-runtime-and-docker.md).

## Direct runtime

The direct OpenCode runtime serves lightweight conversational work.

It has bounded wake/recovery behavior.

If a confirmed transient runtime outage occurs before useful output, the broker can quarantine the direct path and promote the same durable turn to workspace execution.

This keeps direct runtime failure from becoming a mandatory user resend.

## Durable task model

A task is persisted before execution.

Natural follow-ups can steer the same active task. Explicit next-task intent creates a separate queued task.

Queue promotion respects running, waiting-input, and waiting-approval states.

Late follow-ups are protected during finalization through a steering-revision guard.

## Workspace freshness

Before Build execution, Orlynx validates workspace repository freshness.

A clean behind default branch can fast-forward.

A specific recovery exists for incidental `package-lock.json` drift: the patch is preserved under Orlynx recovery storage, the lockfile is restored, and the workspace can fast-forward. Real source changes or unsafe divergence remain blocking conditions.

## Bridge transport

The workspace bridge uses authenticated WebSocket transport.

Commands are durable before live delivery so a dropped socket does not become the only copy of an operation.

Connection credentials are scoped and rotated.

## Agent adapter readiness

Workspace health and OpenCode adapter health are separate.

A workspace can remain usable while OpenCode repairs/restarts.

## Realtime delivery

Browser activity uses SSE over canonical persisted events.

Refresh/reconnect uses the session event sequence to recover ordered state.

## Preview

Preview is provider-aware.

Direct runners use signed Preview proxying.

Codespaces uses forwarding.

Containerized runner-runtime images include Playwright/Chromium so browser capability can be advertised and verified.

## Security

Production boundaries include:

- GitHub App instead of PAT-entry workflow;
- server-side installation credentials;
- encrypted persisted provider credentials;
- scoped bridge credentials;
- shared internal runner authentication;
- repository-isolated workspaces;
- secret redaction before event persistence/stream;
- controlled publication;
- audit.

## Health and startup smoke

Production startup verifies or reports:

- model catalog;
- GitHub App permissions;
- E2B health;
- runner-pool health/capacity;
- direct-runtime warm status.

A direct-runtime failure does not imply total production failure if broker alternatives remain healthy.

## CI release gates

CI verifies:

- dependencies;
- supervisor syntax;
- typecheck;
- API tests;
- build;
- compiled provider runtime;
- runner runtime Docker build;
- Chromium launch inside runner image;
- runner manager image build.

## Deployment truth

A production claim should identify the deployed commit and live Render deploy, not only the latest GitHub commit.

For operational procedure see [render-production.md](render-production.md).

## Recovery hardening, 2026-09-30

Workspace recovery uses bounded job attempts, durable provider-attempt history, and generation-fenced terminal writes. Failed provider resources are retained in workspace_recovery_resources instead of being destroyed during broker fallback. This preserves recovery metadata; automatic transfer of uncommitted edits between providers is not implemented. See [the reliability audit](reliability-audit-2026-09-30.md).
