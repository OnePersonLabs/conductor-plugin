# Conductor

Conductor takes a change from exploration through planning, implementation,
review, and delivery. Work on a GitHub issue or an established local request.
Choose pair programming for human phase decisions, or explicitly direct a larger
scope synchronously or through background automation.

Local phase work needs a Git checkout, not GitHub or runner configuration.
Read-only exploration needs neither. Issue operations verify the target GitHub
repository and your authority. Background automation requires repository setup
through `$conductor:setup-repo-workflow` and explicit execution authority.
An existing invalid configuration must be repaired before dependent work.

An ordinary request such as “implement this plan” stays in the current chat and
within that request. It does not start or suggest a director, create a chat,
start a background runner, or take on the rest of the backlog. The agent reports
Conductor-driven issue changes with links and their effect on the work.

## Choose the work

| Skill | Example request | Result |
| --- | --- | --- |
| `$conductor:explore` | “Explore why this flow is awkward.” | Source-grounded investigation without implementation or automatic issue creation. |
| `$conductor:new-change` | “New issue: Keyboard navigation.” | A named issue with appropriate type and labels; no detailed plan yet. |
| `$conductor:propose-change` | “Propose keyboard navigation.” | An issue and an implementation-ready plan; stops before implementation. |
| `$conductor:plan-change` | “Plan the next phase for #12.” | Detailed next work, broad later phases, and observable acceptance. |
| `$conductor:apply-change` | “Implement the accepted plan for #12.” | Authorized implementation, checks, review and repairs. |
| `$conductor:update-change` | “Update #12 for the changes since it was planned.” | Reconciled planning against current source and decisions; no code edits. |
| `$conductor:continue-change` | “Continue #12.” | One coherent next planning, implementation or verification action. |
| `$conductor:verify-change` | “Verify #12 against its requirements.” | An advisory account of what is implemented, missing, or not verified. |
| `$conductor:review-change` | “Review this change and address the PR feedback.” | Independent findings; the original builder owns repairs. |
| `$conductor:close-change` | “Close #12.” | Closure when completion is established; otherwise a warning and confirmation. |
| `$conductor:open-change` | “Reopen Keyboard navigation.” | Reopens the matching issue, or warns that it is already open. |
| `$conductor:pair-program` | “Use a rolling wave workflow for this change.” | One task in phases, with human decisions between phases. |
| `$conductor:direct-workflow` | “Direct these issues synchronously.” | Autonomous continuation within the selected scope and authority. |
| `$conductor:report-phase` | “Generate the previous phase's result report.” | A tracked, standalone HTML report; no next-phase execution. |
| `$conductor:manage-issues` | “Split #12 into deliverable issues and record its dependencies.” | Updated issues, acceptance criteria, states, priorities, and native relationships. |
| `$conductor:ask-user` | “Walk me through the decisions blocking these issues.” | Questions in chat, recorded answers, and verified integration into the owning issues or specifications. |
| `$conductor:setup-repo-workflow` | “Configure this repository for Conductor.” | Prepared configuration without starting execution. |

Issue actions accept an ID, URL, or name. Without one, they use the current issue
established in this conversation and checkout. If that is unclear, Conductor
shows `[ID]: [name]` choices in descending issue-number order and asks for an ID.
It does not guess the newest issue. A bounded delegated planning assignment uses
`$conductor:plan-change`; its parent retains issue writes and decisions.

## Work in phases

`$conductor:pair-program` runs **plan → agree → implement → review and repair →
report → decide the next phase** for one issue or local request. The visible
coordinator keeps a managed work thread connected while it enters actual Plan
Mode, receives answers, compacts and changes to implementation mode.

Plans live in `.conductor/plans/`; standalone HTML reports live in
`.conductor/reports/`. Both are authored, Git-tracked records. A report explains
the phase just completed and does not start the next one. After committing the
report, the same reviewer checks its document delta and confirms the final
revision before delivery. See [phase work](plugins/conductor/references/phase-workflow.md)
and [managed work](plugins/conductor/references/managed-work.md).

## Choose how a director works

| Mode | Who does the work | Workspace and lifetime |
| --- | --- | --- |
| Ordinary work | The current agent and any authorized helpers | Current checkout; ends with the requested task. No director. |
| Pair programming | A visible coordinator and managed work thread, with independent review | Current checkout; human phase decisions; stops after the selected task. |
| Synchronous director (default when requested) | A visible coordinator directs the same phase capabilities across the selected scope | Current checkout; no background runner or routine human phase approvals. |
| Automated director (explicit opt-in) | A director chat and background coordinator manage original builder/reviewer threads | Isolated issue worktrees; event-driven recovery and delivery. |

When you explicitly request background automation and do not specify its chat, Conductor
asks whether to use this chat or a fresh one. Synchronous work stays in this chat.
Fresh director chats use `gpt-6.1-sol` at
`low` reasoning effort. An existing chat keeps its current model. A director
names itself `🎬 <project> <MM/DD/YYYY hh:mm AM/PM>` using local time, for example
`🎬 Psychord 11/06/2026 06:30 PM`. Former director chats remain visible unless
you ask to archive them.

