# Direct work and recover Conductor

Local work needs a Git checkout; read-only exploration needs no setup. Issue
operations verify the GitHub repository and authority. Background automation
requires `$conductor:setup-repo-workflow` and explicit execution authority.
An existing malformed configuration cannot be bypassed. See
[configuration](configuration.md) for the operation-specific checks.

Use `$conductor:manage-issues`, `$conductor:ask-user`, `$conductor:plan-change`,
`$conductor:apply-change`, and `$conductor:review-change` during ordinary agent work.
They complete the requested scope in the current chat and report issue changes.
They never adopt the chat, start a director, or ask whether to start one merely
because a change was requested.

## Ordinary work and synchronous direction

For one issue or local request, `$conductor:pair-program` provides rolling-wave
planning, implementation, independent review and repair, and a phase report before
the human decides what follows. Explicitly invoke `$conductor:rolling-wave-report`
to report an existing phase independently, without executing more work or entering
a planning mode. Plans and reports are tracked under
`.conductor/plans/` and `.conductor/reports/`; the issue keeps high-level scope,
acceptance and native relationships. See [phase work](../references/phase-workflow.md).

`$conductor:continue-change` chooses one coherent next action from the current
issue's evidence. It does not start a director, reopen a closed issue or infer
permission to publish or close. `$conductor:verify-change` assesses acceptance;
`$conductor:review-change` supplies independent findings on the cumulative change.

An explicit director request defaults to synchronous operation. The current
agent coordinates the selected issues and managed phase work in the current
checkout, without creating worktrees, starting a background service, or binding
the automated runtime. End when the selected scope is complete or a human answer
is needed. Routine planning and phase continuation proceed within existing
authority without human checkpoints. There are no timer-driven turns in this mode.

Synchronous direction stays in the current chat. For background automation,
when the request does not specify a chat, ask whether to use the current chat or
a fresh director chat. Create a chat only after the user selects that option.
Use native project chat creation, model `gpt-6.1-sol`, and reasoning `low` for a
new chat. Rename an explicitly adopted current chat but keep its model. Use the
title `🎬 <project> <MM/DD/YYYY hh:mm AM/PM>` in the user's local time, for example
`🎬 Psychord 11/06/2026 06:30 PM`.

Begin with `$conductor:ask-user`: inspect accepted scope and saved answers, ask
the consequential unresolved questions in chat, and integrate answers before
dependent implementation. Do not invent questions or repeat resolved decisions.
An ordinary or synchronous chat records decisions directly on their issues using
the shared decision format; it does not call controls reserved for a bound
automated director. The web inbox is optional and starts only on explicit request.

Check for existing automation before writing in the same checkout. A saved
director binding does not authorize converting or stopping that director. Keep
its jobs, pauses, holds, pending human submissions, and original workers intact.
Switch modes only after an explicit request and verified shutdown/reconciliation.
An unrelated agent may inspect or plan an actively owned issue, but must obtain
the existing director's hold/pause barrier before changing its acceptance, scope,
or dependencies. GitHub readback alone cannot halt a worker or an armed merge.

## Main checkout protection

The checkout hook warns an unrelated main-checkout chat with a 🚨 message while
automation is active or worker termination remains uncertain. Recognized read
operations can continue. Edits and commands with unknown effects are denied with
an inspection alternative. Saved native director identity authorizes its own
calls and descendants; a title or a claim in a prompt does not grant ownership.
Workers retain their recorded workspace authority. An independent worktree can
be used for unrelated local work; shared issue and delivery ownership still applies.

This protection covers supported Codex hook calls. It does not isolate the
filesystem or stop external writers, already-running commands, existing terminal
input sessions, or calls that bypass hooks. Hooks must be loaded and trusted;
host hook failures or timeouts can also prevent enforcement. Arbitrary code from
an unguarded checkout can conceal a write target that the hook cannot inspect.
A missing runner
PID or pause flag alone does not prove that workers and delivery stopped.
With no active or uncertain automation, ordinary and synchronous work proceeds
without this guard.

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
into a focused human interaction, including blockers that were not previously
labeled. It explains the situation, terms, options and consequences in the selected interface
so the user does not need to know the agent's investigation or open issue links
to answer. Unlabeled issues enter triage. A prepared issue created from an
accepted plan may begin ready; new bug reports normally enter triage. The director
investigates, resolves planning gaps and applies supported transitions
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

