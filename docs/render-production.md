# Render production

Render is the primary Orlynx control plane.

A persistent Node service serves the built frontend, Express API, direct AI chat, session SSE streams and the authenticated /bridge WebSocket gateway.

Mutable repository execution does not run inside the Render web process.

The preferred execution provider is the Orlynx warm runner when configured; GitHub Codespaces remains the supported fallback/recovery provider.

## Service

Repository: emmy16-glitch/Orlynx  
Branch: main  
Runtime: Node.js 24  
Build: npm run render:build  
Start: PATH="$PWD/.render-bin:$PATH" npm run start --workspace=@orlynx/api

scripts/render-build.sh builds every workspace and prepares the production artifact.

## Public origin

Use the canonical Render HTTPS origin:

~~~text
ORLYNX_PUBLIC_URL=https://orlynx.onrender.com
ORLYNX_HOSTED_PRODUCTION=1
~~~

Do not configure a Vercel origin as production Orlynx.

Same-origin checks, GitHub callbacks, bridge URLs and product links depend on the canonical Render origin.

## Durable storage

Production requires Postgres through DATABASE_URL or POSTGRES_URL.

Hosted production must not treat process memory, local JSON files or browser localStorage as authoritative product state.

Durable state includes sessions, messages, tasks, events, workspaces, bridge commands, approvals, audit data, agent/runtime state and verified lessons.

## Core secrets

Production requires the relevant values documented in .env.example, including durable database configuration, credential-encryption secret, bridge signing secret, session secret and GitHub App credentials.

Never log secret values.

## GitHub App URLs

Production GitHub App URLs must use the Render origin:

~~~text
Homepage:  https://orlynx.onrender.com
Callback:  https://orlynx.onrender.com/v1/github/setup
Setup URL: https://orlynx.onrender.com/v1/github/setup
Webhook:   https://orlynx.onrender.com/v1/github/webhook
~~~

Repository-selection updates should return to the same Orlynx setup route.

## Workspace-provider configuration

When the warm runner is available, the normal provider configuration is:

~~~text
ORLYNX_WORKSPACE_PROVIDER=auto
ORLYNX_RUNNER_URL=https://<runner-host>
ORLYNX_RUNNER_TOKEN=<independent secret>
ORLYNX_PREWARM_WORKSPACES=1
~~~

The Render web service does not need Docker privileges.

It talks to the runner manager over authenticated HTTPS.

GitHub Codespaces remains the fallback/recovery provider when policy and user authorization allow it.

See [warm-runner-architecture.md](warm-runner-architecture.md).

## Durable orchestration

Workspace lifecycle work is persisted before execution.

The production supervisor can run the API and durable orchestration worker from the same deployed artifact. The worker claims persisted workspace jobs with leases and retries transient failures.

The key rule is that HTTP request lifetime must not own long-running workspace preparation.

A restart or client disconnect must not erase admitted workspace work.

## Durable chat execution

~~~text
user message
    ↓
durable message
    ↓
durable task + harness checkpoint
    ↓
same-run continuation OR explicit queued task
    ↓
direct model lane OR workspace lane
    ↓
durable normalized events
    ↓
verification / Investigation if needed
    ↓
final durable assistant result
    ↓
promote next queued task
~~~

Queued work is never promoted while another task is running, waiting for user input or waiting for approval.

## Follow-ups

Natural follow-up messages during active work remain attached to the same run.

Before finalizing, the API re-reads durable task state. If a late follow-up arrived during verification/final synthesis, the task is continued under the same run identity rather than silently completing and losing that message.

This finalization boundary is regression-tested.

## Streaming

Browser activity uses SSE.

Workspace execution uses the authenticated bridge WebSocket.

Normalized events are persisted, secret-like payload values are sanitized, live in-process broadcast provides low latency and durable sequence replay repairs gaps.

## Investigation stream

Reflection/diagnosis events are grouped by reflection identity into ordered Investigation sections in the UI.

An Investigation can show the Orlynx observation, the connected model hypothesis/next check and the resulting evidence.

Private hidden chain-of-thought is not rendered.

## Preview

Preview diagnosis is provider-first.

Before modifying project configuration, Orlynx verifies process/listener, browser suitability, provider forwarding and browser-resolvable URL.

API-only JSON roots are rejected as Preview.

Codespaces Vite compatibility is supplied globally by the workspace environment where supported so repositories should not repeatedly need bespoke host config changes.

## Post-deploy verification

A release should not be treated as healthy until the relevant checks pass.

### Build/revision

1. GitHub Actions verification passes for the exact commit.
2. Render reports the same revision live.
3. Startup completes without fatal configuration/runtime errors.
4. /health reports expected durable dependencies.

### GitHub

5. GitHub connection/install callback returns to the Render origin.
6. Authorized repositories remain installation-scoped.
7. Publication preserves requested branch and returns a receipt.

### Direct conversation

8. Ask/Plan streams from a selected working model.
9. A follow-up sent while output is streaming continues the same run.
10. Cancellation interrupts the provider request without reporting success.

### Workspace

11. Warm runner reaches bridge-ready when configured.
12. If runner preparation fails and fallback is allowed, Codespaces can recover the durable task.
13. Agent-adapter readiness remains separate from bridge/workspace readiness.

### Queue

14. “Also check this” continues the active run.
15. “Queue this / do this next” creates a visible queued task.
16. queued work is editable/cancellable.
17. queued work does not run beside active/waiting work.
18. the next task starts only after the active run reaches a terminal state.

### Investigation / verification

19. Missing acceptance evidence prevents premature completion.
20. Investigation blocks appear in order when reflection is required.
21. the final result reflects the newest same-run user update.

### Streaming / mobile

22. Reload/reconnect replays events without duplicates.
23. scrolling upward stops auto-follow.
24. returning to the latest content resumes normal follow behavior.

### Security

25. secret-like values are absent from streamed/durable event payloads.
26. historical replay remains sanitized.
27. learned lessons remain user-scoped.

## Production evidence

Keep CI evidence and live-production evidence separate.

Passing unit tests does not prove a live model provider is available, GitHub permissions are correct, Render deployed the intended SHA, a runner host is reachable or Codespaces authorization is healthy.

Production claims should always be tied to the exact deployed revision.
