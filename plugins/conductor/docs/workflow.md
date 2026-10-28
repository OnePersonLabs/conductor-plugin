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
primary state but prevents the affected work from advancing. Unlabeled issues
enter triage. A prepared issue created from an accepted plan may begin ready;
new bug reports normally enter triage. The director uses Astra to investigate,
resolve planning gaps and apply supported transitions toward ready. Ordinary
missing details do not require a proposal or user approval. Keep triage for an
unfinished investigation and needs-input for an actual human dependency, not
uncertainty the agents can resolve. A label never grants authority for new
product scope.

Native blocked-by dependencies control prerequisites. A ready issue with an
open blocker waits; when prerequisites close, Conductor rechecks the issue and
can admit it without relabeling. A blocker closed as rejected or abandoned needs
reconciliation because closure alone does not prove its acceptance was met.

Parent issues in proposal or on-hold state constrain implementation of their
descendants. Holds can cover an explicit set or hierarchy. Conductor records the
previous primary state when applying a hold and restores it on explicit release.
Releasing a hold does not accept a proposal.

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

It asks you only when materially conflicting goals, a consequential choice it
cannot reasonably infer, missing authority or evidence only you can provide
blocks progress. It completes independent work and brings a concrete recommendation
with the remaining question. Resolved questions and obsolete blockers are reconciled
from evidence. Defining acceptance criteria does not demonstrate their satisfaction;
completion still requires the appropriate evidence and verified delivery. Durable
meaning stays with the project's existing owner. Unchanged evidence reuses valid
analysis rather than triggering repeated Astra calls or duplicate issue comments.

Use ordinary chat for questions, approvals and issue direction. The optional
`$onepersonlabs:human-collaboration` inbox can carry longer reviews or phone
responses; it is not required. An inbox draft is not a submitted answer.

## Move the director to another chat

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
The old chat remains available; archiving is separate. After replacement, its
controls are rejected. Talking there does not automatically reclaim ownership.

## Idle behavior, wakeup and restart

Worker outcomes, relevant issue changes and verified Conductor actions signal
the bound director. A local observer also reconciles external GitHub changes on
the configured interval, defaulting to 30 minutes. This check uses ordinary
code. If nothing changed, it does not start a model turn.

The service checks the director's actual host status. If it is idle, Conductor
sends one wakeup to reconcile current state. If the director is already
working, changes remain pending for its next check; Conductor does not flood
the same session with additional wakeup messages. Before ending a turn with no
further immediate action, including after presenting a blocking question,
request fresh `status`, inspect its issue/job state
and pending events, then submit `settle` with that response's exact
`checkRevision`. Settling acknowledges only events through the inspected
snapshot. If it returns `idle: false`, request status again and repeat the
inspection and settle in the same turn. If it returns `idle: true`, finish the
turn with: “Conductor is idle. Say ‘wakeup’ to manually wake Conductor.” Only
finishing the turn makes the host thread idle; `settle` does not.

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
