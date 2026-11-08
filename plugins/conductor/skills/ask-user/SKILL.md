---
name: ask-user
description: Investigate unresolved user decisions, ask self-contained questions in chat and integrate answers without repeating resolved questions.
---

# Ask the user

Follow [repository scope](../../references/repository-scope.md) for the capability
being used. Local decisions do not require GitHub automation setup. Use
[issue context](../../references/issue-context.md) for issue-owned decisions.

Use the current chat for decisions. Investigate discoverable facts first and ask
only questions whose answers can change the authorized work. Recover accepted
decisions and pending answers before asking again. This skill works without a
director or running service. Read [shared issue policy](../../references/workflow.md)
when the decision affects GitHub work.

Explain the situation, necessary terms, concrete options and consequences. Give a
recommendation with reasons. Ask one focused question or a small related group;
the user must be able to answer without reading an issue, proposal or tool log.
Do not manufacture a questionnaire when the relevant decisions are already made.
Continue independent authorized preparation while a dependent decision is open.

Use native question cards when available and appropriate; otherwise leave the
question visible in ordinary chat and end the turn. Do not require a mode change,
terminal prompt cycle, running listener or browser. Host approval controls retain
their required interface. Silence, dismissal, internal notifications and drafts
are not answers or authority. Record explicit deferral with its return condition.

## Recover and integrate decisions

For an issue-owned decision, use the existing append-only records described in
[decision records](references/decisions.md). Recover all current stages, source
context and partially integrated answers before asking or writing. State intended
GitHub writes before making them. An answer is recorded before its effects;
integrated means the owning meaning, issue text, relationships, acceptance and
labels have been reconciled and verified. It does not mean acceptance is achieved.

In manual or synchronous work, use direct authorized GitHub operations with the
existing decision schema and revision checks. Do not use runtime interaction or
decision controls that require a bound automated director. When an issue revision
affects active automated work, its existing director establishes the hold barrier
first; recover the decision without taking over that binding.

For initial automation startup, finish the first question phase through the direct
chat/GitHub path before enablement. In already-bound automation, the director uses the existing
`interaction-begin`, `decision-read`, `decision-record`, `decision-integrate` and
`interaction-complete` controls. Read [automation](../../references/automation.md)
for that branch. Preserve unanswered decisions across turn endings and handoff.

## Optional collaboration inbox

Use `$onepersonlabs:human-collaboration` only when the user explicitly asks for
that channel. Do not auto-enroll, connect, launch a listener or open a browser.
Preserve existing pending contributions even when the user continues in chat.
On an authorized inbox path, reuse the existing contribution, claim a submitted
answer before effects, check its issue and reviewed revision, and reconcile any
partial integration before recording an outcome. Transfer contribution ownership
through that skill's bind procedure during an authorized handoff; Conductor attach
does not transfer it. A submission receipt is not verified integration.
