# Direct work and recover Conductor

Conductor uses a conversational director for planning and issue management, with
a local deterministic service for dispatch, worker lifecycle and delivery. The
director is one persistent chat bound to the repository. Explicitly enabling a
configured repository creates that chat if needed and starts observation.
Installation and preparing configuration alone do not enable it.

## Issue states

Configure the repository's existing label equivalents in `conductor.json`.
Conductor uses one primary state per issue:

| State | Effect |
| --- | --- |
| `triage` | Investigate an issue and determine its useful next step. |
| `proposal` | Discuss and refine an unaccepted direction; do not implement it. |
| `ready` | Accepted, bounded work that may dispatch after dependency and authorization checks. |
| `on-hold` | Suspend autonomous execution until explicit release. |

`needs-input` marks a specific unresolved human question. It can accompany a
primary state but prevents the affected work from advancing. When useful human
input can unlock or clarify work, Conductor proactively gathers those questions
into a focused chat interaction, including blockers that were not previously
labeled. It explains the situation, terms, options and consequences in the chat
so the user does not need to know the agent's investigation or open issue links
to answer. Unlabeled issues enter triage. A prepared issue created from an
accepted plan may begin ready; new bug reports normally enter triage. The director
uses Astra to investigate, resolve planning gaps and apply supported transitions
toward ready. Ordinary missing details do not require a proposal or user approval. Keep triage for an
unfinished investigation and needs-input for an actual human dependency, not
uncertainty the agents can resolve. A label never grants authority for new
product scope. Once a proposal's candidate direction is accepted or otherwise
resolved, Conductor moves the issue to an appropriate primary state and removes
`proposal`. Acceptance may make sufficiently bounded and authorized work ready;
rejection can return it to triage or close it when the work is no longer wanted,
but does not authorize implementation. When the user has answered the remaining
human questions, Conductor removes `needs-input`. Partial answers retain the
label only while a specific human dependency remains.

Native blocked-by dependencies control prerequisites. A ready issue with an
open blocker waits; when prerequisites close, Conductor rechecks the issue and
can admit it without relabeling. A blocker closed as rejected or abandoned needs
reconciliation because closure alone does not prove its acceptance was met.

Parent issues in proposal or on-hold state constrain implementation of their
descendants. Holds can cover an explicit set or hierarchy. Conductor records the
previous primary state when applying a hold and restores it on explicit release.
Releasing a hold does not accept a proposal.
Routine reconciliation of idle issues does not create holds. When the director
needs a temporary barrier to revise active work safely, it owns releasing that
barrier after verified repair and recovery. User-requested holds still require
your explicit release; neither path activates paused admission.

If a PR lands while a hold is being applied, the receipt reports that race.
Release the hold and use the `reconcile` control with the issue's current
`expectedRevision` to verify the landed commit and acceptance. This does not
start another builder. Use `resume` for work whose PR has not landed.

## Enable and use the director

Set up the repository and review `conductor.json` first. In Codex Desktop,
explicitly enable Conductor for this repository. If the current chat is already
the saved director, reuse it. Otherwise create a persistent local project chat
using Codex's native thread creation, name it `Conductor: <product name>`
(for example, `Conductor: Steady Helm`),
and start it with `$conductor:director`. Its initial instruction must make its
first action `conductor enable --host desktop --thread <its own UUID>` before
it inspects issues or dispatches work. Wait for that native thread's
completion/status and verify the exact UUID is saved as the repository binding
before reporting enablement complete. This keeps the new director from starting
work before it is bound.

Enabling uses the existing bound director chat or binds the supplied Desktop
thread when no director is bound. It starts the local observer. Check
`conductor status` to confirm the service and director before assuming
observation is active. The existing `conductor start --thread UUID` command
remains available to bind and start an existing daemon-owned director for
terminal clients.