## Enable and use the automated director

Set up the repository and review `conductor.json` first. Explicitly request
automated operation; an unspecified mode means synchronous. Resolve the requested
chat and inspect the saved owner and any pending handoff before creating another.
For a fresh native local project chat, supply `$conductor:direct-workflow`, automated
mode, repository, authorized operation, and expected prior binding. Use the
director title and model settings above.

The destination verifies its own actual UUID, repository, saved owner, and
pending handoff. Resolve initial human questions before enabling new execution;
keep initial admission paused when questions or execution authority remain
unresolved. Then enable with `conductor enable --host desktop --thread <its own
UUID>` or use the authorized attach path for an existing director. Verify the
saved binding and native completion before reporting startup complete. Existing
holds and admission/runner pauses must not be released as an onboarding shortcut.

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
about the candidate direction remains unresolved, keep the issue in `proposal`
and set `needsInput` true. Other human dependencies retain their appropriate
primary state with `needsInput` true. If an
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
answer. For example, a different unresolved candidate-direction choice keeps the issue in
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

Select Sol in the invoking director chat for ordinary coordination; the service
does not switch that chat's model. The director handles routine triage and backlog
repair. For a concrete hard architecture or substantial planning decision that
needs stronger reasoning, it deliberately selects the configured planner
(default Astra) through native subagent delegation. The assignment names the
unresolved decision, model, effort, context and required evidence. The director
explicitly selects `fork_turns: "none"` for the initial planner and independent
design reviewer, supplies a complete brief, and resumes their own sessions for
related follow-ups. Builders and code reviewers already start in separate fresh
App Server threads and retain their own context for repairs. The director
applies and verifies supported changes, rechecking current state and preserving
unrelated edits. If a required planner model is unavailable, it reports the
unfinished judgment and continues independent authorized work.

Native helpers can execute bounded local steps within an assigned builder job
when expected time or quality gains exceed briefing, coordination and integration
cost. Give each helper explicit ownership, required evidence and a stop condition.
Choose model, effort and context for the helper's task and integration cost;
an Astra parent alone does not select an Astra child. The builder integrates and
reconciles its descendants before completion or handoff. Conductor keeps durable
issue decomposition, dependencies, dispatch and delivery; helpers do not create
another project coordinator. OnePersonLabs can supply general task judgment on
its own or within this optional Conductor workflow. Optional Conceptor continues
to own product meaning and configured design handoffs.

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
analysis rather than triggering repeated planner calls or duplicate issue comments.

An ordinary request in an unbound chat authorizes work within that request,
including implementation when requested. The ordinary skills keep its issues
current and report their changes. Do not ask whether to start a director or
adopt the chat. Director operation requires an explicit request, defaults to
synchronous work, and binds the automated runtime only when automation is selected.

Use ordinary chat for questions, approvals and issue direction. Use the
`$onepersonlabs:human-collaboration` web inbox only when explicitly requested.
On that selected path, enroll the actual bound root as contribution owner and
use `connect --wake-root` so Web Send can notify it. End the turn while waiting.
A listener without wake notifications needs an authorized restart before
automatic pickup works; pending submissions remain recoverable.

The inbox brief identifies the issue decision and reviewed revision. On return,
claim the submission, check source drift, integrate the answer through the owning
issue decision path, and record the inbox outcome. The inbox owns submissions;
issue records own accepted decisions and their integration. An inbox draft or
queue receipt is not an integrated answer. Only blocking decision batches need
the automation interaction gate; optional reviews do not suspend admission.
Host-required approval interfaces remain in use.

If an inbox was selected, a director handoff must enroll the destination root
and bind its contributions through the human-collaboration procedure after
reconciling partial work. Conductor attach does not transfer those contributions.

