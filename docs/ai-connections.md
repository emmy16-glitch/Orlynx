# Orlynx AI connections

Users experience one product: Orlynx AI.

Internally, Orlynx separates three concepts:

- **Agent adapter** — the coding-agent runtime contract. OpenCode is Adapter #1.
- **Provider connection** — credentials/access for a model provider or OpenCode account path.
- **Model** — the specific model selected for a turn.

These concepts are deliberately independent.

## Direct chat versus workspace agent

Ask/Plan requests that do not require mutable execution can use Orlynx direct chat through the control plane.

Build execution uses the selected agent adapter inside the workspace.

A direct-model failure does not mean the workspace is dead.
An OpenCode adapter failure does not mean Git/files/terminal are dead.

## Provider credentials

Hosted production stores provider connection records server-side and encrypts persisted credentials.

Credentials are never returned to the browser in raw form.

The workspace receives only the credentials needed for its selected runtime path.

## Free/public OpenCode models

For catalog-marked free/public OpenCode routes, Orlynx keeps public access separate from saved account authentication.

A stale account key must not turn a free-model availability problem into a misleading “reconnect paid account” error.

## Model selection

Model selection is persisted per durable session.

Changing the model during active work must not silently mutate an already-admitted task. The admitted task keeps its snapshot; the new selection applies to later work according to session/task rules.

## Agent readiness

Agent adapter status can be:

- starting;
- ready;
- busy;
- unavailable;
- failed.

Adapter readiness is separate from workspace readiness.

## OpenCode runtime repair

When the bridge cannot run the configured OpenCode binary, it now attempts automatic repair before surfacing binary_unavailable:

1. configured binary;
2. known runner path;
3. known user/private runtime locations;
4. already-installed native packages;
5. pinned native package self-heal install;
6. version probe;
7. OpenCode server startup.

A genuine package/network/runtime incompatibility can still leave the adapter unavailable, but the development workspace remains independently usable.

## Errors

Error copy should describe the failed capability accurately.

Examples:

- model unavailable;
- provider authentication needs attention;
- OpenCode runtime unavailable;
- workspace connection interrupted.

Do not collapse them all into one generic AI failure.

## Security

Provider credentials, OpenCode server passwords and bridge credentials are server/workspace secrets.

They must not appear in browser payloads, event history, learned lessons or ordinary logs.