Desktop is the primary interactive surface. Lifecycle hooks report when its
director chat is active, idle or interrupted; the observer uses those signals
to suppress wakeups while the director is active. Unknown host status suppresses
automatic wakeups; Conductor never assumes unknown means idle. Trust the plugin
hooks when Desktop requests hook review. Routine plugin refresh does not
establish a need to restart Desktop. Diagnose missing receipts against actual
event delivery and execution before prescribing reloads. Do not bind
a Desktop chat to the shared-daemon proxy or infer its live status from that
proxy. The proxy limitation is recorded in the [runtime selection
evidence](../../../docs/runtime-selection-2026-10-20.md).
The control interface accepts a JSON request file from the same repository. It
checks repository and bound chat identity and saves a receipt for each operation.
Use the `status` control operation for a fresh issue snapshot and its revision;
the CLI `conductor status` command shows saved service and recovery state. For
example, request current issue status with this control JSON:

```json
{
  "op": "status",
  "repository": "owner/repository",
  "threadId": "THREAD_UUID"
}
```

A state transition uses the returned revision:

```json
{
  "op": "transition",
  "repository": "owner/repository",
  "threadId": "<bound-chat-uuid>",
  "issue": 42,
  "state": "ready",
  "expectedRevision": "<revision-from-status>"
}
```

Submit control JSON with `conductor rpc --request-file REQUEST.json`. The
director can issue these controls through the installed runtime interface; the
CLI remains available for direct operation and recovery.

A focused question batch has a durable runtime gate and issue-owned decision
records. Start or rejoin a batch using a stable semantic `batchKey` that describes
the unresolved decisions, not an event revision. `status` returns the active
interaction. During it, `dispatch` and `resume` are rejected while existing
independent workers continue. Normal observer startup preserves the gate; only
finishing the batch or an explicit `wakeup` releases it.

Before asking, read the owning issue's decision records. `decision-read` enrolls
that issue in the active interaction, so it cannot be skipped when completing the
batch. Record each self-contained question with `decision-record` and its current
decision revision:

```json
{
  "op": "decision-record",
  "repository": "owner/repository",
  "threadId": "THREAD_UUID",
  "issue": 42,
  "decisionId": "session-time-effects",
  "expectedRevision": "<revision-from-decision-read>",
  "record": {
    "context": "Free play can advance the player's practice clock while the shared world clock stays still.",
    "question": "Should personal practice time continue while the group world is paused?",
    "status": "pending"
  }
}
```

Record a nonempty `answer` with status `answered` before integrating it. Once
the owning meaning and issue acceptance are updated, use `decision-integrate` to
persist the final stage and reconcile the issue's primary state and `needs-input`
modifier in one revision-checked operation. Supply the current decision revision,
current issue revision, the integrated record with the same answer and verified
`integration` evidence, the appropriate primary `state`, and whether any human
input remains in `needsInput`. This operation verifies the prior answer and
current revisions before writing; it preserves active holds. If another decision
remains unresolved, keep the issue in `proposal` and set `needsInput` true. If an
accepted proposal is now bounded and authorized, it can move to `ready`; use
`triage` when investigation remains. A rejected direction is updated or closed
according to its outcome before integration, and must not become ready merely
because the decision is resolved. A `deferred` decision needs the user's explicit
response and a `returnCondition` explaining when to reopen it. `decision-read`
returns the latest stage for each stable `decisionId`; issue comments preserve
these records if the director chat is replaced. Use fresh revisions and verify
the returned record and issue labels before moving on.

For an accepted and integrated answer, the revision-checked reconciliation shape
is:

```json
{
  "op": "decision-integrate",
  "repository": "owner/repository",
  "threadId": "THREAD_UUID",
  "issue": 42,
  "decisionId": "session-time-effects",
  "expectedRevision": "<revision-from-decision-read>",
  "expectedIssueRevision": "<revision-from-status>",
  "record": {
    "context": "Free play can advance the player's practice clock while the shared world clock stays still.",
    "question": "Should personal practice time continue while the group world is paused?",
    "status": "integrated",
    "answer": "Yes, personal practice advances independently.",
    "integration": "Updated the accepted session-time contract and verified the issue's acceptance and labels."
  },
  "state": "ready",
  "needsInput": false
}
```

