---
name: plan-change
description: Plan a bounded change or the next complete phase of rolling wave planning, with broad later phases and explicit acceptance.
---

# Plan the next complete phase

Follow [repository scope](../../references/repository-scope.md). Use
[issue context](../../references/issue-context.md) when an issue owns the work;
a direct local request does not require one. Read [phase artifacts](../../references/phase-artifacts.md)
for tracked plans and [phase workflow](../../references/phase-workflow.md) when
coordinating phases. A planning request does not start a director.

Read instructions, accepted meaning and relevant source. Identify the intended
outcome, complete consumers, failure paths, constraints, authority and current
evidence. Resolve discoverable facts and routine choices. Compare consequential
structural alternatives when their effects could change the approach. Distinguish
evidence, assumptions and unanswered product decisions. Use $conductor:ask-user
only for a consequential gap the user must resolve; continue independent work.

Keep future phases broad and make the next connected phase complete. Specify
behavior, affected owners/interfaces, observable acceptance, verification,
dependencies, delivery boundary, resource constraints and stopping point. Preserve
the intended capability when choosing an increment; explain how deferred scenarios
remain compatible. A plan does not mark work ready, prove acceptance, release
holds or authorize implementation or publication.

For a required reviewed design handoff, prepare the concrete proposal through its
existing meaning owner before dependent implementation. Give an independent
reviewer the requirements and actual proposal without the planner's verdict.
See [reviewed design handoffs](../../docs/configuration.md#reviewed-design-handoffs).

## Bounded delegated planning

This skill also serves a coordinator-assigned bounded planning task; there is no
separate adviser role. Start independent planning with fresh context and a complete
brief: decision question, outcome, governing requirements, accepted decisions and
reasons, authority, source evidence, boundaries and stop condition. Select the
task's model and effort under the coordinating workflow. Report unavailable
required models rather than substituting.

Investigate and develop the usable plan within that assignment. Choose reasonable
compatible approaches within accepted goals. Return concrete plan content,
selected evidence, affected owners/issues, acceptance, working assumptions,
remaining human decisions and the next action. Do not return only a problem list.
Ask the assigning coordinator for missing decisive facts. Do not contact the user,
write issues, save tracked plans, dispatch implementation or create a second
coordinator. The parent owns artifact and tracker writes. Continue related
follow-ups in the same worker context; reconcile outstanding descendants and
operations before return.

For pair programming, $conductor:pair-program configures the managed worker in
actual Plan Mode and relays its questions while the visible coordinator normally
stays in Default mode. The coordinator saves the accepted plan after the planning
turn completes. If the host coordinator is itself in Plan Mode, do not bypass
its write restriction through a worker. Finish a standalone planning request with
the concrete plan and unresolved decisions; do not begin implementation.
