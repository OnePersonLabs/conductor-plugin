---
name: open-change
description: Reopen a closed GitHub change issue identified by number, URL or name without resuming work or restoring verification claims.
---

# Reopen a closed change

Follow [repository scope](../../references/repository-scope.md) for issue work and
[issue context](../../references/issue-context.md). Call its canonical
`resolve-issue` CLI for every request, passing the new literal number, `#number`,
URL or name as `--target`. Only when the request has no explicit target may you
pass an established `--current` ID. With neither, call without either option to
obtain choices. Do not substitute your own GitHub search or reuse an old list.

Only a `resolved` result establishes one issue for the reopening decision. For
`selection-required`, show the returned `selection` string verbatim and ask for
an ID, even when every candidate is already open. Preserve the previous current
issue while selection is unresolved. Report `not-found` and errors as described
in the shared contract. A shared state does not resolve identity. Do not replace
the selection with the already-open warning.

If the issue is already open, say exactly:

> ⚠️ Issue is already open

Stop without duplicate comments, label churn or other work. Otherwise state the
intended reopen operation, re-read current state, reopen within authority and
verify the result. Preserve concurrent metadata and existing holds. Keep this
issue current in the session.

Reopening does not restore previous verification, release blockers or holds,
resume a worker, authorize implementation or start a director. Report the
reopened issue and any existing restriction that affects its next action.
