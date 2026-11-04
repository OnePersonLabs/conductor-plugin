# Conductor

Conductor is a conversational director for issue-driven project work. In chat,
it autonomously triages reports, prepares accepted work, repairs the backlog,
manages holds and directs implementation. The director handles routine triage
and uses the configured planner (default Astra) for hard decisions when justified.
It applies and verifies supported changes. It asks you when a concrete
human dependency remains, with a recommendation, rather than requiring approval
for routine planning within accepted goals. It batches useful questions in chat
and records answers on their issues so interrupted or replaced chats can continue
without repeating resolved decisions. A small local service handles worker ownership,
capacity, events, recovery and delivery. When nothing needs attention, the
director ends its turn; an unchanged idle check does not call a model.

Issues move through familiar workflow states: `triage`, `proposal`, `ready` and
`on-hold`. A `needs-input` label marks a specific question. Conductor can start
bounded work from `ready` issues after it checks authorization, dependencies,
holds and current issue contents. It retains original builder sessions through
repair, verifies checks and reviews, and closes work only after acceptance and
landing are confirmed.

OnePersonLabs can guide task, model and context judgment independently. With
Conductor enabled, Conductor owns durable issues, dependencies, dispatch and
delivery. Builders may delegate bounded local steps within their assigned job;
they integrate and reconcile helpers before completing or handing off the work.
The parent's model alone does not select a helper's model.

