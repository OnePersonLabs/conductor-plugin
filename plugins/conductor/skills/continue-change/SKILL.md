---
name: continue-change
description: Continue the current change by selecting and completing one coherent next action from its present evidence.
---

# Continue one coherent action

Follow [repository scope](../../references/repository-scope.md) and
[issue context](../../references/issue-context.md). Recover the intended outcome,
current plan, code, check results, reviewed revision and acceptance evidence.
If the current issue is closed, report that state and stop. Keep it current.

Choose the first applicable action:

1. Stale or conflicting plan: use $conductor:update-change.
2. Missing next-phase plan: use $conductor:plan-change.
3. Remaining authorized implementation or review repairs: use
   $conductor:apply-change with the original builder.
4. Missing or stale independent review: use $conductor:review-change; reuse the
   reviewer for related repairs.
5. Uncertain acceptance: use $conductor:verify-change.
6. Complete reviewed work with its delivery requirements met: report ready/done.

Complete one coherent action, then report its result and remaining dependency.
Do not use this selector as an unbounded autonomous loop. Respect the active
pair-program phase boundary and host mode. A planning result is not execution
authority. Do not implicitly close or reopen an issue, push, merge, start a
director, start background automation or choose a different issue.
