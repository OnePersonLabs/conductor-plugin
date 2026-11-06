# Automated director lifecycle

Read this reference only for explicitly selected full automation, bound runtime
controls or an authorized handoff. Synchronous director work and ordinary skills
do not need the service. The runtime owns admission, jobs, delivery and local
recovery; GitHub owns acceptance and workflow state.

## Start safely

Resolve the actual checkout, origin, effective instructions, `conductor.json`,
saved director UUID, pending handoff, jobs, holds, admission and runner pauses.
Preserve the original builder, reviewer, branch and worktree through repair.
Reuse the saved binding or pending destination. A title or skill invocation does
not establish ownership. Do not stop existing automation or silently replace it.

For first enablement, complete `$conductor:ask-user` through the direct GitHub/chat
path before running `conductor enable`. Initial setup must keep
`admissionPaused: true`; verify that configuration and any existing saved runtime
state before startup. If a saved active binding exists, use its control and
interaction path rather than treating this as a new start. A live configuration
edit is not proof that admission is paused. If the required pause cannot be
established through the existing owner, report the blocker before enabling.

The onboarding instruction must identify mode, repository, authorized operation
and expected prior binding. The onboarding chat checks its actual native UUID,
current owner and pending handoff before enabling or attaching. First enablement
uses `conductor enable --host desktop --thread <actual UUID>` only within that
authority. Verify the resulting binding and paused admission before reporting
startup or issuing execution controls. Keep prior restrictions intact. Admission
activation is separate: use `activate` only after the required decisions are
integrated and execution is authorized; never clear a prior user pause by inference.

For a bound chat, `conductor observe` ensures observation without ending an
interaction. `conductor wakeup` requests observation and ends an interaction only
when it is an explicit human wake request. It reports a runner-stop pause without
clearing it. Bare `conductor resume` clears that runner pause when authorized,
while preserving holds, admission restrictions and job pauses. `conductor resume
ISSUE` is individual-job recovery. Do not use wake or resume to grant new scope.

Use `conductor rpc --request-file REQUEST.json` for runtime controls. Requests
include `repository` and the actual bound `threadId`; operations use current
issue `expectedRevision`, decision revisions or snapshot `checkRevision` as
applicable. Read fresh state after a stale revision rather than replaying it.
Do not edit runtime recovery files directly.

## User decisions in an existing bound director

1. Start or rejoin `interaction-begin` with a stable semantic `batchKey` for the
   unresolved decision batch. Reuse the same key for unchanged work. Inspect the
   returned interaction and current restrictions before foreground dispatch.
2. Use `decision-read` for each issue; it enrolls the issue in the batch. Recover
   its current records before asking. Use `decision-record` with its current
   decision revision for `pending`, `answered` or `deferred` stages. Record an
   explicit answer before applying effects. Questions and answers remain in the
   current chat unless the user explicitly selected another interface.
3. Update and verify the existing meaning owner. Use `decision-integrate` with
   current decision and issue revisions, the same answer/context and verified
   `integration` evidence. It reconciles state and `needs-input` while preserving
   holds. A deferred record requires the user's response and `returnCondition`.
4. Complete only when enrolled issues have no pending or answered decisions.
   Reconcile current events and call `interaction-complete` with the actual
   `interactionId` and current `checkRevision`. A changed snapshot requires fresh
   inspection. A question alone or event settlement does not end the gate.

End the turn with blocking questions visible. Existing independent workers may
continue; retain their events for reconciliation without burying the questions in
status chatter. Do not poll the user or repeat unchanged questions. An explicit
human wakeup can end the batch early and preserves unanswered records. Internal
messages and queue receipts are reconciliation requests, not answers or authority.
Do not immediately reopen the same unchanged batch after an explicit wakeup.

## Scope, dispatch and delivery