## Move the director to another chat

For a plugin rollout, keep the current director active during preparation and
use this order:

1. Finish all bundle changes, checks and publication.
2. Refresh the Windows local installation, verify hook trust, and finish
   required post-refresh configuration and global-instruction checks. Do not
   refresh WSL or another local Codex home unless asked.
3. Create the fresh replacement chats and use the attach procedure below.
4. Verify the saved bindings and matching native start/Stop receipts. Preserve
   jobs, holds and admission pauses throughout. If human-collaboration inbox
   contributions exist, reconcile and bind them to the destination root through
   that skill's procedure; `attach` does not transfer inbox ownership.

Keep the installed bundle unchanged through handoff and verification. If a
follow-up change is needed, finish and refresh it before creating replacements
for that final bundle. Skills and documentation count as bundle changes too.
Reading updated instructions in an existing chat does not verify its retained
hook state. This ordering reduces exposure to retained configuration/trust;
it does not establish the cause of a missing receipt or require routine toggles.

Ask the current director “Move Conductor to a fresh chat”, or open a chat in
the same project and say “Make this the Conductor runner”. Both requests use
`$conductor:direct-workflow`. A fresh chat uses Sol 6.1 Low and the title
`🎬 <project> <MM/DD/YYYY hh:mm AM/PM>`. It reads current instructions and receives
the automated mode, repository, authorized operation, expected prior binding,
brief context, and relevant links rather than inheriting the old conversation.

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
After a successful handoff, the former director chat stays visible. Archive it
only on an explicit user request, after verifying ownership and outstanding work.
Pending handoffs retain the current owner. Builders, reviewers and worktrees are
unaffected. After replacement, old-chat controls are rejected; talking there does
not automatically reclaim ownership.

## Idle behavior, wakeup and restart

Worker outcomes, relevant issue changes and verified Conductor actions signal
the bound director. A local observer also reconciles external GitHub changes on
the configured interval, defaulting to 30 minutes. This check uses ordinary
code. If nothing changed, it does not start a model turn.

The terminal reports meaningful progress, waits, requests, and errors, without a
periodic status heartbeat. One-second local command and lifecycle checks do not
fetch GitHub. Events and explicit checks can reconcile GitHub before the scheduled
interval; the interval is not a promise that no earlier network request occurs.

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

Stopping Conductor pauses the local runner and automatic dispatch. Passive
issue-change signals do not restart a deliberately stopped runner. Bare
`conductor resume` restarts observation and clears only the runner-stop
pause; migration pauses, holds, job pauses and admission restrictions remain.
`conductor wakeup` observes and reports the paused reason and next action
without clearing it. Activate admission or release holds only through their
separate controls.

On Windows, keep the local runner's console visible to read timestamped progress.
Conductor rotates its existing log. `Ctrl+C` or closing the console persists the
runner-stop pause. Closing the console can interrupt stop processing; use the
saved pause as the recovery signal. Stopping the local runner does not stop a
separate hosted or remote director; inspect that host and use its own stop control.

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
closure. The independent reviewer reports findings; the original builder owns
implementation and repairs. Builder completion or a successful
push does not establish acceptance or delivery.

The reviewer receives a direct review prompt with the PR, linked issue,
worktree branch, merge target and checked commits. It checks actionable defects
and acceptance, citing applicable repository rules when they support a finding.
It does not depend on an additional review skill. The coordinator turns its
structured result into readable PR feedback.

Builder and reviewer requests use the same explicit-answer flow. Answer in the
director chat or enter the displayed `answer ISSUE:REQUEST VALUE` command in the
runner console. Pressing Enter alone checks for changes without answering a request.

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
After verified delivery, startup and maintenance automatically clean eligible
completed worktrees. Cleanup candidates and the full deletion boundary are in the
[PR delivery guide](../skills/apply-change/references/delivery.md#completed-worktree-cleanup).

See [configuration](configuration.md) for repository labels, checks and
migration. The [shared workflow](../references/workflow.md) supplies issue rules
for ordinary skills and explicit director operation.