Choose `state` and `needsInput` from the remaining work after reconciling the
answer. For example, a different unresolved human choice keeps the issue in
`proposal` with `needsInput: true`. The accepted meaning owner remains the source
of product decisions; this operation reconciles its issue status.

Begin a batch with `interaction-begin` and its stable key. Complete it only after
all enrolled issues have no pending or answered decision records and the current
event snapshot has been reconciled:

```json
{
  "op": "interaction-complete",
  "repository": "owner/repository",
  "threadId": "THREAD_UUID",
  "interactionId": "<id-from-status>",
  "checkRevision": 12
}
```

Completion settles the inspected event revision and releases the execution gate.
If events changed during settlement, refresh status and reconcile them before
retrying. While the interaction gate is active, `settle` may report `idle: false`
by design; that does not mean the inspected events were missed, and settlement
does not release the gate. Explicit `wakeup` can release an active batch early;
unanswered records remain, and Conductor will not reopen that unchanged batch
automatically. A materially changed decision or new user request can create a
new batch.

After a migration, the service starts with admission paused. Explicitly enable
it only after reviewing the migrated issue states:

```json
{
  "op": "activate",
  "repository": "owner/repository",
  "threadId": "THREAD_UUID"
}
```

Select Sol in the invoking director chat for ordinary coordination. The skill
uses native subagent delegation with the configured Astra planner preference
for triage, backlog repair and substantial planning; the service does not switch
the chat's model. Astra investigates facts, reads project instructions and
decisions, and returns concrete supported changes. The director applies and
verifies them before settling, rechecking current state and preserving unrelated
edits. If Astra is unavailable, the director reports the unfinished judgment
instead of silently substituting another model.

Conductor acts within accepted goals and existing authority: it chooses reasonable
approaches and reversible planning assumptions, defines acceptance criteria and
prepares the next connected work without asking you to approve routine details.
It uses evidence and consequences rather than a list of allowed fixes. Admission
pauses do not prevent otherwise authorized preparation; explicit holds and broader
read-only instructions still apply. A ready label does not lift these restrictions.

It asks you when materially conflicting goals, a consequential choice it
cannot reasonably infer, missing authority or evidence only you can provide
blocks progress. It first completes discoverable investigation and independent
preparation, then brings a recommendation with enough plain-language context for
you to decide without following the investigation. It prioritizes decisions that
can unblock several tasks, and follows up when answers reveal another useful
choice. Conductor records each answer and integration progress on the owning issue
before asking the next question. A replacement director resumes from those
records, so completed questions are not repeated. The same unchanged batch is
not reopened after explicit `wakeup`; a materially changed decision or new user
request can create a new batch. Answers resolve decisions; they do not establish
evidence for outcomes that still require testing or human qualification. Defining
acceptance criteria does not demonstrate their satisfaction; completion still
requires the appropriate evidence and verified delivery. Durable meaning stays
with the project's existing owner. Unchanged evidence reuses valid
analysis rather than triggering repeated Astra calls or duplicate issue comments.

Use ordinary chat for questions, approvals and issue direction. The optional
`$onepersonlabs:human-collaboration` inbox can carry longer reviews or phone
responses; it is not required. An inbox draft is not a submitted answer.

## Move the director to another chat

For a plugin rollout, use this order:

1. Finish all bundle changes, checks and publication.
2. Refresh the installed plugin, verify hook trust, and finish required
   post-refresh configuration and global-instruction checks.
3. Create the fresh replacement chats and use the attach procedure below.
4. Verify the saved bindings and matching native start/Stop receipts. Preserve
   jobs, holds and admission pauses throughout.

Keep the installed bundle unchanged through handoff and verification. If a
follow-up change is needed, finish and refresh it before creating replacements
for that final bundle. Skills and documentation count as bundle changes too.
Reading updated instructions in an existing chat does not verify its retained
hook state. This ordering reduces exposure to retained configuration/trust;
it does not establish the cause of a missing receipt or require routine toggles.

Ask the current director “Move Conductor to a fresh chat”, or open a chat in
the same project and say “Make this the Conductor runner”. Both requests use
`$conductor:director`. A fresh chat is named `Conductor: <product>` and reads
current instructions; it receives brief context and relevant links rather than
inheriting the old conversation.