Repositories can also require a reviewed Conceptor design before builder
execution. The director prepares it through native planning and independent
review; Conductor validates and supplies the resulting design and implementation
increment to the original builder. Missing or stale handoffs block that job
without starting a model turn. See [design handoff configuration](plugins/conductor/docs/configuration.md#reviewed-design-handoffs).

An ordinary request to change a repository does not start a director. The
director can prepare the change within the request's scope, create or update its
issue, and show you the concrete result. It then asks whether you want to start
Conductor's ongoing director for that repository. Setup and issue preparation
do not bind a chat or start observation.

Once you explicitly start Conductor for a configured repository, it keeps one
Desktop director chat bound to that repository. Relevant changes wake that
chat when it is idle. If it is already working, Conductor records that there is
more to check and lets the current turn sort out the next work without extra
wakeup messages. When it has no further work or useful input to resolve, it tells you to say
“wakeup” to check again.

## First use

Install the Codex plugin and CLI separately. Node.js 24+, Git, GitHub CLI and
Codex App Server must be available in the environment that runs the service.

```powershell
codex plugin marketplace add 'C:\path\to\conductor-plugin'
codex plugin add conductor@conductor
npm install -g 'C:\path\to\conductor-plugin'
```

In WSL, install through that environment's own paths, Node/npm
and authenticated GitHub CLI. Windows and WSL have separate local runtimes.

From the target repository, ask Codex to use `$conductor:setup-repo-workflow`.
Review its proposed `conductor.json`, issue label mapping, checks, concurrency,
delivery settings and scope authority. Preparing setup does not start Conductor.

Only when you explicitly ask to start Conductor does the setup flow bind a
Desktop director and start observation. It first checks the saved owner and any
pending handoff. It reuses that owner or continues the handoff; it does not make
a duplicate. If no director is bound, it creates a fresh native local project
chat titled `Conductor: <product>`, starts it with `$conductor:director`, and
passes the repository, start request and expected prior binding. The new chat
verifies its actual native UUID, saved owner and any pending handoff before its
first enable or attach control. A matching title or skill does not establish
ownership.

In the new chat, enable the configured repository with its native UUID:

```powershell
conductor enable --host desktop --thread THREAD_UUID
```

Verify the saved binding with `conductor status`. Merely installing the plugin
or preparing configuration does not enable processing.

Review and trust the Conductor lifecycle hooks when Desktop prompts you to do
so. Routine refresh does not require a blanket Desktop restart or hook toggle.
If lifecycle receipts are missing, diagnose the event delivery path and actual
hook execution before changing host settings. Cross-chat messaging bypasses
`UserPromptSubmit`; use the native queue for programmatic director messages.
Normal operation uses the native queue and hooks without UI automation. The final automatic
test restarted the observer with `conductor wakeup` and delivered through
the queue, without a composer submission.
If lifecycle status is unknown, automatic wakeups are suppressed instead of
assuming the director is idle. The October 27 bounded trial verified automatic
delivery, matching lifecycle tracking, service restart with the same chat, and
busy-signal suppression. See the [runtime evidence](docs/runtime-selection-2026-10-20.md)
for scope and the Windows shutdown persistence repair.
If status reports `lifecycle-receipt-missing`, inspect the native chat and hook
execution before manually resuming; settlement alone does not prove turn completion.

Use the director chat for issue triage, decisions and execution. Say `wakeup`
there at any time to make Conductor check for work. From a terminal, wake an
already-enabled repository with:

```powershell
conductor wakeup
```

Before creating a director, Conductor checks the saved owner and any pending
handoff. It reuses the saved owner or completes that handoff; a title or skill
match does not establish ownership. `conductor status` shows service and recovery
state. On Windows, keep the runner's console visible to see timestamped progress;
its existing log rotates. `Ctrl+C`, closing the console, or `conductor stop`
persists a runner pause. Bare `conductor resume` clears only that stop pause and
restarts observation; holds, job pauses and admission restrictions remain.

`conductor wakeup` observes and reports a paused reason without clearing the
pause. Run `conductor --help` for controls and the
[workflow guide](plugins/conductor/docs/workflow.md) for holds, release, event
handling and recovery.

To get a fresh director context, say “Move Conductor to a fresh chat” in the
current runner, or “Make this the Conductor runner” in another project chat.
The [chat handoff](plugins/conductor/docs/workflow.md#move-the-director-to-another-chat)
preserves worker ownership, holds and execution pauses and waits for an active
director to finish before switching. The replacement automatically archives the
superseded runner after verifying the handoff; its conversation history remains
recoverable. You can explicitly ask to keep it visible.
For plugin rollouts, finish bundle changes, checks and publication first. Then
refresh the Windows local installation, verify hook trust, and complete required
post-refresh configuration and global-instruction checks before creating
replacements. Do not refresh WSL or another local Codex home unless requested.
Keep the installed bundle unchanged through handoff and lifecycle verification;
see the same guide for the full order.

## How issue states work

- `triage`: investigate incoming or unclassified work.
- `proposal`: develop an unaccepted direction; no implementation dispatch until
  that direction is accepted. Conductor removes the label when the underlying
  decision is resolved; a rejection does not make the work ready.
- `ready`: accepted bounded work; dependencies can still block admission.
- `on-hold`: paused until you explicitly release it.
- `needs-input`: a specific unresolved decision blocks the affected work. It is
  removed when no human input remains; partial decisions retain only the remaining
  blocker.

Accepted implementation issues created from a plan can be ready immediately.
Newly reported bugs normally enter triage. Conductor investigates and fills
planning gaps to make authorized work ready, including defining acceptance
criteria. It verifies satisfaction of those criteria from appropriate evidence;
writing them does not establish success. An admission pause still permits
authorized backlog preparation, but remains a barrier to implementation.
Open dependencies are checked
automatically; when a valid prerequisite completes, the ready issue is
reconsidered on the next scan.

The service signals the same chat when work completes, relevant issue changes
occur, or attention is needed, and checks GitHub changes every 30 minutes. If
the director is already active, new activity is recorded for its next check
instead of queuing more wakeup messages. An unchanged check causes no model
turn. Human-collaboration is an optional side channel; regular chat is
sufficient.

## Limits and evidence

The service does not install a startup task, authorize new product decisions,
or establish human or platform qualification. Source tests, installed plugin
state, live service operation and end-to-end delivery are separate evidence.
No production workers are started by installation or setup.

See [configuration](plugins/conductor/docs/configuration.md),
[workflow and recovery](plugins/conductor/docs/workflow.md),
[$conductor:director](plugins/conductor/skills/director/SKILL.md), and
[$conductor:github-workflow](plugins/conductor/skills/github-workflow/SKILL.md).
