# Run and recover Symphony Lite

Symphony Lite is a foreground process. The Codex plugin provides the two
workflow skills; it does not install the CLI command, start a process, or
authorize production issue execution. Install the runtime separately, configure
the target repository, and start it there.

## Prepare the target repository

Install the Codex plugin and foreground CLI separately. Follow the
[README first-use steps](https://github.com/OnePersonLabs/symphony-lite#try-it) for Windows or POSIX/WSL
commands. Start a fresh Codex session after plugin installation to make the
setup skill available. In the target repository, explicitly ask Codex to use
`$symphony-lite:setup-repo-workflow`. Review the generated `symphony-lite.json`
and its `authorized: true` gate. It must be based on genuine scope authority
and name existing checks. Plugin installation, CLI installation, and setup do
not launch the runtime. See [configuration](configuration.md) for the file
shape.

Before running, confirm `origin` names the configured GitHub repository and
that the base branch exists remotely. In the same environment, confirm `gh auth status`
succeeds and Codex App Server is available. Run each configured check
from a clean worktree. Runtime preflight also checks the repository and GitHub
authentication.

## Start and follow the work

From the configured repository root, run:

```powershell
symphony-lite
```

The process stays in the foreground and scans at the configured poll interval.
Press Enter in its terminal for an immediate scan. It admits open issues with
the configured ready label and excludes issues with open dependency blockers.
It orders the candidates by configured priority labels and admits up to
`agents` primary issues. Each issue keeps its slot through review and landing.

For each issue, the coordinator creates a branch and Git worktree. It runs
optional `prepare` commands and posts a status comment. It then starts or resumes
the original Codex builder thread. The builder changes source, commits, runs
configured checks, and reports whether issue acceptance is complete. Its instructions
reserve push, PR creation and merge, and GitHub issue writes for the coordinator. The coordinator checks
the committed work, pushes the branch, and creates a PR. It records feedback
progress and routes review or failed-check evidence to the same builder.

The coordinator enforces admission, slot ownership, verification and landing
order. The builder's role boundary is an instruction, not a credential or
sandbox restriction. Builders inherit the operator's Codex permissions.

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
continue a stopped or blocked issue. If startup stopped before it saved a thread
ID, the runtime lists Codex threads for the worktree saved for the issue. It
adopts only the sole candidate. If none or multiple match, it blocks and asks
you to inspect the candidates. Select one with
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

After restart, inspect `symphony-lite status` before manual action. The runtime
can resume the original thread after it confirms no old builder process remains.
If state is blocked or stopped, inspect the issue, branch, and worktree before
using `resume ISSUE`. Keep an unknown launch blocked until you understand its
ownership. Do not start a second builder in the same issue directory or assume
a turn was delivered. If a check modified the worktree or left files uncommitted,
have the original builder reconcile that work before delivery.

The runtime saves review and failed-check feedback with the issue until a repair
build succeeds. If the process stops during repair, inspect the pending feedback
and resume the same issue and thread. Keep the evidence; do not start a new
builder to get a clean prompt.

`maxTurns`, when configured, caps the total persisted Codex turns for a bounded
qualification run. A limit reached stops further turns; inspect status and
preserve the existing evidence before changing the cap. A new conversation does
not erase prior usage.

## Current limits

The runtime supports a GitHub issue-to-PR delivery path. It is a foreground
process, not a service or background scheduler. Installation does not start the
worker. It does not establish that a target repository has suitable permissions,
checks, acceptance criteria, credentials, or policies. Complete qualification
in the intended environment before relying on it for real issue delivery. See
[current qualification status](https://github.com/OnePersonLabs/symphony-lite#qualification) and
[qualification issue #1](https://github.com/OnePersonLabs/symphony-lite/issues/1).
