---
name: manage-issues
description: Only for repositories with valid Conductor setup. Create, inspect, edit or close GitHub issues; manage issue status, dependencies, sub-issues and backlog readiness within authorized scope.
---

# Manage issues

Before using this skill, follow the [repository setup gate](../../references/repository-scope.md).
If the gate fails, stop this skill before any task work.

Manage the requested issues in the current chat. Read [shared issue policy](../../references/workflow.md)
before changing acceptance, state or relationships. This skill needs no director,
runtime binding or background service. An ordinary issue request does not start
or adopt a director, and does not require an invitation to start one.

## Inspect and change

1. Confirm the checkout, GitHub repository, effective instructions and requested
   outcome. Inspect current issue text, comments, labels, dependencies, parents,
   children and related active work before proposing or making changes.
2. Investigate discoverable facts. Use `$conductor:plan` when the request needs
   bounded planning, and `$conductor:ask-user` only for an unanswered human
   decision. Keep product meaning with its existing owner.
3. State the intended GitHub writes before making them. Apply authorized CRUD,
   state and relationship changes. Preserve unrelated author text and metadata.
   Use one issue per independently deliverable outcome, native blocked-by links
   for prerequisites, and native sub-issues for scope with separate ownership or
   acceptance. Do not duplicate GitHub's child listing in a checklist.
4. Read back each affected issue and relationship. Check the resulting text,
   state, acceptance and scope against the intended change. Reconcile an uncertain
   write before retrying. Report the actual writes and remaining uncertainty.

When automation owns affected active work, its existing director must establish
and verify the hold barrier before a scope or prerequisite edit. Do not adopt a
chat merely to obtain those controls. Read-only inspection, planning and changes
to unaffected issues can proceed within their existing authority. Signal an
enabled service after a verified eligible-work change when the issue-change hook
cannot identify it. A signal does not start disabled automation or grant dispatch.

Close or delete an issue only with the applicable authority and current evidence.
Distinguish completed delivery from rejection, cancellation and duplicate cleanup;
explain that disposition and reconcile dependents. Do not infer acceptance from
a closed prerequisite or a completed agent turn.