Startup begins with `$conductor:ask-user`: inspect existing issues and recorded
answers, then surface useful unresolved decisions before implementation. It does
not repeat answered questions or invent a questionnaire when scope is clear.
Questions use native question cards or chat. The human-collaboration web inbox
starts only when explicitly requested; existing drafts and submissions remain
recoverable.

Synchronous operation does not bind a background director. If automation already
owns the repository, first reconcile and stop its work before using that checkout
synchronously. A saved stop or a dead runner alone does not prove workers ended.
Changes to an actively owned issue must go through its existing director's hold
or pause barrier before changing its scope, acceptance, or dependencies.

## Install and configure

Install the Codex plugin and CLI separately. The automated service requires
Node.js 24+, Git, authenticated GitHub CLI, and Codex App Server.

```powershell
codex plugin marketplace add 'C:\path\to\conductor-plugin'
codex plugin add conductor@conductor
npm install -g 'C:\path\to\conductor-plugin'
```

For background automation, use `$conductor:setup-repo-workflow`. Review its
`conductor.json`, label mapping, real verification commands, concurrency, and
delivery authority. Configuration preparation starts nothing. Use
`authorized: false` while preparing automation; local work needs no configuration.
Ordinary skills honor any configured repository conventions without enabling the
service. A linked worktree can use its main
checkout's setup when it has no local `conductor.json`. Run `conductor check-setup`
to inspect setup without starting anything. `conductor check-scope local` checks
local phase prerequisites; `conductor check-scope issues` also checks GitHub identity.
Windows and WSL use separate local runtimes; operate in the environment that owns
the work.

For automation, explicitly request the automated director and choose its chat.
Conductor checks the saved owner and pending handoff before creating anything.
The destination verifies the repository, authorized operation, expected prior
binding, and its actual native UUID before enablement or attachment. Initial
questions precede execution; existing holds and pauses remain in force. See
[workflow and recovery](plugins/conductor/docs/workflow.md) for the full path.

## Issue state and verified delivery

- `triage`: a concrete investigation is unfinished.
- `proposal`: a materially new or competing direction needs a decision.
- `ready`: accepted, bounded, sufficiently specified, authorized work; dependencies
  can still block execution.
- `on-hold`: deliberately suspended until its hold is released.
- `needs-input`: an additional label for an actual unresolved human dependency.

Use native blocked-by relationships for prerequisites and native sub-issues for
separate outcomes. Parent proposals and holds constrain descendants. Priority
orders compatible work; it does not select between incompatible directions.
Issue labels never authorize new product scope. Report delivery only after
acceptance, required checks/review, and landing in the configured base are verified.

Automated builders and reviewers start in separate contexts using the host's
configured permissions and tools. Requests use the normal explicit-answer path.
Review findings return to the original builder; revision checks prevent stale
clearance. An automated builder does not own GitHub writes or publication: the
coordinator retains those duties. Manual implementation follows the user's
requested delivery boundary.

## Automated runner controls

The Windows runner has a visible console with timestamped progress and errors,
also written to its rotating log. It reports meaningful changes and requests;
it does not print a periodic status heartbeat. Scheduled external reconciliation
defaults to 30 minutes, with earlier checks on events or explicit requests.
Local command and lifecycle checks do not poll GitHub at their one-second cadence.
An unchanged reconciliation does not start a model turn.

| Command | Effect |
| --- | --- |
| `conductor status` | Inspect saved service and recovery state. |
| `conductor stop` | Persist a runner pause, interrupt owned workers, and retain recovery. Ctrl+C and closing the console use the same stop path. |
| `conductor wakeup` | Restart observation without clearing the runner pause. |
| `conductor resume` | Clear the runner pause and continue eligible interrupted work, preserving separate issue pauses, holds, and admission restrictions. |
| `conductor resume ISSUE` | Reconcile and recover the original issue job through eligibility checks. |
| `conductor cleanup --preview` | Show worktree cleanup candidates and retention reasons. |
| `conductor cleanup` | Remove eligible delivered worktrees while the runner is stopped. |

Unexpected coordinator loss is treated as paused until explicit resumption.
Finished worktrees are cleaned after verified delivery and worker shutdown;
dirty, held, unfinished, and uncertain worktrees remain. Cleanup retains branches
and job history. Read the [delivery and cleanup guide](plugins/conductor/skills/apply-change/references/delivery.md)
before applying cleanup.

While automation owns a repository, the checkout hook warns unrelated chats in
the main checkout and rejects edits and commands with unknown effects. Recognized
inspection calls remain available. This is a guard over supported Codex hook
calls, not filesystem isolation; disabled hooks, existing interactive processes,
and external programs are outside its protection. See [checkout protection](plugins/conductor/docs/workflow.md#main-checkout-protection).

## Development and evidence

Run `npm run test:installed` for package validation, deterministic tests, and
installation in a temporary Codex home. This does not refresh the global plugin
or start production workers. Source checks, installed discovery, live hook
execution, and delivered work are distinct claims.

See [configuration](plugins/conductor/docs/configuration.md) for checks, labels,
models, reviewed design handoffs, and migration. For an authorized live rollout,
finish bundle changes, checks, and publication before refreshing and verifying
hook trust. Create replacement director chats only after the final bundle is
installed; keep it unchanged during handoff. A request to leave Conductor disabled
or skip global refresh takes precedence over that rollout procedure.
