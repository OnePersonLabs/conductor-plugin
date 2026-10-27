# Conductor

Conductor is a conversational director for issue-driven project work. In chat,
it helps you triage reports, discuss proposals, choose priorities, manage holds
and direct implementation. A small local service handles worker ownership,
capacity, events, recovery and delivery. When nothing needs attention, the
director ends its turn; an unchanged idle check does not call a model.

Issues move through familiar workflow states: `triage`, `proposal`, `ready` and
`on-hold`. A `needs-input` label marks a specific question. Conductor can start
bounded work from `ready` issues after it checks authorization, dependencies,
holds and current issue contents. It retains original builder sessions through
repair, verifies checks and reviews, and closes work only after acceptance and
landing are confirmed.

## First use

Install the Codex plugin and CLI separately. Node.js 24+, Git, GitHub CLI and
Codex App Server must be available in the environment that runs the service.

```powershell
codex plugin marketplace add 'C:\path\to\conductor-plugin'
codex plugin add conductor@conductor
npm install -g 'C:\path\to\conductor-plugin'
```

Start a fresh Codex session after plugin installation so it can load the new
director skill. In WSL, install through that environment's own paths, Node/npm
and authenticated GitHub CLI. Windows and WSL have separate local runtimes.

From the target repository, ask Codex to use `$conductor:setup-repo-workflow`.
Review its proposed `conductor.json`, issue label mapping, checks, concurrency,
delivery settings and genuine scope authority. Legacy configurations first
require an explicit migration while admission is stopped. Installation and
setup do not start work.

Start the observer explicitly, bound to the current director chat:

```powershell
conductor start --thread THREAD_UUID
```

Then use `$conductor:director` in that chat to inspect the queue, work through
decisions, create or update issues, and direct execution. `conductor status`
shows service and recovery state; `conductor stop` disables dispatch and
wakeups while retaining recovery data. Run `conductor --help` for the installed
CLI's controls and the [workflow guide](plugins/conductor/docs/workflow.md) for
holds, release, event handling and recovery.

## How issue states work

- `triage`: investigate incoming or unclassified work.
- `proposal`: develop an unaccepted direction; no implementation dispatch.
- `ready`: accepted bounded work; dependencies can still block admission.
- `on-hold`: paused until you explicitly release it.
- `needs-input`: a specific unresolved decision blocks the affected work.

Accepted implementation issues created from a plan can be ready immediately.
Newly reported bugs normally enter triage. Open dependencies are checked
automatically; when a valid prerequisite completes, the ready issue is
reconsidered on the next scan.

The service signals the same chat when work completes or needs attention and
checks GitHub changes every 30 minutes. An unchanged check causes no model turn.
Human-collaboration is an optional side channel; regular chat is sufficient.

## Limits and evidence

The service does not install a startup task, authorize new product decisions,
or establish human or platform qualification. Source tests, installed plugin
state, live service operation and end-to-end delivery are separate evidence.
No production workers are started by installation or setup.

See [configuration](plugins/conductor/docs/configuration.md),
[workflow and recovery](plugins/conductor/docs/workflow.md),
[$conductor:director](plugins/conductor/skills/director/SKILL.md), and
[$conductor:github-workflow](plugins/conductor/skills/github-workflow/SKILL.md).
