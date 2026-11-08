---
name: close-change
description: Close a completed, reviewed change issue after delivery, or ask explicitly about an unverified closure and reconcile dependents safely.
---

# Close the current issue safely

Follow [repository scope](../../references/repository-scope.md),
[issue context](../../references/issue-context.md) and
[shared issue policy](../../references/workflow.md). If the issue is already
closed, report it and stop without duplicate comments or writes. Keep it current.

Read acceptance, implementation, required checks, current independent review and
the repository's delivery boundary. Close known completed and reviewed work only
when required delivery is met and closure is authorized. Read back the final state.

If implementation or acceptance may be unverified, say exactly:

> ⚠️ Implementation may not be verified

Explain the missing or stale evidence and the consequence of closure. Ask whether
the user wants to close with that uncertainty, then WAIT for explicit confirmation.
Do not infer confirmation from silence, earlier implementation authority or the
close request that preceded this warning.

Before a confirmed unverified closure, establish a durable hold/reconciliation
barrier that prevents dependents from treating closure as verified acceptance.
Reconcile dependent acceptance where evidence permits and retain unresolved
obligations behind that barrier. Do this before closing. Preserve prior states
and exact hold IDs. Issue labels alone do not establish that a barrier is safe.

For active or unresolved automation work, use its existing owner's controls. If
there is no active or unresolved automation owner, use the existing remote-hold
helper without configuring or starting automation:

```text
node <plugin-root>/bin/conductor.mjs hold --request-file PATH
```

The JSON request is `{ "op": "create", "repository": "owner/repo", "issue": 42,
"holdId": "UUID", "reason": "Confirmed unverified closure; acceptance and dependents require reconciliation" }`.
Choose a stable UUID for this operation. The helper uses the existing remote hold
receipt and configured or default workflow labels, preserves overlapping holds
and returns only after its barrier is verified. Read back the receipt and label
before closure. A temporary request file belongs to this operation; dispose of it
after its effects are reconciled. After an uncertain write, request `reconcile`
with the same repository, issue and hold ID before retrying. Do not create a
second receipt or a parallel ledger. Active/unresolved runtime conflicts reject
this manual path and require the bound owner.

If an owned PR's
auto-merge disarm fails or its merge outcome is uncertain, closure is blocked
until the existing owner reconciles that operation. A merged race uses the bound
owner's `reconcile-delivery` control with the issue and current `expectedRevision`
on the paused original job. Require `deliveryBarrierEstablished: true` and
`deliveryReconciliationRequired: false` with verified evidence; this operation
retains holds and does not release or resume work. Do not adopt a director to
obtain controls. Without that barrier and reconciliation, report the blocker and
leave the issue open. Without an automation owner, retain the durable remote hold
after closure so future automation cannot treat the closed issue as a verified
prerequisite. Release requires explicit authority after acceptance and dependent
reconciliation; use `release` for that exact hold only and preserve overlaps.

For rejection, cancellation or duplicate disposition, record the authorized
reason and reconcile dependents; closure does not establish a successful
prerequisite. Preserve concurrent edits. Never release a hold, activate admission,
reopen another issue or start new work as a side effect.
