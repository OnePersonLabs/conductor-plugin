# Issue decision records

Read this reference before persisting or recovering issue-owned user decisions.
The implementation owner is [`lib/decisions.mjs`](../../../lib/decisions.mjs).
Use its `readDecisions` and `recordDecision` functions with the existing
[`GitHub` adapter](../../../lib/github.mjs), or a connected adapter with equivalent
complete pagination and write/readback behavior. These functions need no service
or director binding. Do not create a parallel decision ledger or invent a second
comment format.

## Read current records

Read every page of issue comments in current API order. Recognize only comments
whose body starts with `<!-- conductor:decision:v1 -->`. Parse the following JSON.
A malformed recognized record blocks dependent writes until reconciled. For each
`decisionId`, the latest appended record is current; retain the first-seen decision
order. `readDecisions` returns those records and their revision. The revision is
SHA-256 of `JSON.stringify` of the ordered `[{ decisionId, record }]` array.
Use that exact result as `expectedRevision`; do not substitute the issue's
title/body or eligibility revision.

The append-only body has this shape:

```text
<!-- conductor:decision:v1 -->
{
  "decisionId": "stable-semantic-id",
  "record": {
    "status": "pending",
    "context": "Current facts and the scope or source revision this question concerns.",
    "question": "A self-contained question the user can answer."
  }
}
```

Reuse the stable ID for the same decision. Keep the exact context with its answer;
a changed source can require a new judgment. Do not silently carry an answer to
materially different scope.

## Append stages and verify effects

1. Recover current issue content, decision records and existing contributions.
   Reconcile any uncertain previous POST by exact record content before retrying.
   An existing identical stage is an idempotent success, not a reason to append it.
2. Append `pending` only for an unanswered decision. Every stage requires nonempty
   `context` and `question`. Append `answered` with the user's nonempty `answer`
   before changing its owning meaning or issue. Preserve the answer's authority
   and limits; do not turn it into proof of implementation or delivery.
3. Before effects, recheck current issue/request revisions and the record revision.
   Pass the current `expectedRevision` to `recordDecision`. Its `beforeWrite`
   callback can recheck source and authority immediately before the append. On a
   stale revision, read and reconcile before retrying; never replay blindly.
4. Apply authorized changes to the existing meaning owner, issue text, dependencies
   and acceptance. Reconcile labels with the decisions that remain. Remove
   `needs-input` only when no unresolved human dependency remains. Resolve a
   `proposal` to the appropriate primary state; rejection does not authorize
   implementation. Preserve explicit holds and admission restrictions.
5. Read back all effects, then append `integrated` with the exact persisted answer
   and context plus nonempty `integration` evidence. It must follow an `answered`
   or existing `integrated` stage for that answer/context. Use `deferred` only
   with the user's nonempty response in `answer` and a nonempty `returnCondition`.
6. Read every page again and verify that the latest record is the intended stage.
   The existing writer performs this readback, including after an uncertain POST.
   If an effect is uncertain, retain the answered stage and report the exact
   recovery action. Do not mark it integrated or repeat the question.

An integrated record cannot reopen in unchanged context. An answered record
cannot return to pending in unchanged context. Recover its missing integration.
Partial answers leave only the unanswered decision open. Questions outside an
issue stay with their existing meaning or conversation owner; this schema does
not require creating an issue for every chat question.
