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

Once you explicitly enable Conductor for a configured repository, it keeps one
Desktop director chat bound to that repository. Relevant changes wake that
chat when it is idle. If it is already working, Conductor records that there is
more to check and lets the current turn sort out the next work without extra
wakeup messages. When it has nothing actionable, it tells you to say “wakeup”
to check again.

## First use

Install the Codex plugin and CLI separately. Node.js 24+, Git, GitHub CLI and
Codex App Server must be available in the environment that runs the service.

```powershell
codex plugin marketplace add 'C:\path\to\conductor-plugin'
codex plugin add conductor@conductor
npm install -g 'C:\path\to\conductor-plugin'
```

Fully restart Codex Desktop after plugin installation so its host reloads the
director skill and hooks. A new chat alone may retain the host's old plugin cache.
In WSL, install through that environment's own paths, Node/npm
and authenticated GitHub CLI. Windows and WSL have separate local runtimes.

From the target repository, ask Codex to use `$conductor:setup-repo-workflow`.
Review its proposed `conductor.json`, issue label mapping, checks, concurrency,
delivery settings and genuine scope authority. In Desktop, reuse the existing
bound director or create a persistent local project chat named
`Conductor: owner/repository`, start it with `$conductor:director`, and bind it
when enabling the repository. A new director's initial instruction must run
the enable command against its own thread UUID before inspecting issues or
dispatching. Wait for the director to report completion and verify the saved
binding with `conductor status`:

```powershell
conductor enable --host desktop --thread THREAD_UUID
```

Merely installing the plugin or preparing configuration does not enable
processing.

Review and trust the Conductor lifecycle hooks when Desktop prompts you to do
so. After installing or refreshing hook definitions, fully restart Desktop
so its host reloads them. If lifecycle status is unknown, automatic wakeups
are suppressed instead of assuming the director is idle.

Use the director chat for issue triage, decisions and execution. Say `wakeup`
there at any time to make Conductor check for work. From a terminal, wake an
already-enabled repository with:

```powershell
conductor wakeup
```

If a repository already has an explicitly bound director, Conductor reuses it;
otherwise enabling starts one. `conductor status` shows service and recovery
state. `conductor stop` deliberately disables automatic dispatch and wakeups
while retaining recovery data. Run `conductor --help` for controls and the
[workflow guide](plugins/conductor/docs/workflow.md) for holds, release, event
handling and recovery.

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
