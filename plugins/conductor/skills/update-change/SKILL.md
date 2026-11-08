---
name: update-change
description: Reconcile a change plan with accepted decisions, issue history, dependencies and current code without implementing it.
---

# Reconcile the current plan

Follow [repository scope](../../references/repository-scope.md),
[issue context](../../references/issue-context.md) and
[phase artifacts](../../references/phase-artifacts.md).

Read the current issue and history, dependencies, parent/sub-issues, linked plan,
current code and relevant verification evidence. If Conceptor owns accepted
meaning, read its applicable accepted decisions. Compare these sources with the
plan and distinguish an accepted change, a stale factual assumption, accidental
code drift and an unresolved product decision.

Update the plan to reflect established facts and accepted decisions. A substantive
replan creates a linked successor; preserve its predecessor. Do not bless
accidental implementation drift or decide changed product intent. Route a genuine
human decision through $conductor:ask-user. An independently deliverable outcome
gets a separate issue when issue creation is authorized; do not hide it in this
plan or silently expand the current issue.

Reconcile high-level issue phases, acceptance and native relationships only
within existing write authority. Complete substantive issue-body updates before
review. Preserve concurrent edits and verify writes. Changes affecting active
automation require its existing owner's hold and reconciliation barrier before
mutating the affected contract. Unresolved auto-merge disarm or merge outcomes
block dependent mutation; labels alone do not establish safety. The existing
owner must reconcile delivery evidence while retaining the hold.

Return the reconciled plan, accepted changes, unresolved decisions and next useful
action. Do not implement, declare acceptance satisfied or release a hold.
