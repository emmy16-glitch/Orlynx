# Render production

## Role

Render is the active Orlynx production control plane.

The main service runs the API and durable workspace orchestrator under `apps/api/scripts/production-start.mjs`.

Postgres is production truth.

Vercel is not part of the active runtime architecture.

## Main service responsibilities

The primary Render service hosts:

- HTTP API and web app
- SSE event stream
- Bridge WebSocket gateway
- GitHub App integration
- task admission / queue / harness
- direct OpenCode routing
- Compute Broker
- workspace orchestration
- controlled publication / audit

The production supervisor starts the API and, when durable storage exists, the orchestrator worker.

## Direct OpenCode runtime

The lightweight direct runtime supports fast conversational Ask/Plan.

It is not a hard dependency. Bounded health probing plus broker quarantine/failover prevents a transient direct-runtime outage from becoming a required user resend.

## Current runner pool

Production currently has five direct Render runner services using `runner-direct/index.mjs`.

The main control plane sees them as one pool through configured runner hosts and shared internal runner authentication.

Each current direct runner exposes one workspace slot.

## Runner credential rollout

All runner services and the control plane must share `ORLYNX_RUNNER_TOKEN`.

Rotation requires synchronized rollout. Secret values must never appear in logs/docs/browser responses.

## E2B and Codespaces

E2B is an independent configured workspace provider.

GitHub Codespaces remains a supported provider through GitHub App authorization.

The Compute Broker selects among configured providers rather than relying on one static fallback order.

## Deployment

The main Orlynx service deploys from `main`.

Runner services may use controlled/rolling deployment so the whole pool is not taken down together.

A merged GitHub commit is not enough to claim production success; verify the live Render deploy/commit.

## Startup smoke

Production startup should expose evidence for:

- API listening
- orchestrator started
- model catalog
- GitHub App permissions
- E2B health
- runner-pool health/capacity
- direct-runtime warm state

A direct-runtime failure does not imply Orlynx is unavailable if broker alternatives remain healthy.

## Application health vs Render status

A Render deployment marked `live` proves the service process deployed. It does not prove Orlynx capability health.

Use application-level evidence:

- runner `/health`
- broker startup smoke
- GitHub permission checks
- E2B health
- model catalog smoke
- direct-runtime probe

## Docker path

The repository also contains Docker runner-runtime and runner-manager images for Docker-capable infrastructure.

CI builds both and launches Chromium inside the runner-runtime image.

See [runner-runtime-and-docker.md](runner-runtime-and-docker.md).

## Post-deploy checklist

After a meaningful architecture deploy, verify:

1. deployed commit matches intended `main`
2. API/orchestrator started
3. GitHub App permissions are healthy
4. model catalog responds
5. E2B health is correct when configured
6. runner pool reports usable capacity
7. direct runtime health is known
8. durable task/replay paths show no startup errors
9. no secret values appear in logs
10. provider failure degrades through broker rather than losing task identity

## Production principle

Render hosts the control plane. Compute providers are replaceable underneath it.

## Recovery hardening, 2026-09-30

The 2026-09-30 reliability audit records public application health separately from Render service/deploy/log evidence. A public health response does not verify the deployed commit, all runner capacities, E2B authorization or authenticated user-task recovery. See [the audit](reliability-audit-2026-09-30.md).
