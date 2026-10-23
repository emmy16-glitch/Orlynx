# Streaming and execution performance upgrade — 2026-10-23

## Audited request path

`POST /v1/sessions/:id/messages` durably stores the user message, resolves the selected adapter/model and execution plane, then either starts direct OpenCode work or admits a workspace task. Workspace admission prefers a healthy session workspace; provisioning is deduplicated by `activePreparations`, and GitHub Codespaces can reuse an idle environment only for the same repository and branch. The bridge subscribes to OpenCode's native `/event` SSE endpoint before `prompt_async`, forwards text/tool/file/test events through the canonical protocol, and uses snapshot polling only as a recovery path.

The API commits each canonical event with its per-session sequence before notifying same-process SSE listeners. The browser restores recent durable activity, connects with `?after=<cursor>`, projects events into stable run/tool identities, and applies one React state update per animation-frame batch.

## Baseline findings

This change does not claim a production before/after latency comparison: the rehosted service does not expose authenticated provider, runner, or GitHub App credentials in this workspace. The baseline is therefore code-path evidence plus reproducible local measurements.

- PR #159 already removed session-refresh work from the SSE critical path and fixed the replay/subscription race. Its CI ran 623 tests: 622 passed and the live mini-SWE runtime test exceeded its 120-second external-runtime timeout.
- Same-process committed events were delivered immediately, but events from another API process were discovered on a fixed 5-second poll.
- The ordered SSE cursor accepted any larger sequence. Receiving sequence 12 before 11 advanced the cursor and could make 11 permanently invisible.
- `ServerResponse.write()` backpressure was ignored, allowing a slow browser to grow Node's response buffer without an application bound.
- Browser reconnect used a fixed schedule without jitter. A stale EventSource callback was not generation-fenced, although session changes did close the previous source.
- Existing direct-agent timing data was written to logs, but no bounded percentile snapshot existed.
- A local 100,000-event ordered-stream microbenchmark on the development container completed in 33.010 ms (3,029,385 events/second). This measures in-process projection only, not network, database, model, or production latency.

## Implemented architecture

- Replay and live notifications now share a contiguous cursor. Out-of-order events remain staged, trigger immediate durable catch-up, and are released only after the missing committed range arrives.
- SSE output has a 256 KiB default application buffer. A slow client that exceeds it is disconnected; EventSource reconnects from its last received durable ID, so durability is preserved without unbounded browser/API memory.
- Cross-process catch-up runs every 1 second by default only while a client is connected and drains bounded pages after sleep or a burst. `ORLYNX_SSE_CATCHUP_MS` tunes this without changing protocol semantics.
- LISTEN/NOTIFY was evaluated but not enabled. Orlynx currently uses the Neon's HTTP `neon()` client and a pooled `DATABASE_URL`; official Neon guidance requires a dedicated session-capable client and an unpooled connection for LISTEN/NOTIFY. That would hold one connection per Render instance and inhibit scale-to-zero. Durable indexed polling is the safer free-tier deployment default; an external broker remains the scale-out option.
- Browser reconnect is generation-fenced, session-scoped, exponentially backed off with ±20% jitter, and refreshed on visibility/focus/online recovery through the existing handlers.
- OpenCode status discovery now shares concurrent requests and retains results for two seconds. The model catalog keeps its existing five-minute last-good cache and now exposes explicit invalidation.
- OpenCode's native event stream remains primary. The currently installed architecture already matches the official server/SDK event model; replacing it with the newer embedded SDK would change runtime ownership and package/runtime requirements without a comparable benchmark, so it was not adopted.

## Production-safe metrics

`GET /v1/diagnostics/performance` returns bounded aggregate samples with p50, p95 and p99. Recorded stages include message acknowledgement, event persistence, same-process delivery, replay, catch-up, time to first SSE event, workspace warm/cold startup, agent queue/runtime/provider/first-text timing, browser reconnect, and browser event-to-render timing.

The browser sends only an allow-listed metric name and numeric duration. Metrics contain no prompt text, repository path, event payload, credential, header, user ID, or session ID. The in-memory window is intentionally lightweight and resets on process restart; production-grade long-term retention can scrape the endpoint without changing request execution.

## Deployment and limitations

- Set the normal pooled `DATABASE_URL`; no migration is required.
- Optional tuning: `ORLYNX_SSE_CATCHUP_MS`, `ORLYNX_SSE_MAX_BUFFER_BYTES`, and `ORLYNX_PERF_SAMPLES`.
- Render cold starts, unavailable runners, Codespaces provisioning, and upstream model time remain external latency sources. The new metrics distinguish those stages after authenticated traffic is available.
- Sub-250 ms cross-instance delivery requires a supported broker or dedicated unpooled LISTEN/NOTIFY connection. The default polling path prioritizes durability, Neon scale-to-zero compatibility, and no extra infrastructure.
