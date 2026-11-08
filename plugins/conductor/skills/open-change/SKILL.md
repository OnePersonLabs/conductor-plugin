---
name: open-change
description: Reopen a closed GitHub change issue identified by number, URL or name without resuming work or restoring verification claims.
---

# Reopen a closed change

Follow [repository scope](../../references/repository-scope.md) for issue work and
[issue context](../../references/issue-context.md). Resolve the explicit number,
`#number`, URL or name, or the established current issue. Include closed issues
in name matching and exhaust relevant pages. Ask for an ID when ambiguous.

Resolve exactly one issue before checking whether reopening is needed. If several
issues match, show their current `[ID]: [name]` rows in descending number order
and ask for one ID, even when every candidate is already open. A shared state
does not resolve identity: the selected issue must become the current issue.
Do not replace this selection with the already-open warning.

If the issue is already open, say exactly:

> ⚠️ Issue is already open

Stop without duplicate comments, label churn or other work. Otherwise state the
intended reopen operation, re-read current state, reopen within authority and
verify the result. Preserve concurrent metadata and existing holds. Keep this
issue current in the session.

Reopening does not restore previous verification, release blockers or holds,
resume a worker, authorize implementation or start a director. Report the
reopened issue and any existing restriction that affects its next action.
