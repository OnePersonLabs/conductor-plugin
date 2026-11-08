---
name: direct-workflow
description: Explicitly direct synchronous autonomous Conductor work or manage an explicitly selected background automation lifecycle and handoff.
---

# Direct authorized work autonomously

Select this workflow only for an explicit autonomous coordination or background
automation request. Ordinary action requests never start or adopt it. Follow
[repository scope](../../references/repository-scope.md),
[issue context](../../references/issue-context.md) and
[shared issue policy](../../references/workflow.md).

## Default to synchronous coordination

Coordinate the requested issue or local outcome visibly in the current chat.
Use [phase workflow](../../references/phase-workflow.md) and its inner action
skills to plan, implement, check, independently review, repair and report. Use
[managed work](../../references/managed-work.md) for persistent ordinary
AppServer workers owned by the foreground bridge. Verify the model catalogue;
use the production planning/implementation/review settings in managed work
without silent substitution. Preserve one writer per mutable scope and retain
original builder/reviewer context through repair.

Configure the managed worker in actual Plan Mode for planning and in Default mode
for implementation. The coordinator normally stays Default, receives the completed
plan and owns saving tracked artifacts. Use the completed-turn compaction and
atomic settings transition from the managed-work protocol when switching roles.

Unlike pair programming, synchronous autonomous work can plan and continue
within accepted scope without a routine human gate at every phase. Use
$conductor:ask-user for genuine unresolved product or authority decisions. If
those decisions are settled, proceed without a questionnaire. Make the next
phase complete, keep later phases broad, save tracked artifacts through the
coordinator and report consequential results and limits.

After review and repair, explicitly use $conductor:rolling-wave-report. Commit
the report and return its documentation delta to the same reviewer for exact
final-head confirmation under [phase artifacts](../../references/phase-artifacts.md).
Reuse unaffected evidence, then continue only within the authorized scope.

Before edits, verify no automation-owned worker or uncertain delivery conflicts.
Do not stop, cancel or take over existing automation to make synchronous work
possible. A stopped observer or paused admission is insufficient evidence.

## Select background automation explicitly

Full automation is a separate explicit choice. Read
[automation lifecycle](../../references/automation.md) only for that mode,
its runtime controls or authorized handoff. Preserve existing binding, pending
handoff, jobs, holds, admission pauses, branches, worktrees and original worker
identity. Ordinary synchronous work creates no background runner or runtime binding.

On an explicit director start, use the specified chat location. If unspecified,
ask whether to use the current chat or a fresh chat before adopting or creating
one. A new user chat requires that explicit choice. Name an adopted or created
director `🎬 <project> <MM/DD/YYYY hh:mm AM/PM>` using established project name and
local creation/adoption time. Use native project chat creation for an authorized
fresh chat, with `gpt-6.1-sol` and low thinking when supported. Check actual tool
fields and report unsupported settings. Keep the current chat's model when
adopting it unless separately authorized. Never archive the previous chat
automatically.

Supply mode, repository, authorized operation and expected prior binding to a
fresh chat. It verifies its actual native UUID and saved ownership before
enablement or attach. Reuse a saved owner or pending handoff; do not create
duplicates or Desktop replacement workers. Complete initial user decisions
through $conductor:ask-user before enabling observation. Preserve and verify
paused admission before any dispatch; separately authorized execution activates
admission only after decisions are integrated.

For a plugin rollout, finish bundle edits, checks and publication before refresh,
hook trust and required configuration/instruction checks. Create replacement
director chats only afterward. Keep that installed bundle unchanged through
handoff and lifecycle verification. Never refresh beneath active turns or into
another environment without authority.

The coordinator owns integration and authorized issue writes; background delivery
uses its existing deterministic owner. Reconcile helpers and pending operations
before completion, cancellation or handoff. Report observed state separately from
assumed readiness, then stop when authorized work and delivery are complete.
