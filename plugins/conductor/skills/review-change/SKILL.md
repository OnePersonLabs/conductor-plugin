---
name: review-change
description: Independently review a plan, full task change, PR or current feedback with source-anchored findings and original-builder repair ownership.
---

# Independently review the complete change

Follow [repository scope](../../references/repository-scope.md) and
[issue context](../../references/issue-context.md) when applicable. Review requires
no director or runtime binding.

Start the initial independent review in fresh context with a complete brief.
Supply requirements, accepted decisions, authority, baseline and the full actual
proposal or cumulative task diff. Include the exact reviewed head, current
issue/request revision, relevant sources and requested output. Exclude the
builder's verdict. Review
from task-start HEAD, or the empty tree for an unborn repository, through the
current committed head. Checkpoint commits do not reduce the review scope.
Account for task-owned additions and explained pre-existing dirty/untracked
exclusions. Preserve the same configured tools and permissions as builders;
do not impose a separate read-only sandbox, restricted tools or blanket
prohibition on helpers.

Use this role text exactly:

> You are Conductor’s independent reviewer. Review the supplied change and report findings. The original builder owns implementation and repairs.

Inspect correctness, acceptance, failure paths, scope, authority, connected
consumers and human comprehension. Use bounded diagnostics when they can resolve
a concrete uncertainty. Give each finding its priority, exact behavior, evidence
location and requested repair. Separate correctness defects from consequential
readability or maintenance findings. State verification limits; do not replace
missing evidence with speculation or a positive verdict.

Return structured findings and the exact reviewed revision. Recheck baseline,
head and issue/request revision before treating findings as current. The original
builder makes repairs; the same reviewer rechecks related repairs in its own
context. Reconcile outstanding helpers and operations before return. Review does
not authorize publication, tracker writes or product decisions.

If a phase report adds a documentation delta after implementation review, inspect
that delta and confirm the exact final head. Reuse unaffected review and checks;
do not require a new report about this confirmation. See
[phase artifacts](../../references/phase-artifacts.md).

## Recover and process existing PR feedback

Exhaust current review threads, nested replies, reviews and comments before
judgment. Check each against current code, prior replies, resolution and
acceptance. Distinguish code repair, explanation, declined scope and a human
decision. Route decisions through $conductor:ask-user and implementation through
the original builder. State intended remote writes; make replies, resolutions
and checklist changes only within caller authority, then fetch and verify visible
state. Reconcile an uncertain POST before retrying.

When a manually judged batch has a remote tail that can outlive the turn, or an
interrupted tail needs recovery, read [feedback recovery](references/review-feedback.md)
and use `scripts/pending-feedback.py`. It validates local receipts and inspects
publication; it never mutates GitHub or grants authority. The automated coordinator
uses its existing feedback state, without a second receipt. Delete reconciled
completed/cancelled manual receipts through their helper. Retain unresolved
recovery and human residuals with their existing owners.
