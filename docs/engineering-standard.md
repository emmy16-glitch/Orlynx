# Orlynx engineering standard

This document defines the minimum standard for changes to Orlynx.

A feature is not complete merely because the happy path works once.

## 1. Durable-first

Any work that matters after a refresh, restart or reconnect must have a server-side durable representation before the UI relies on it.

Examples:

- messages;
- tasks;
- queue position;
- run state;
- approvals;
- events;
- change sets;
- publication receipts;
- learned lessons.

Browser state is a cache or convenience layer, not product truth.

## 2. Evidence before completion

When a user request implies an observable result, Orlynx must verify that result.

Examples:

| User intent | Minimum useful evidence |
| --- | --- |
| “change this” | file/change evidence |
| “fix the tests” | test result |
| “make sure it builds” | build/typecheck result |
| “start localhost / Preview” | browser-resolvable Preview |
| “commit it” | commit receipt/SHA |
| “push/publish it” | exact branch/publication receipt |
| “deploy it” | deployment evidence where connector/tool support exists |

A model statement is not evidence.

## 3. Same-goal continuation

Natural follow-ups should continue the active goal.

Do not create a new run just because a new chat message arrived.

Only explicit next-task intent should create separate queued work.

This rule must be tested around finalization races.

## 4. Queue safety

Queued tasks must be:

- durable;
- ordered;
- visible;
- editable before start;
- cancellable before start;
- sequential unless a future explicit parallel-task architecture says otherwise.

No task may be promoted beside active/waiting work by accident.

## 5. Provider independence

Compute providers and agent runtimes must live behind contracts.

A new provider must not require:

- a second session system;
- a second task ledger;
- a second event protocol;
- a second publication model;
- a separate conversation UI.

## 6. Honest state

The UI must distinguish:

- queued;
- preparing;
- running;
- waiting;
- needs approval;
- reconnecting;
- completed;
- failed;
- cancelled.

Never convert “we stopped receiving updates” into “completed.”

Never convert “a port answered” into “Preview is ready” without browser-surface evidence.

## 7. Failure isolation

A subsystem failure should damage the smallest possible scope.

Examples:

- agent unavailable → shell/files/Git can remain available;
- runner unavailable → Codespaces fallback where permitted;
- browser offline → server work continues;
- SSE disconnect → replay later;
- one stale lesson → ignore it in favor of fresh evidence;
- Preview forwarding failure → do not rewrite repository config without evidence.

## 8. Security boundaries

Required rules:

- no user PAT entry flow;
- GitHub credentials stay server-side;
- agent shell does not receive unrestricted GitHub credentials;
- bridge credentials are short-lived/scoped;
- provider credentials are encrypted at rest where persisted;
- secret-like values are redacted before durable event storage;
- historical events are sanitized before replay/reflection;
- learned lessons are user-isolated;
- repository path escape is denied;
- dangerous command patterns remain blocked;
- consequential actions are auditable.

## 9. Model and agent humility

The connected model can form hypotheses.

Orlynx should distinguish:

~~~text
observed fact
hypothesis
check
evidence
verified conclusion
~~~

Do not promote a hypothesis to product truth because it sounds plausible.

## 10. Memory discipline

Only verified post-reflection outcomes become durable learned lessons.

Memory retrieval must remain:

- relevant;
- bounded;
- scoped;
- redacted;
- overridable by fresh evidence.

Do not use old memory to force a diagnosis.

## 11. Mobile-first interaction

Every core project workflow should remain usable on a narrow phone.

Minimum checks include:

- 360px;
- 390px;
- 412px;
- keyboard open/close;
- stream while scrolled upward;
- long paths/text;
- queue controls;
- approvals;
- Preview;
- reconnect.

Desktop may add context; mobile must not become a degraded viewer.

## 12. Streaming standard

Streaming should represent real upstream progress.

Requirements:

- ordered deltas;
- stable run identity;
- durable final result;
- no fake “typing” animation of a fully buffered answer;
- replay-safe event identity;
- no forced autoscroll when the user is reading old content.

## 13. UI progressive disclosure

Default view should answer:

- what is happening?
- what changed?
- did it work?
- does it need me?

Detailed evidence should be available without turning the whole conversation into terminal output.

Private chain-of-thought is never a UI feature.

## 14. Preview standard

Preview diagnosis order:

1. process state;
2. listener/port;
3. browser suitability;
4. provider forwarding;
5. browser-reachable URL;
6. project configuration only when evidence requires it.

Do not permanently edit a project solely to compensate for Orlynx/provider forwarding problems.

## 15. Git publication standard

Before publication:

- preserve the user's exact target intent;
- do not guess an ambiguous branch;
- confirm policy/permission;
- verify workspace Git state;
- keep credentials outside the agent;
- persist receipt/audit evidence.

## 16. Test standard

Changes to a contract require regression coverage.

High-risk contracts include:

- queue promotion;
- continuation;
- finalization;
- event replay;
- adapter readiness;
- Preview;
- publication;
- secret redaction;
- memory isolation;
- workspace provider fallback.

Passing typecheck alone is insufficient for these areas.

## 17. Documentation standard

Documentation changes with architecture.

Do not leave historical documents worded as current product truth.

New architecture must update:

- root README where relevant;
- docs index;
- subsystem docs;
- end-to-end verification contract.

## 18. Deployment standard

A release claim should be tied to:

- exact commit SHA;
- CI status;
- deployed revision;
- startup/health;
- relevant live smoke tests.

Unit tests are not proof of external provider availability.

## 19. No silent fallback

Fallback must be explicit in state and policy.

Examples:

- runner → Codespaces can be automatic when configured;
- model/agent must not silently switch to another provider because the selected one failed;
- publication must not silently change target branch;
- GitHub authorization must not silently downgrade.

## 20. Simplicity over duplicated architecture

When a bug appears, first fix the existing contract.

Do not create a second system beside the first merely to bypass a difficult edge case.

Orlynx should become more capable by strengthening its boundaries, not by multiplying incompatible paths.