The underlying command, run from the configured repository, is:

```powershell
conductor attach --host desktop --thread DESTINATION_CHAT_UUID
```

Conductor validates the destination and preserves workers, their workspaces,
pending events, holds and admission pauses. Attaching the current director is
a no-op. An idle or interrupted director can be replaced after its obsolete
queued wakes are reconciled. An active director receives a lifecycle-hook
instruction to finish its current operation and end the turn; the binding
switches after that turn ends. New wakes wait during this handoff.

Check the saved binding before using the replacement as director. If activity
is unknown or queue cancellation cannot be reconciled, the handoff stays
pending with the blocker reported. Fix that blocker and repeat the same
command. Repeating the same destination resumes the handoff; a competing
destination cannot silently replace it. Service restart retains the pending
request, but a stopped service does not prove the old chat is idle.

Do not use `conductor stop` for a chat handoff, because it also stops workers.
After a successful handoff, the replacement automatically archives the old
director through the native app operation, preserving its conversation history.
It verifies the saved binding, completed recovery and absence of active turns or
queued user input first, using the old UUID from the attach receipt or event.
Pending handoffs retain the current owner. Builders, reviewers and worktrees are
unaffected. Ask to keep the old chat visible if you want to retain it in the
sidebar. Archive failures are reported for reconciliation during an ordinary
check. After replacement, old-chat controls are rejected; talking there does
not automatically reclaim ownership.

## Idle behavior, wakeup and restart

Worker outcomes, relevant issue changes and verified Conductor actions signal
the bound director. A local observer also reconciles external GitHub changes on
the configured interval, defaulting to 30 minutes. This check uses ordinary
code. If nothing changed, it does not start a model turn.

The service checks the director's actual host status. If it is idle, Conductor
sends one wakeup to reconcile current state. If the director is already
working, changes remain pending for its next check; Conductor does not flood
the same session with additional wakeup messages.

When current work has useful human decisions or other input to resolve, Conductor
opens a persistent interaction phase before resuming foreground execution. It
keeps questions as the visible foreground conversation while independent workers
continue. Worker events and internal Conductor messages queue quietly. The phase
survives turn endings and does not repeat unanswered questions. Every answer is
stored with its owning issue and integrated before the next question. The user
can say `wakeup` to end the interaction early; unanswered decisions remain
recorded and the same unchanged batch is not immediately reopened. Once no useful
human contribution remains, Conductor reconciles queued events and automatically
continues eligible authorized work, while preserving explicit admission pauses
and holds.

Outside that interaction phase, before ending a turn, request fresh `status`,
inspect issue/job state and pending events, then submit `settle` with the
response's exact `checkRevision`. Settling acknowledges only events through the
inspected snapshot. If it returns `idle: false`, request status again and repeat
inspection and settling in the same turn. If it returns `idle: true`, finish the turn with:
“Conductor is idle. Say ‘wakeup’ to manually wake Conductor.” Only finishing the
turn makes the host thread idle; `settle` does not.

Say `wakeup` in the Desktop director chat, or run `conductor wakeup` from the
configured checkout, to ensure the service is available and ask it to check
current work. The Desktop activity hook marks this interaction active, so the
service does not queue a redundant wakeup. After a system restart, a Conductor
interaction starts observation again and reuses the saved director. Local issue
activity starts the service as needed; GitHub-only changes made while the local
service is down are found on wakeup or the next reconciliation. No login task
or remote webhook receiver is installed.

When Desktop is closed or its private server is unavailable, the background
observer cannot launch or resume that server. A submitted wakeup is stored in
the native session queue for Desktop to consume when it loads the bound chat.
Automatic delivery across Desktop or system restart still needs a live trial;
if work has not resumed, open the saved director chat and say `wakeup`.
Terminal-hosted directors continue to use the shared daemon path.

Explicitly stopping Conductor disables automatic dispatch and wakeups. Passive
issue-change signals do not restart a deliberately stopped service. Manual
wakeup can restart observation but retains the admission pause established by
the stop, migration pauses, and issue holds. Activate admission or release
those states explicitly.