Before a contract edit affecting active implementation or delivery, establish the
local `hold` barrier through this bound director and verify GitHub hold states.
Preserve its exact `holdId` and prior primary states, reconcile workers and remote
operations, then make authorized edits. Only this director may release a temporary
barrier it introduced solely for the repair, after verified reconciliation.
User-requested holds need explicit release. Release never accepts a proposal,
clears another hold or activates admission. Partial hold failure retains the local
barrier. Routine idle-issue repairs need no blanket hold.

Dispatch only accepted, authorized, bounded ready work with no human-input block,
open native prerequisite, active hold/proposal ancestor, stale revision or duplicate
job, and within available capacity. Request fresh status and use the issue's
`expectedRevision`. If configured, obtain the reviewed design handoff before launch;
repair missing or stale handoffs through their original owner, then resume the
original job. A recovered analysis is not a reason to buy a duplicate review.

The deterministic coordinator owns push, PR creation, feedback routing, merge and
acceptance-based issue closure. Automated builders make no GitHub or publication
writes. Reviewers use the same configured permissions and tools as builders;
their role is findings, with original-builder implementation and repairs. Require
current checks, current review, complete acceptance and verified landing in the
configured base before reporting delivery. See [delivery](../skills/implement/references/delivery.md).

## Hand off an automated director

Use the director skill's explicit current/fresh choice and title convention.
When the user selects a fresh chat, create a native local project chat without
forking history. Supply the mode, repository, operation, expected prior binding,
brief decision context and existing source links. Use native APIs, not UI
automation or shared-daemon replacement threads. Do not create another chat when
the saved owner or pending destination should be reused.

The destination verifies its UUID and prior binding, then requests
`conductor attach --host desktop --thread <its own UUID>`. From the old active
director, finish the current operation and end the turn after arranging the
handoff; waiting while keeping it active prevents completion. A pending attach is
not ownership. The replacement waits for its UUID to become the saved binding
before controls. End its turn on a pending result and let the service reconcile;
do not keep a model polling loop alive. Repeating the same destination resumes
the request. Reconcile competing or uncertain handoffs before any replacement.

Attach preserves jobs, holds, admission pauses and worker identity. Never use
`conductor stop` to transfer a director; it also stops workers. A stopped service
does not prove the old chat idle. Once ownership changes, the old chat cannot
reclaim it without a new explicit request. Preserve pending human contributions;
if the user selected the optional inbox, reconcile and transfer contribution
ownership through its existing bind procedure. Attach alone does not do that.
Do not automatically archive the previous director or other chats.

## Settle and lifecycle recovery

Outside an active interaction, request fresh `status`, inspect issues, jobs,
holds, requests, restrictions and its `checkRevision`. Fetch `events`, reconcile
each against current state, and complete supported authorized repairs or record
the concrete remaining dependency. Submit `settle` with that inspected revision.
If it returns `idle: false`, inspect the changed snapshot and repeat in this turn.
An active interaction can itself keep `idle: false`; do not settle-loop to bypass
that gate. When settled and idle, end the turn; native completion establishes
host idle, not the settle receipt. Say: “Conductor is idle. Say ‘wakeup’ to manually
wake Conductor.”

Lifecycle hooks report actual `UserPromptSubmit`, `Stop` and `Interrupt` receipts.
Missing or unknown activity suppresses automatic wakes; never synthesize idle.
For `lifecycle-receipt-missing`, inspect native chat state and hook execution before
resuming. Native queue delivery exercises lifecycle hooks; cross-chat messaging
can bypass `UserPromptSubmit`. Use native queue APIs for lifecycle-qualified
follow-ups. Do not prescribe routine restarts or hook toggles without diagnosis.
The service queues wakes only when the director is known idle. Desktop must be
available to consume them; the service does not launch its private server.

The observer reconciles external GitHub changes on the configured interval
(30 minutes by default), without a model
turn when unchanged. An active director retains new events for its next check.
Signals and successful turns are not evidence of complete delivery or lifecycle
qualification. Report missing receipts and unresolved recovery explicitly.
