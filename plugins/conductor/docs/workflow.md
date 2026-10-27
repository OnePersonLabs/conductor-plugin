# Direct work and recover Conductor

Conductor uses a conversational director for planning and issue management, with
a local deterministic service for dispatch, worker lifecycle and delivery. The
director is your ordinary chat. The service can remain active after the
director finishes a turn. Installation and setup never start it.

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
new bug reports normally enter triage. A label never grants authority for new
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

## Start and use the director

Set up the repository and review `conductor.json` first. Start the observer
explicitly and bind the current Codex thread as its director:

```powershell
conductor start --thread THREAD_UUID
conductor status
```

The start receipt confirms launch was requested; check `conductor status` and
the service log to confirm the owner process is actually running before telling
the user observation is live.
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
for substantial planning; the service does not switch the chat's model. It investigates facts, reads
project instructions and decisions, recommends issue changes and discusses
consequential choices with you. It then records accepted meaning with the
project's existing owner and manages GitHub's work state. It does not turn an
agent-discovered idea into authorized product scope by itself.

Use ordinary chat for questions, approvals and issue direction. The optional
`$onepersonlabs:human-collaboration` inbox can carry longer reviews or phone
responses; it is not required. An inbox draft is not a submitted answer.

## Idle behavior and wakeups

Worker outcomes and verified Conductor actions signal the director. A local
observer also reconciles external GitHub changes on the configured interval,
defaulting to 30 minutes. This check uses ordinary code. If nothing changed, it
does not start a model turn. Events are queued to the same director session and
acknowledged when handled. A queued message is not evidence that it was
consumed.

Startup is explicit. No login task is installed. After a restart, start the
observer and inspect status; it reconciles pending events and original worker
ownership before dispatch. Never start a replacement builder when saved thread
or process ownership is uncertain.

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

See [configuration](configuration.md) for repository labels, checks and
migration. `$conductor:director` is the interactive entry point;
`$conductor:github-workflow` documents issue and delivery rules.