If a runner turn is interrupted or fails, inspect status and its recovery
receipt. Conductor preserves the original builder, reviewer, branch and
worktree. A wakeup can ask the director to diagnose saved state; `resume ISSUE`
is the explicit command to continue an interrupted issue job once reconciled.
Do not treat a replacement director as permission to replace a worker.

If status reports `queue-cancellation-failed`, an obsolete wake could not be
removed from Desktop's queue. Restore the host connection, then send the
`retry-wakeup` control with the reported `batchId`. For a saved cancellation,
this retries deletion of the same queue item rather than submitting a new wake.
Refresh status and settle the inspected revision after recovery.

## Pause, hold and release

To revise issues without dispatch racing ahead, ask the director to hold the
affected issues or parent hierarchy. For example, the control request can be:

```json
{
  "op": "hold",
  "repository": "owner/repository",
  "threadId": "<bound-chat-uuid>",
  "issues": [20, 24],
  "descendants": true,
  "reason": "Revise the shared design"
}
```

The returned `holdId` identifies this hold. The service saves its local
execution barrier before enumerating descendants and applying GitHub labels.
Descendants are held explicitly, and ancestor holds also constrain admission.
If a label operation fails partway, the barrier remains and status identifies
what needs recovery. Reconcile active jobs before editing.

An active hold interrupts the current turn while preserving its original
thread, branch and worktree. A remote operation or merge already in progress
may need reconciliation; status reports what was confirmed. Release explicitly
through the director. It restores the recorded prior state and rechecks current
dependencies and decisions before dispatch.

Release with `{"op":"release","holdId":"<returned-hold-id>"}`. Nested holds
remain active until each is released. To suspend all execution while changing a
broader set, use a hold with `"all": true`; release it with its returned
`holdId` after the work is reconciled.

`stop` disables automatic dispatch and wakeups while retaining recoverable
state. It does not delete worktrees or erase issue history. `resume ISSUE`
continues an owned stopped or blocked job only after current issue and workspace
state are reconciled. Read the displayed status before retrying uncertain work.

## Worker delivery and recovery

For each admitted issue, the service creates an isolated branch and worktree,
runs configured preparation and checks, and starts or resumes the original
builder session. The coordinator retains ownership of publishing branches,
opening PRs, routing review and failed-check feedback, merging, and issue
closure. Independent review is read-only. Builder completion or a successful
push does not establish acceptance or delivery.

The reviewer receives a direct review prompt with the PR, linked issue,
worktree branch, merge target and checked commits. It checks actionable defects
and acceptance, citing applicable repository rules when they support a finding.
It does not depend on an additional review skill. The coordinator turns its
structured result into readable PR feedback.

The issue's acceptance, dependencies and project instructions are rechecked
when relevant inputs change. The configured checks must pass on the current
integrated branch; required review and approvals must be satisfied. Closure
follows confirmed landing in the configured base and complete issue acceptance.
A closed unmerged PR or uncertain launch remains blocked for explicit
reconciliation.

Machine recovery data lives under `conductor/` in the Git common directory,
outside tracked project files. Preserve the state, original thread IDs,
branches and per-issue worktrees while diagnosing interruptions. Windows and
WSL have distinct process, Git and Codex ownership; recover in the environment
that created the work.

Generated recovery receipts are temporary. Completed control receipts expire
after their seven-day retry window; stale request IDs are rejected rather than
replayed as new operations. Pending jobs, holds and uncertain delivery state
remain until reconciled. The feedback receipt helper expires ordinary handoffs
after seven days, and requires fresh remote checks before
resuming stale work. Remove completed receipts after verifying the remote
effects. Retain only unresolved human residuals with their existing issue/PR
owner. Cleanup runs at service startup and during normal maintenance; stopped
repositories are cleaned on the next invocation, so no off-process timer is
promised.

See [configuration](configuration.md) for repository labels, checks and
migration. `$conductor:director` is the interactive entry point;
`$conductor:github-workflow` documents issue and delivery rules.
