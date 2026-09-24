# Orlynx AI connections

Users experience one thing — **Orlynx AI**. Underneath, Orlynx separates three
concepts that are never merged in code even though they merge in the UI:

- **Engine** — OpenCode server. Executes tasks, tools, file edits, shell.
- **Provider connection** — OpenAI, Anthropic, Gemini, OpenRouter, … Authenticates
  the engine and determines which models exist.
- **Model** — a selectable resource (`provider/model`) used for the next turn.

## Connecting

In-project **Connect AI** sheet (`ProductionApp.tsx → ConnectAiSheet`) lists
providers in three honest states from `GET /v1/ai/providers`:

- `connected` — the engine reports the provider connected.
- `key-stored` — Orlynx holds a key server-side but the engine does not report
  the provider yet (needs attention, never shown as ready).
- `not-connected`.

API-key connect (`POST /v1/ai/providers/connect-key`) validates the key shape,
writes it to `data/ai-secrets.json` (mode `0600`), and re-reads engine state.
Keys are never logged, never returned (only a masked `…last4`), never stored in
localStorage, never bundled into the client.

Disconnect (`POST /v1/ai/providers/:id/disconnect`) deletes the server-side
credential. Conversations, attachments and history are preserved. If the active
model belonged to that provider, AI status becomes `needs_attention` and the UI
asks the user to choose another model — it never silently switches.

## Health

`GET /v1/ai/status` returns one unified state (`disconnected | ready |
working | needs_attention | error`). Ready requires: engine reachable **and**
at least one available model. Stored keys alone are never proof of health.
