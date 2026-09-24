# Model switching

## Discovery

Models are never hardcoded. `GET /v1/ai/models` normalizes the live OpenCode
`/provider` catalog into `{ id: provider/model, providerId, providerName,
displayName, family, connected, status }` using only metadata the engine
actually returns. Providers that expose no model list surface a single
`default` entry so they can be connected — no model names are invented.

## Selection

The composer exposes `MODEL ▾ MODE ▾ ACCESS ▾`. The model dropdown merges every
available model across all connected providers (searchable in the Connect AI
sheet), so users never pick provider-then-model.

## Persistence

Priority: task override → session prefs → project defaults → global defaults
(`ORLYNX_DEFAULT_MODEL/MODE/PERMISSION`).

- Session: `PUT /v1/ai/session/:id` → `store.db.aiSessions` (server-side, so all
  devices see the same selection).
- Project: `PUT /v1/ai/project-defaults` → `store.db.aiProjectDefaults`.

Switching never creates a project, destroys conversation, or drops
attachments/history — the next turn simply uses the new model. If a run is
active, the change is saved and marked `appliesTo: 'next-turn'`; the active run
is never silently interrupted. If the selected model becomes unavailable
(disconnect/expire), status becomes `needs_attention` with “choose another
model”, preserving draft and attachments.
