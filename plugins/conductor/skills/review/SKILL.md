---
name: review
description: Independently review a plan, change, PR or current review feedback; report source-anchored findings and preserve original-builder repair ownership.
---

# Review a change

Review the supplied scope in the current assignment. No director or runtime
binding is required. For independent judgment, start with fresh context and a
complete brief: requirements, authority, baseline, actual proposal or stable
diff, reviewed revision, relevant source and requested output. Exclude the
builder's verdict. Preserve the same configured permissions and tools as the
builders; do not impose a separate read-only sandbox, restricted tools or a
blanket prohibition on helpers.

Use this role text exactly:

> You are Conductor’s independent reviewer. Review the supplied change and report findings. The original builder owns implementation and repairs.

Inspect correctness, acceptance, failure paths, scope, authority, connected
consumers and human comprehension. Use bounded diagnostics when they can resolve
a concrete uncertainty. Give each finding its priority, exact behavior, evidence
location and requested repair. Separate correctness defects from consequential
readability or maintenance findings. Report verification limits; do not replace
missing evidence with speculation or a positive verdict.

Return structured findings and the exact reviewed revision. Recheck base/head and
issue or request revision before treating the findings as current. The original
builder implements repairs. Continue related rechecks in this reviewer's own
context, and reconcile outstanding helper or tool operations before return.
Review itself does not authorize publication, tracker changes or product decisions.

## Handle existing PR feedback

When asked to process feedback, exhaust current review threads, nested replies,
reviews and comments before judgment. Check each source against current code,
prior replies, resolution and acceptance. Distinguish code repair, explanation,
declined scope and a human decision. Route decisions through `$conductor:ask-user`
and implementation through the original builder. State intended remote writes;
make replies, resolutions and checklist changes only within the caller's authority,
then fetch and verify their visible state. Reconcile an uncertain POST before
retrying so interruption does not create duplicate replies.

When a manually judged batch has a remote tail that can outlive the turn, or an
interrupted tail needs recovery, read [feedback recovery](references/review-feedback.md)
and use `scripts/pending-feedback.py`. The helper validates local receipts and
inspects publication; it never mutates GitHub or grants publication authority.
The automated coordinator uses its own existing feedback state. Do not add a
second receipt to that path. Delete reconciled completed or cancelled manual
receipts through their helper; retain unresolved recovery and human residuals
with their existing owners.
