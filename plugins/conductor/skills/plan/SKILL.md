---
name: plan
description: Only for repositories with valid Conductor setup. Investigate and plan a bounded change in the current chat, including affected consumers, acceptance, dependencies and unresolved decisions.
---

# Plan a change

Before using this skill, follow the [repository setup gate](../../references/repository-scope.md).
If the gate fails, stop this skill before any task work.

Plan the requested outcome as the current agent. No director, runtime binding,
background service or issue creation is required. A request to plan or implement
a plan does not authorize starting or adopting a director, or asking to start one.

1. Read current instructions, accepted meaning and relevant source. Identify the
   intended outcome, complete affected consumers, failure paths and authority.
   Read [shared issue policy](../../references/workflow.md) when issues are involved.
2. Investigate the next connected work. Resolve discoverable facts and routine
   choices within accepted goals. Compare structural alternatives when their
   consequences could change the decision. Distinguish evidence, assumptions and
   unanswered decisions. Use `$conductor:ask-user` for consequential gaps that
   only the user can resolve; continue independent preparation.
3. Return the bounded approach, affected owners, acceptance criteria, verification
   and delivery boundary. State dependencies, retained holds and remaining gaps.
   Keep future phases broad. Do not turn a small change into a mandatory issue,
   questionnaire, delegation or design-handoff process.

Use bounded helpers only when effective instructions authorize delegation and its
benefit exceeds handoff and integration cost. Independent planning starts without
parent conversation history, with a complete brief and explicit model, effort,
ownership, evidence and stop condition. `$conductor:planner` is the delegated
adviser; it does not replace this current-agent planning path. Reuse that adviser's
own context for related follow-ups.

If the repository requires a reviewed design handoff, prepare it through the
existing meaning owner before dependent implementation. Give an independent
reviewer the governing requirements and actual proposal without the planner's
verdict. Preserve the complete capability contract while selecting a bounded
increment. See [reviewed design handoffs](../../docs/configuration.md#reviewed-design-handoffs).

Planning does not prove acceptance, release holds or authorize publication. For
requested issue edits, use `$conductor:manage-issues`; for authorized execution,
use `$conductor:implement`. Finish a planning-only request with the concrete plan.
