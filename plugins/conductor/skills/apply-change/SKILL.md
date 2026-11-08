---
name: apply-change
description: Implement, check and repair an authorized local change or accepted phase, retaining the original builder and complete task review scope.
---

# Implement the authorized change

Follow [repository scope](../../references/repository-scope.md),
[issue context](../../references/issue-context.md) when applicable and
[phase artifacts](../../references/phase-artifacts.md). This action does not start
a director, create a user chat or require a new issue.

## Establish ownership and the review baseline

Read checkout state, effective instructions, unrelated dirty/untracked work,
accepted requirements and the applicable plan. Record task-start HEAD before
task edits. If the repository has no commit, use Git's empty tree as the review
baseline. Record which pre-existing dirty and untracked paths are excluded and
why. If a task must modify an already-dirty file, preserve and explain the
pre-existing portion so reviewers can distinguish it. Do not silently drop
relevant untracked task files from the review.

Establish connected behavior and observable acceptance. Use $conductor:plan-change
for consequential planning gaps and $conductor:ask-user for missing authority or
a product decision. Preserve holds, spending limits and reviewed design handoffs.
Before editing, resolve worker/delivery conflicts through their existing owner.
A paused service does not establish safe ownership. For assigned automated work,
verify the original saved job, thread, branch and worktree match this assignment.

## Build, check and repair

State the affected responsibilities before a substantial change. Finish the
behavior through its consumers, update reader instructions and remove obsolete
machinery within scope. Preserve unrelated work. Delegate when expected gains in
elapsed time or quality exceed setup, handoff and integration cost, with settled
interfaces, bounded outcomes, explicit write ownership and authorized tools. Keep tightly coupled
work with its writer and reconcile descendants before handoff.

After the implementation is stable, run affected existing checks and required
repository gates. Reuse valid evidence. Run an earlier diagnostic only when it
can change the next implementation decision. Add permanent coverage only for an
owned contract with a meaningful existing gap. Distinguish exercised behavior,
source inspection and unverified environment or human-comprehension claims.
Follow [phase workflow](../../references/phase-workflow.md) for batch estimates,
failure reassessment and repair limits.

Make coherent task-owned checkpoint commits before independent review when local
commits are authorized. Stage only owned changes. Review the full cumulative task
change from recorded task-start HEAD (or the empty tree) to the current committed
head, including task-owned files added during the task. Checkpoint commits do not
shrink the review to the latest commit. Supply requirements, current issue/request
revision, baseline, exact head, explained exclusions and actual diff to
$conductor:review-change without the builder's verdict.

The original builder owns repairs. Return changed evidence to the same reviewer
when repairs invalidate the review; retain the complete baseline and final head.
Report authorship can add a final documentation delta; follow the artifact
contract for the same reviewer's final-head confirmation without repeating
unaffected checks.

## Deliver only within authority

The current coordinator owns integration and authorized tracker writes. A local
commit does not authorize push, PR creation, merge, installation or issue closure.
Verify authorized remote transitions and reconcile uncertain results before
retrying. Report checked, committed, published, installed and delivered states
separately.

An automated builder retains its original job, thread, branch and worktree. It
makes no GitHub writes, push, PR, merge or closure, and does not start another
issue. Return proposed tracker changes to its coordinator. Read
[automated delivery](references/delivery.md) only for that lane. A completed
model turn is not delivery.
