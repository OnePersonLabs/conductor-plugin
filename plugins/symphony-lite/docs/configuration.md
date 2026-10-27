# Configure a repository

Symphony Lite reads `symphony-lite.json` from the target Git repository root.
Use `$symphony-lite:setup-repo-workflow` only after the user explicitly asks for
repository setup. The setup skill inspects existing policy and prepares a
configuration; it does not launch the runtime.

## Required settings

```json
{
  "repository": "owner/repository",
  "baseBranch": "main",
  "authorized": true,
  "checks": [
    { "command": "npm", "args": ["test"] }
  ]
}
```

Replace the example with the actual GitHub repository, remote base, and existing
checks. `authorized` must be the boolean `true` only if matching ready issues
have genuine implementation and PR-delivery authority. It is a safety gate,
not a blanket permission grant.

Each `checks` and `prepare` item has a `command` string and an `args` array of
strings. The runtime runs the executable with those arguments in the issue
worktree; it does not evaluate a shell command string. At least one check is
required. `prepare` is optional and defaults to an empty list.

## Optional settings and defaults

| Setting | Default | Use |
| --- | --- | --- |
| `readyLabel` | `symphony:ready` | Selects open issues eligible for admission. |
| `priorityLabels` | `[]` | Ordered label names; earlier labels rank first, then older issues. |
| `agents` | `1` | Maximum concurrent primary issue builders. Waiting for review still occupies a slot. |
| `pollInterval` | `5m` | Interval for GitHub reconciliation; `ms`, `s`, `m`, or `h` values are accepted. |
| `requiredApprovals` | `0` | Number of current PR approvals required before auto-merge can be armed. |
| `mergeMethod` | `merge` | One of `merge`, `squash`, or `rebase`. |
| `maxTurns` | omitted | Optional total Codex-turn limit for a bounded run. |
| `implementationInstructions` | `""` | Project-specific instructions appended to each builder request. |
| `reviewEnabled` | `true` | Require an independent Symphony review before merge. Set `false` for an explicit project opt-out. |
| `reviewInstructions` | `""` | Additional project-specific criteria appended to each review request. |

`agents` limits separate primary issues; it is not a subagent count. Open
dependency blockers are excluded before capacity is assigned. The runtime does
not add helper capacity or authorize work beyond the configured ready-issue
scope.

## Complete example

```json
{
  "repository": "owner/repository",
  "baseBranch": "main",
  "authorized": true,
  "readyLabel": "symphony:ready",
  "priorityLabels": ["priority:high", "priority:normal"],
  "agents": 1,
  "pollInterval": "5m",
  "checks": [
    { "command": "npm", "args": ["run", "test:unit"] },
    { "command": "npm", "args": ["run", "test:contract"] }
  ],
  "prepare": [],
  "requiredApprovals": 1,
  "mergeMethod": "squash",
  "maxTurns": 8,
  "implementationInstructions": "When .conceptor/ exists in the selected root, invoke $conceptor:apply-change.",
  "reviewEnabled": true,
  "reviewInstructions": "Check the public API compatibility policy."
}
```

This is an example shape, not a recommended policy. Set labels, concurrent
issues, checks, approvals, merge method, and turn cap from repository evidence
and explicit scope authority. Do not add a fake check to satisfy validation.

## Before running

Confirm `origin` names the configured repository and that `baseBranch` exists
on the remote. Check that `gh auth status` works in the intended environment.
Check each configured command from a clean worktree. Ensure Node.js 24+, Git,
the GitHub CLI, and Codex App Server are available there. Review which issues
carry the ready label and who authorized them. Run `symphony-lite` as a separate
foreground operation only after those checks. Plugin installation, CLI
installation, and a valid configuration never start the runtime. See the
[README first-use steps](https://github.com/OnePersonLabs/symphony-lite#try-it) for separate plugin and CLI
installation instructions, including WSL.
