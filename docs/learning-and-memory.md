# Orlynx learning and memory

## Mandatory selected-model review

For Build work, deterministic harness verification is necessary but no longer sufficient for finalization. Once acceptance evidence passes, Orlynx explicitly asks the model selected for that task to act as an independent quality/reasoning partner.

The model must challenge unsupported claims, missed requirements, wrong-layer diagnoses, accidental regressions and unnecessary changes. It may use tools to inspect or correct the work and must re-verify anything it changes. Only after that selected-model review can the Build result finalize.

The review is concise and evidence-grounded (for example, `Model → Orlynx: verified — tests and requested behavior are confirmed`); Orlynx does not expose private chain-of-thought. Switching the selected model for a new Build means that model becomes the review/reasoning partner for that Build.

Verified reviews may contribute scoped repository/environment lessons. Those lessons remain user-isolated, relevance-ranked, and subordinate to fresh evidence.

## The important distinction

Orlynx can learn from earlier successful work, but it does **not** retrain, fine-tune or permanently modify the weights of the connected language model.

Its learning system is an Orlynx-owned verified-memory layer.

That distinction matters because “the model learned this” and “Orlynx remembered verified project evidence” are very different technical claims.

## Why Orlynx needs memory

A coding workspace repeatedly encounters repository-specific and environment-specific facts such as:

- a particular app uses an unusual build command;
- a Preview problem came from provider forwarding rather than Vite configuration;
- a repository requires a certain verification sequence;
- a workspace provider exposes a recurring recovery pattern;
- a prior diagnosis was wrong until a specific piece of evidence was checked.

Without memory, every new run starts from zero and may repeat the same investigation.

With uncontrolled memory, however, stale conclusions can pollute future work.

Orlynx therefore learns only from verified resolution and retrieves memory conservatively.

## Current learning pipeline

The current implementation is centered in **apps/api/src/agent-memory.ts** and the harness.

A durable Investigation is now first-class task state. Orlynx does not collapse uncertainty directly into failure. The bounded state machine is:

~~~text
unknown
  ↓
investigating
  ↓
hypothesis
  ↓
testing
  ↓
repairing
  ↓
verifying
  ↓
resolved
  ↓
learned (only when a verified lesson is actually persisted)
  └── blocked only when the bounded investigation cannot proceed safely
~~~

The Investigation object persists its stable ID, question, model hypothesis, structured next check, observable evidence, repair action, attempt number and verified outcome in the durable harness checkpoint. The public `Model → Orlynx` diagnostic is parsed into those fields instead of being stored as one opaque sentence. Reconnects and process restarts therefore resume the same diagnosis instead of inventing a new one.

When the primary diagnosis repeats, becomes stagnant, or remains unclassified, Orlynx may open a separate **read-only architect session** to challenge the hypothesis and propose one discriminating next check. After deterministic verification passes, a separate **read-only reviewer session** can challenge the completed work before the primary agent finalizes. Both delegations emit canonical `subagent.started` / `subagent.finished` events. They use the installed agent adapter; this is not a claim that a second external coding-agent adapter is installed.

The verified learning pipeline is:

~~~text
Task begins
   ↓
Current prompt + repository/environment evidence
   ↓
Orlynx harness detects a contradiction / missing acceptance criterion
   ↓
One or more Investigation / reflection rounds
   ↓
Real tool evidence is gathered
   ↓
Harness verification passes
   ↓
Final resolution exists
   ↓
Verified lesson may be persisted
~~~

If the task did not require reflection, or verification did not pass, Orlynx does not create a learned lesson from that run.

This is deliberate. Ordinary model prose is not sufficient evidence for durable memory.

## What gets stored

A learned lesson can include:

- scope;
- user ID;
- project ID when repository-scoped;
- originating session ID;
- a short title;
- the original problem;
- the verified resolution;
- supporting evidence;
- search/relevance tags;
- provider metadata when useful;
- success count;
- confidence and contradiction count;
- active/superseded status;
- typed lesson kind;
- a bounded verified knowledge edge (`subject → predicate → object`) when derivable;
- creation/update/last-verified/last-contradicted timestamps.

The implementation currently supports two practical scopes.

### Repository lessons

Repository lessons apply to the current project.

Examples:

- a repo-specific test command;
- a known Preview peculiarity caused by its framework;
- a recurring build sequence;
- a specific project convention discovered and verified during work.

### Environment lessons

Some lessons describe infrastructure rather than one repository.

Environment memory is created only for patterns related to areas such as:

- Codespaces;
- Render;
- OpenCode;
- Preview forwarding;
- app.github.dev;
- authentication;
- workspaces;
- runners.

Environment memory is still user-scoped.

## Memory isolation

Lessons are keyed and queried under the authenticated user.

Repository lessons also retain project scope.

This prevents one user's debugging history from becoming another user's hidden prompt context.

Memory isolation is part of the product security contract, not a relevance optimization.

## Relevance before influence

Orlynx does not inject every old lesson into every task.

The current retrieval path:

1. loads a bounded set of recent candidate lessons for the user/project;
2. extracts useful tokens from the new prompt;
3. scores overlap with lesson tags, title, problem and resolution;
4. adds a repository-scope boost when project IDs match;
5. adds a smaller environment/provider boost where appropriate;
6. adds limited weight for repeatedly successful lessons;
7. drops zero-overlap lessons;
8. returns only the highest-scoring small set.

The current implementation caps the injected set at five lessons.

This means repository scope alone is not enough. A lesson must still be relevant to the new request.

## How memory is presented to the model

Retrieved lessons are introduced with an explicit warning:

