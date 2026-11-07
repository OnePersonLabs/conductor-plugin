---
name: implement
description: Only for repositories with valid Conductor setup. Implement an authorized bounded change or accepted plan in the current chat, verify connected behavior and carry it to its authorized delivery boundary.
---

# Implement a change

Before using this skill, follow the [repository setup gate](../../references/repository-scope.md).
If the gate fails, stop this skill before any task work.

Carry out the authorized change as the current agent. This skill needs no director,
runtime binding, background service or new worktree. An ordinary change or
implement-plan request does not start or adopt a director, or require asking to
start one. Read [shared issue policy](../../references/workflow.md) when issues
are involved.

## Establish the work

Read checkout state, instructions, unrelated dirty work, accepted requirements
and any applicable plan. Establish the intended connected behavior and observable
acceptance. Use `$conductor:plan` only for gaps that need planning; keep routine
local choices in this assignment. Use `$conductor:ask-user` for a missing human
decision or authority. Preserve holds, spending restrictions and required design
handoffs. Do not invent acceptance.

For a coordinator-assigned builder, verify the saved job, thread and worktree
match this assignment, then work within that ownership. The active coordinator
does not prevent its own assigned builder from implementing the issue.
For ordinary or synchronous work, inspect current runtime and worker recovery
state before editing a checkout associated with automation. Proceed only when no
owned worker or delivery operation can conflict with the edits. A stopped service
or paused admission alone does not prove workers have stopped. Do not silently
stop automation, take over its binding or transfer a writer's ownership. Report
the conflict through the current owner and continue safe independent preparation.

## Build and verify

State the expected affected responsibilities before a substantial change. Finish
the requested behavior through its consumers, update affected reader instructions,
and remove obsolete machinery within scope. Preserve unrelated edits. When
delegation is authorized and useful, assign settled interfaces and explicit write
ownership. Keep tightly coupled work local and reconcile every descendant before
handoff. A timeout does not prove a writer stopped.

After the changed implementation is stable, run the affected existing checks and
required repository gates. Reuse valid evidence; do not duplicate complete suites
solely for a worker handoff. For an automated builder, the coordinator owns its
configured acceptance-check pass. Use earlier diagnostics only when they can
change the implementation decision. Add permanent coverage only for an owned
contract with a meaningful existing gap. Distinguish verified behavior from
source review and unexercised product or environment claims.

Obtain `$conductor:review` for substantial integrated work when required. Give the
reviewer a stable revision, requirements, baseline and actual change, without the
builder's verdict. The original builder owns repairs; return changed evidence to
the same reviewer when it invalidates the review. Make coherent task-owned local
commits when authorized. Stage only owned files.

## Deliver within authority

In manual and synchronous work, the current root owns integration and authorized
GitHub writes. A local commit does not authorize push, PR creation, merge,
installation or issue closure. Verify each authorized remote transition and
reconcile uncertain outcomes before retrying. Report checked, committed,
published, installed and delivered state separately.

An automated builder retains its original job, thread, branch and worktree. It
must not make GitHub writes, push, open or merge PRs, close issues or start another
issue; return proposed changes to its coordinator. Read [automated PR delivery](references/delivery.md)
only when working in or explaining that lane. Preserve recovery state until its
consumer has reconciled the operation. A completed turn is not delivery.
