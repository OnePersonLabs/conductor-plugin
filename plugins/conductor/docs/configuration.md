# Configure a Conductor repository

Conductor reads `conductor.json` from the target Git repository root. Use
`$conductor:setup-repo-workflow` to prepare or migrate this configuration.
Setup inspects repository policy and prepares the file. The user must explicitly
enable the repository to create or bind its director and start issue observation.

## Repository and execution settings

```json
{
  "version": 2,
  "repository": "owner/repository",
  "baseBranch": "main",
  "authorized": true,
  "labels": {
    "triage": "triage",
    "proposal": "proposal",
    "ready": "ready",
    "hold": "on-hold",
    "needsInput": "needs-input"
  },
  "priorityLabels": [],
  "agents": 1,
  "pollInterval": "30m",
  "directorModel": "gpt-6.1-sol",
  "plannerModel": "gpt-6-astra",
  "checks": [
    { "command": "npm", "args": ["test"] }
  ]
}
```

This illustrates the configuration shape. Select actual labels, checks, review
requirements, concurrency, model roles and delivery settings from the target
repository's conventions and explicit authority. `authorized` must be the
boolean `true` only when the configured workflow has genuine implementation and
PR-delivery authority. It is an execution gate, not blanket permission for new
product scope.

`directorModel` is the setup preference for the invoking chat, not a runtime
model switch. Select Sol in that chat. `plannerModel` instructs the director's
native subagent delegation; the service does not create a second planner runner.
The director verifies host model availability and reports unsupported models.

`labels` maps the primary issue states to labels already used or intentionally
created in the repository. The default names are `triage`, `proposal`, `ready`
and `on-hold`; `needs-input` is a separate modifier. An issue should carry one
primary state. Preserve labels for type, area and priority. Do not add a second
ready label such as `conductor:ready`.

An unlabeled issue is surfaced for triage. A `proposal` can be investigated and
discussed but does not dispatch implementation. An `on-hold` issue remains
suspended until explicitly released. A `ready` issue can dispatch after current
scope and dependency checks pass. Closing a prerequisite triggers re-evaluation;
it does not bypass proposal, hold or human-input requirements.

## Verification and delivery settings

Each `checks` and optional `prepare` entry has a `command` string and an `args`
array of strings. Conductor runs the executable with those arguments inside the
issue worktree; it does not evaluate a shell command string. At least one
existing check is required. Never add a synthetic check merely to satisfy
validation.

Retain project-specific review and delivery controls where configured:

| Setting | Purpose |
| --- | --- |
| `priorityLabels` | Orders ready issues; earlier labels rank first. |
| `agents` | Caps concurrent primary issue jobs. |
| `requiredApprovals` | Sets the number of current PR approvals required before auto-merge. |
| `mergeMethod` | Selects `merge`, `squash` or `rebase`. |
| `maxTurns` | Optional cap for a bounded run. |
| `implementationInstructions` | Project instructions supplied to builders. |
| `reviewEnabled` | Requires independent Conductor review by default. |
| `reviewInstructions` | Additional review criteria. |

## Before starting

Confirm `origin` matches `repository`, the configured base branch exists, and
`gh auth status` succeeds in the intended environment. Check configured
commands from a clean worktree. Ensure Git, GitHub CLI, Node.js 24+ and Codex
App Server are available.

The source exposes explicit repository enablement and recovery controls; a
configuration file alone does not start a watcher or authorize production
dispatch. `conductor enable` starts the configured repository's director after
setup. Follow [workflow and recovery](workflow.md) for wakeup, stop and migration
behavior. Windows and WSL maintain separate GitHub, Node and Codex environments;
recover work in the environment that owns it.

Legacy configurations using `readyLabel` require explicit migration while
admission is stopped. Migration inventories current issues and jobs, maps
verified prepared issues to `ready`, leaves other unlabeled issues in triage,
and preserves saved worker sessions and delivery receipts. Do not remove the
legacy label or enable processing until the resulting classification has been
reviewed.

Run `conductor migrate` from the configured checkout to print a preview. It
makes no changes. Prepare a JSON mapping from each issue number to its chosen
state and the exact preview revision, for example:

```json
{
  "42": { "state": "ready", "revision": "<revision from preview>" },
  "43": { "state": "triage", "revision": "<revision from preview>" }
}
```

Review the preview and mapping, then explicitly apply them:

```powershell
conductor migrate --apply --mapping .\conductor-migration.json
```

The command rechecks revisions, changes issue labels, saves a dated legacy
configuration backup beside `conductor.json`, and writes a version 2
configuration with admission paused. Review the resulting issue states and
configuration. Enable the director, inspect its status and explicitly activate
admission with a control request before any new implementation begins.
If an issue changed after preview, regenerate the preview and reconcile the new
contents instead of reusing the stale mapping.