- treat them as verified prior experience;
- do not treat them as infallible rules;
- compare them with the current environment;
- trust fresh verified evidence if there is a conflict.

This is one of the most important design choices in the learning system.

Memory should accelerate investigation, not force reality to match history.

## Fresh evidence always wins

Suppose an earlier lesson says:

> Preview failures in this environment were caused by provider forwarding.

A later task may fail because the application itself now binds incorrectly.

Orlynx should use the old lesson as a hypothesis shortcut, check current evidence, and discard or revise the hypothesis when the new evidence disagrees.

The intended priority is:

~~~text
fresh verified evidence
    >
current observed state
    >
relevant prior lesson
    >
model assumption
~~~

## Secret handling

Before learning, memory content is cleaned and bounded.

The memory cleaner redacts common forms of:

- bearer credentials;
- tokens;
- passwords;
- secrets;
- API keys.

The event pipeline also redacts secret-like data before durable storage and streaming, and historical evidence is sanitized again before it can participate in reflection.

No redaction system should be treated as a license to intentionally place secrets in prompts or logs. The correct architecture is still to keep credentials out of model-visible evidence whenever possible.

## What Orlynx does not learn automatically

The current memory layer does not automatically learn:

- the user's general personality;
- arbitrary preferences from every chat message;
- unverified coding opinions;
- raw terminal output as a permanent rule;
- failed hypotheses;
- hidden model chain-of-thought;
- another user's lessons;
- a universal rule simply because it worked once in one repository.

Those would create a much less trustworthy system.

## Relationship to Investigation blocks

Investigation blocks are the observable diagnosis loop.

A typical sequence is:

~~~text
Investigation 1
Orlynx: Preview port exists, but the browser URL is still unavailable.
Model: Check provider forwarding before editing Vite config.
Evidence: forwarding state does not expose the port.

Investigation 2
Orlynx: forwarding has now been established.
Model: verify the browser-renderable URL.
Evidence: HTML Preview responds successfully.

Verification: passed
Lesson: provider forwarding should be checked before project config changes for this pattern.
~~~

Only the verified result is a candidate for durable lesson memory.

## Success count and repeated evidence

A stable lesson identity is derived from user, scope, project, verification target and tags.

When equivalent verified lessons recur, the stored lesson can gain success history rather than creating endless duplicates.

Success history may slightly improve retrieval ranking, but it does not convert the lesson into absolute truth.

## Memory lifecycle standard

Future memory improvements must preserve these rules:

1. **verified before remembered**;
2. **user isolation**;
3. **relevance before injection**;
4. **bounded context**;
5. **secret minimization**;
6. **fresh evidence beats memory**;
7. **no hidden cross-project contamination**;
8. **memory can be corrected**;
9. **the model is not described as retrained when it is not**;
10. **memory behavior must be testable and observable.**

## Current correction and project-intelligence behavior

### Structured lesson types

Verified lessons are now classified into bounded types such as:

- repository convention;
- build/test recipe;
- infrastructure recovery pattern;
- Preview pattern;
- dependency compatibility;
- deployment procedure;
- general verified fact.

The type participates in stable lesson identity and retrieval.

### Confidence, decay and contradiction-driven correction

Verified lessons carry confidence and last-verified time. Repeated equivalent verified successes raise confidence gradually, with a hard ceiling below absolute certainty. Retrieval discounts old lessons that have not been revalidated recently.

When fresh observable evidence clearly disproves a lesson that was actually injected into the current run, the model can emit `[MEMORY_CONTRADICTION:<lesson-id>]` in its public diagnostic. Orlynx accepts markers only for lesson IDs applied to that task, records the contradictory evidence, reduces confidence, and increments a contradiction counter. Three verified contradictions supersede the stale lesson so it no longer participates in normal retrieval. A later equivalent verified success may reactivate the lesson.

This mechanism is deliberately evidence-gated; mere irrelevance or a failed task does not count as contradiction.

### Verified project knowledge edges

Repository/environment lessons also carry a small structured edge:

~~~text
subject → predicate → object
~~~

Examples include a repository `verifies_with` a build/test recipe or an environment `recovers_via` an infrastructure procedure. These edges participate in relevance scoring and give Orlynx a bounded knowledge-graph foundation without stuffing an entire repository graph into every prompt.

This is **not yet** a complete static architecture/dependency graph. Full automatic service/package/route relationship extraction remains future work.

## Remaining learning directions

### Team memory

For team workspaces, selected verified project knowledge could become shared organizational memory with explicit provenance and access controls.

User-private memory and team-shared memory must remain separate concepts.

### Full repository architecture graph

The current verified knowledge edges should eventually be complemented by inspectable static/runtime relationships among services, packages, routes, dependencies, tests, and deployment targets.

### Learning from production outcomes

Orlynx can already remember verified task/deployment procedures when those outcomes appear in task evidence. A stronger production feedback loop still requires later deployment health, CI/regression observation, and connector-backed production evidence to be tied back to the originating change.

That future lifecycle is:

~~~text
planned change
→ code change
→ tests
→ deploy
→ production observation
→ verified outcome
→ durable lesson
~~~

Long-lived production monitoring must not be claimed until those external observations are actually connected.

## The standard

The goal is not for Orlynx to “remember everything.”

The goal is for it to remember the **smallest amount of verified information that makes future work materially better without making the system less truthful**.


See [Orlynx-owned multi-agent execution](multi-agent-architecture.md) for portable adapters, fenced same-task handoffs, provenance and rollout limitations; [implementation status](multi-agent-architecture-status.md) records the verified scope.
