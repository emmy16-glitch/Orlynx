# Production architecture

Render is the Orlynx control plane. Postgres is production truth. Mutable repository execution is supplied by a workspace provider behind one Orlynx-owned contract.

The preferred execution provider is the Orlynx warm runner when configured. GitHub Codespaces remains a supported fallback and recovery provider.

## Topology

~~~text
Browser / PWA
    |
    | HTTPS + SSE
    v
Render Web/API
    |
    +-- authentication
    +-- GitHub App integration
    +-- direct Ask / Plan model lane
    +-- durable task admission
    +-- same-run continuation + explicit queue
    +-- harness / verification / reflection
    +-- verified lesson memory
    +-- event persistence / redaction / replay
    +-- changes / approvals / controlled publication
    +-- authenticated bridge gateway
    |
    +---------------------> Postgres
    |
    v
WorkspaceProvider
    |
    +-- Orlynx Runner (preferred)
    |      +-- isolated prebuilt workspace
    |      +-- Orlynx bridge
    |      +-- OpenCode adapter runtime
    |
    +-- GitHub Codespaces (fallback/recovery)
           +-- Orlynx bridge
           +-- OpenCode adapter runtime
~~~

## Control-plane boundary

The Render control plane owns user/session identity, GitHub authorization, direct model chat, task admission, queue ordering, continuation/steering, execution harness, verification criteria, reflection orchestration, verified memory, workspace orchestration, normalized events, SSE replay, encrypted provider credentials, approvals, change sets, publication policy/receipts and audit.

Repository code execution does not run inside the Render web process.

## Execution providers

The workspace-provider boundary keeps compute replaceable.

### Orlynx Runner

Preferred when configured and healthy.

It provides a prebuilt runtime image, one isolated workspace per active environment, background prewarming, preinstalled bridge/runtime dependencies, low-latency reuse, bounded capacity/idle reclamation and a signed browser Preview gateway.

### GitHub Codespaces

Codespaces remain a supported fallback/recovery path and use the same bridge/task/event contracts.

Fallback should preserve session ID, task identity, user history and queue order. The browser should not need a different product workflow because compute changed.

## Direct versus workspace execution

Ask/Plan work can use the direct lane when mutable project execution is unnecessary.

Build work uses a real workspace provider and the authenticated bridge.

Both lanes persist under the same durable project conversation.

## Durable task model

A user message that needs a run is stored before execution.

Natural follow-ups can stay attached to the active run. Explicit next-task intent creates a separate queued task.

The queue is sequential: queued work is not promoted while another task is running, waiting for input or waiting for approval.

## Harness and verification

The harness converts user intent into observable acceptance requirements.

Examples include changes, tests, build, commit, publish, deployment, Preview and browser research.

Missing evidence keeps the task in work/verification rather than allowing optimistic completion.

## Reflection and learning

Unexpected or contradictory observations can trigger a bounded Investigation loop between Orlynx and the connected model.

A learned lesson is only persisted after reflection occurred, verification passed and a usable verified resolution exists.

Lessons remain user-isolated and relevance-gated.

See [learning-and-memory.md](learning-and-memory.md).

## Realtime and durability

Postgres is authoritative for product state.

The authenticated bridge WebSocket is the normal low-latency workspace transport. Commands are persisted before direct socket delivery so recovery can survive reconnects and process boundaries.

Browser activity uses SSE with stable event IDs and monotonically increasing session sequence.

Recovery is authoritative snapshot plus ordered events after the last cursor.

## Event security

Secret-like values are sanitized before event persistence and streaming.

Historical events are sanitized again before replay/reflection.

This is defense in depth; credentials should still be kept out of repository/model-visible output.

## Preview

Preview has a provider-aware verification path.

Orlynx distinguishes a browser-renderable Preview from an API-only HTTP port.

For Codespaces, Orlynx manages the required cloud-preview environment for supported dev servers such as Vite and diagnoses forwarding before editing repository config.

For warm runners, signed Preview routing connects the browser to the isolated workspace.

## GitHub publication

The agent runtime does not receive unrestricted GitHub credentials.

Publication is executed through Orlynx-controlled paths.

Rules include preserving exact branch intent, refusing to guess ambiguous targets, requiring explicit publication intent, enforcing policy, rejecting unsafe Git state and persisting audit evidence.

Default-branch publication may occur only when explicit intent and server-side policy authorize that controlled path.

## Security

Production boundaries include GitHub App authorization rather than PAT entry, short-lived installation tokens, signed callback state, HMAC webhook verification, encrypted persisted provider credentials, short-lived bridge credentials, user-isolated learned lessons, event/history sanitization, server-side permissions, per-workspace execution isolation and audit for consequential actions.

A production runner must not execute unrelated repositories in one shared shell process.

## Deployment truth

Render is the active production control plane.

Vercel is not part of the production runtime topology and should not be reintroduced into current architecture documentation or deployment instructions.

See [render-production.md](render-production.md), [warm-runner-architecture.md](warm-runner-architecture.md), [architecture-overview.md](architecture-overview.md) and [end-to-end-verification.md](end-to-end-verification.md).
