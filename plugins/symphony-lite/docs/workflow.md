# Run and recover Symphony Lite

Symphony Lite is a foreground process. The Codex plugin provides the two
workflow skills; it does not install the CLI command, start a process, or
authorize production issue execution. Install the runtime separately, configure
the target repository, and start it there.

## Prepare the target repository

Install the Codex plugin from the local marketplace, then install the CLI
separately:

```powershell
codex plugin marketplace add 'C:\path\to\symphony-lite'
codex plugin add symphony-lite@symphony-lite
npm install -g 'C:\path\to\symphony-lite'
# Or, when the GitHub repository is available:
npm install -g github:OnePersonLabs/symphony-lite
```

Windows and WSL have separate Node installations and PATHs; install the CLI in
the environment where it will run. Then, in the target repository, explicitly
ask Codex to use `$symphony-lite:setup-repo-workflow`. Review the generated
`symphony-lite.json` and its `authorized: true` gate. It must be based on real
scope authority and name existing checks. Setup and plugin installation do not
launch the runtime. See [configuration](configuration.md) for the file shape.

Before running, confirm `origin` is the configured GitHub repository,
`gh auth status` succeeds in the same environment, Codex App Server is available,
the configured base branch exists remotely, and checks are valid from a clean
worktree. The runtime checks repository and authentication preflight before it
starts issue work.

## Start and follow the work

From the configured repository root, run:

```powershell
symphony-lite
```

The process stays in the foreground. It scans at the configured poll interval;
press Enter in its terminal for an immediate scan. It admits open issues carrying
the configured ready label, excludes issues with open dependency blockers,
orders the remaining candidates by configured priority labels, and admits up to
`agents` primary issues. Each issue keeps its slot through PR review and landing.

For each issue, Symphony Lite creates a branch and an external Git worktree,
runs optional `prepare` commands, posts a status comment, and starts or resumes
the original Codex builder thread. The builder changes source, commits, runs the
configured checks, and reports whether issue acceptance is complete. It cannot
push, create or merge PRs, or write GitHub issue status. The coordinator checks
the committed work, pushes the branch, creates the PR, records feedback progress,
and routes new review or failed-check evidence back to that same builder.

The coordinator waits for required checks and approvals. Once they pass, it can
arm GitHub auto-merge using `mergeMethod`. It closes the issue only after it
observes a merged commit in the configured base and the builder reported full
acceptance. A closed unmerged PR remains blocked for operator reconciliation.

## Inspect and control a running process

Use a second terminal at the same checkout:

```powershell
symphony-lite status
symphony-lite signal
symphony-lite stop
symphony-lite cancel 42
symphony-lite resume 42
symphony-lite resume 42 --thread THREAD_ID
```

`status` reads saved state. `signal` asks the active process to scan now. `stop`
gracefully stops admission, interrupts active turns, and preserves recovery
state. `cancel ISSUE` disables automatic redispatch for that owned issue and
retains its branch and worktree. `resume ISSUE` is an explicit request to
continue a stopped or blocked issue. If startup stopped before saving a thread
ID, the runtime lists Codex threads for that issue's exact saved worktree and
adopts the sole candidate only. If none or several match, it blocks and asks you
to inspect the candidates, then choose one with
`symphony-lite resume ISSUE --thread THREAD_ID`. A selected thread must belong
to that exact worktree and have no active turn. If the issue already has a saved
thread ID, `--thread` cannot replace it. Inspect status and the worktree before
resuming; unresolved thread ownership never starts a replacement builder.

`status` includes the ten most recent completed control-command receipts and
their errors. Commands submitted while the process is stopping remain queued
until the next run can acknowledge them. Check status after startup to confirm
the outcome.

When the foreground terminal displays a Codex permission or input request, read
the request before answering. Use its displayed key and an explicit response:

```text
answer ISSUE:REQUEST accept
```

Approval responses are limited to the options Codex displayed. Other server
requests require the exact JSON response shape shown in the terminal. Pressing
Enter only requests a scan; it never answers a question or approves a command.

## Find and preserve recovery state

Machine state is stored under `symphony-lite/` in the Git common directory,
outside tracked project files. Each saved job records its own worktree path; the
runtime places new worktrees outside the source checkout under a sibling
`.symphony-lite-worktrees/<repository-hash>/issue-ISSUE` directory. Preserve the
state file, lock information, original thread identity, branch, and worktree
when diagnosing an interruption.

After restart, inspect `symphony-lite status` before taking manual action. The
runtime retains the original thread and may resume it after confirming no old
builder process remains. If state is blocked or stopped, inspect the issue,
branch, and worktree before using `resume ISSUE`. An unknown or unresolved
launch must remain blocked until its ownership is understood; do not start a
second builder in the same issue directory or infer that a turn was delivered.
If a check modified the worktree or left files uncommitted, have the original
builder reconcile that work before delivery.

Review and failed-check feedback is saved with the issue until a repair build
succeeds. If the process stops during repair, inspect the saved pending feedback
and resume the same issue and thread; do not discard the evidence or start a new
builder to get a clean prompt.

`maxTurns`, when configured, caps the total persisted Codex turns for a bounded
qualification run. A limit reached stops further turns; inspect status and
preserve the existing evidence before changing the cap. A new conversation does
not erase prior usage.

## Current limits

The runtime supports a GitHub issue-to-PR delivery path. It is not a service,
background scheduler, or production dispatcher when installed. It does not
establish that a target repository's permissions, checks, acceptance criteria,
credentials, or policies are safe or correct. Complete qualification in the
intended environment before relying on it for real issue delivery.
