# Orlynx system integration

Orlynx is a phone-first control plane over real GitHub repositories, durable project conversations, replaceable compute providers and real coding-agent runtimes.

Production does not fall back to a demo agent or simulated cloud state.

## Product flow

1. The user connects GitHub through the Orlynx GitHub App.
2. Orlynx lists only repositories authorized for that installation.
3. Opening a repository creates or restores an identity-owned durable project session.
4. Chat is the primary workspace.
5. Ask/Plan can use the direct model lane without starting mutable compute.
6. Build work is durably admitted before execution.
7. Orlynx prefers the configured warm runner and can use GitHub Codespaces as fallback/recovery.
8. The authenticated Orlynx bridge connects the selected workspace to the control plane.
9. The selected coding-agent adapter runs inside that workspace. OpenCode is Adapter #1.
10. User follow-ups normally continue the same active run; explicit “queue/next/after this” wording creates separate queued work.
11. Runtime events are normalized, redacted and persisted before browser replay.
12. The harness verifies the requested outcome.
13. If evidence conflicts with expectations, Orlynx and the connected model iterate through bounded Investigation rounds.
14. The user reviews files, changes, tests, Preview and publication evidence.
15. GitHub publication occurs only through the controlled Orlynx publication path.
16. A verified post-reflection resolution may become a user-scoped learned lesson for future relevant work.

## Control plane

The Render/API control plane owns:

- GitHub App installation and OAuth handoff;
- repository authorization;
- durable users/projects/sessions/messages/tasks/events;
- same-run continuation and explicit queueing;
- model/mode/permission/agent preferences;
- harness checkpoints and verification;
- reflection/investigation orchestration;
- verified memory;
- encrypted provider credentials;
- workspace lifecycle orchestration;
- approvals and audit;
- change sets;
- controlled GitHub publication.

When DATABASE_URL or POSTGRES_URL is configured, Postgres is authoritative.

Local JSON storage exists only for local development/tests and is not production truth.

## Direct execution lane

Ask/Plan work that does not require project mutation can execute directly in the control plane through the selected model provider.

This avoids starting compute merely to answer a question.

The direct lane still participates in durable messages, run identity, live streaming, same-run continuation, cancellation and durable final output.

## Workspace execution plane

Build execution runs outside the Render web process.

The workspace provider owns the mutable checkout, filesystem, PTY/shell, test/build execution, Git state, Preview ports and coding-agent runtime.

Supported providers are:

- **Orlynx Runner** — preferred when configured;
- **GitHub Codespaces** — fallback/recovery.

Both use the same Orlynx bridge contract.

## Bridge

The bridge initiates an authenticated outbound WebSocket connection to Orlynx using a short-lived scoped credential.

It provides the execution operations Orlynx needs while keeping control-plane credentials out of the model shell.

Commands are persisted before the low-latency socket dispatch path, so reconnect/restart recovery remains possible.

## Agent abstraction

OpenCode is the first production coding-agent adapter.

Orlynx orchestration depends on an adapter boundary so future real runtimes can implement the same session/event/task contracts without changing the product architecture.

An adapter failure does not redefine workspace health. Shell/files/Git/Preview may remain usable while one agent runtime is unavailable.

## Conversation continuity

Natural follow-ups such as “also check this” or “finish it” stay attached to the active run while steering remains open.

Clear next-task intent creates queued work.

Queued work is durable, ordered, visible, editable/cancellable before start, and sequential.

A queued task does not start while another task is running, waiting for input or waiting for approval.

## Verification and Investigation

Orlynx infers evidence requirements from the user's request.

Examples include changes, tests, build, Preview, commit, publication, deployment and browser research.

When evidence is missing, Orlynx should continue or report the exact unresolved boundary.

When evidence contradicts expectations, the Investigation loop records:

- Orlynx observation;
- model hypothesis/next check;
- actual tool evidence;
- correction/verification.

Private hidden chain-of-thought is not part of this integration contract.

## Learning

Orlynx learning is a verified memory layer, not model retraining.

A lesson can be persisted only after reflection occurred and the harness later verified the outcome.

Lessons remain user-isolated and relevance-gated.

See [learning-and-memory.md](learning-and-memory.md).

## GitHub security

- GitHub App only; no PAT user flow.
- Installation tokens are short-lived and server-side.
- Repository authorization is revalidated.
- User-scoped authorization is used for provider operations that require it.
- Webhooks require X-Hub-Signature-256.
- Delivery IDs are persisted durably for idempotency.
- Deleting/suspending an installation invalidates active repository capability.
- Agent shells do not receive unrestricted GitHub credentials.
- Explicit publication target is never silently remapped.

## Production guarantees

Production should fail closed for authorization/security failures and fail recoverably for infrastructure failures.

Examples:

- lost browser → work remains durable;
- SSE disconnect → replay from sequence;
- runner failure → Codespaces fallback when allowed;
- agent failure → preserve other workspace capabilities;
- ambiguous branch → investigate/clarify rather than guess;
- missing verification evidence → do not claim success.

See [architecture-overview.md](architecture-overview.md) for the full architecture.
