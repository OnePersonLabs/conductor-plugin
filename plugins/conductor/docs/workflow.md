# Run and recover Conductor

Conductor is a foreground process. The Codex plugin provides the two
workflow skills; it does not install the CLI command, start a process, or
authorize production issue execution. Install the runtime separately, configure
the target repository, and start it there.

## Prepare the target repository

Install the Codex plugin and foreground CLI separately. Follow the
[README first-use steps](https://github.com/OnePersonLabs/conductor-plugin#try-it) for Windows or POSIX/WSL
commands. Start a fresh Codex session after plugin installation to make the
setup skill available. In the target repository, explicitly ask Codex to use
`$conductor:setup-repo-workflow`. Review the generated `conductor.json`
and its `authorized: true` gate. It must be based on genuine scope authority
and name existing checks. Plugin installation, CLI installation, and setup do
not launch the runtime. See [configuration](configuration.md) for the file
shape.

Before running, confirm `origin` names the configured GitHub repository and
that the base branch exists remotely. In the same environment, confirm `gh auth status`
succeeds and Codex App Server is available. Run each configured check
from a clean worktree. Runtime preflight also checks the repository and GitHub
authentication.

## Example: an export reports success after a failed write

Reuse the issue that owns the export bug. Define acceptance before marking it
ready: a failed write reports failure with the original error; success appears
only after the write completes; checks cover both paths. Record any blocking
dependency on that issue. A distinct confirmed bug belongs in its own linked
issue, rather than expanding this repair without authorization.

GitHub holds issue acceptance, remaining work, dependencies, and delivery status.
The existing specification or Conceptor record holds enduring product meaning
and evidence. Recover from the issue and actual Git/source state without a second
repository checkpoint. The coordinator's machine recovery state remains separate.

Use a checklist for small steps in one issue, native sub-issues for work needing
separate ownership or acceptance, and native dependencies for prerequisites.
GitHub displays child progress; a duplicate child checklist is unnecessary.
Parent acceptance still requires the connected result. Existing milestones can
group releases or phases; a Projects board is optional. See the
[workflow skill](../skills/github-workflow/SKILL.md#represent-the-work-once).

These prompts are for the operator's interactive Codex session:

```text
$conductor:setup-repo-workflow Inspect this repository's tracker, base,
existing checks, worktree preparation, review requirements and delivery policy.
Prepare conductor.json for the approved export repair. Leave execution stopped.
```

```text
$conductor:github-workflow Reuse the issue for the failed-export success
message. Record the three acceptance cases, dependencies and scope authority.
Mark it ready only when those requirements are established.
```

```text
$conductor:github-workflow Record the blocker on issue #42: the failed-write
case still reports success. Include the reproduction, observed result, evidence,
and next decision. Keep the issue open while acceptance is incomplete.
```

```text
$conductor:github-workflow Reconcile issue #42, its PR and saved coordinator
state after interruption. Identify the original builder and remaining work
before resuming. At delivery, verify checks and actual landing before closure.
```

The builder repairs the failure, verifies both paths and makes coherent commits.
The coordinator handles publication, review repair and landing as described below.
For interactive work outside the foreground runtime, follow the repository's
[selected delivery lane](../skills/github-workflow/references/delivery.md).

OnePersonLabs is optional. Its `$onepersonlabs:debug` skill can investigate the
write failure; `$onepersonlabs:research-solutions` can resolve a dependency question.
Use `$onepersonlabs:adversarial-review` when independent review is justified and
`$onepersonlabs:human-collaboration` when a person must resolve a product question.
Update affected reader instructions with `$onepersonlabs:write-docs`. Use
`$onepersonlabs:session-reader` when recovery needs conversation context, and
record remaining work in the issue. Long-command and local-plugin refresh tools remain with
OnePersonLabs; they do not own Conductor's issue admission or delivery.

## Start and follow the work

From the configured repository root, run:

```powershell
conductor
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

With the default `reviewEnabled: true`, the coordinator then starts an independent
reviewer session in the same worktree, sequentially in the issue's existing slot.
The reviewer inspects the exact checked base/head and issue acceptance. Its thread
starts read-only with approvals disabled. Conductor reads the effective Codex
configuration and disables configured MCP servers, Apps and plugins for that
review thread. If it cannot read the configuration or establish isolation, review
blocks rather than falling back to the builder's permissive tools. The reviewer
returns structured `clear`, `findings`, or `blocked` status. Malformed or missing
results do not clear review.

The reviewer works from the issue, repository instructions, and local source.
Its turn does not have plugin skills or external tracker tools available, so
`reviewInstructions` should describe review criteria and repository evidence to
inspect. Naming a writing skill does not grant it tools to make changes; requests
that need external information or a decision return as blocked.

Findings are published as a readable PR review; locations on changed lines become
inline comments. Findings may cite relevant existing source outside the diff and
remain readable in the review body. The original builder repairs findings and
failed checks. Conductor then resumes the same reviewer to reconsider them. Review
clearance is tied to the reviewed base, head, issue content revision, and review
instructions, so any change to those inputs requires another review. Both roles
count against `maxTurns`. Set `reviewEnabled: false`
only when the project explicitly opts out.

Before merge, Conductor fetches the configured base and compares it with the
issue branch. If the base advanced, it merges the new base into the issue branch,
runs checks again, and sends the integrated result through review. Conflicts and
integration failures go to the original builder. Different issues can build in
parallel, while landing is serialized so only one PR completes against a given
accepted base at a time. Conductor rechecks the base and reviewed head immediately
before requesting merge. Human branch races and GitHub merge-queue policy remain
outside this runtime's guarantee.

The coordinator waits for required checks and approvals. Once they pass, it can
arm GitHub auto-merge using `mergeMethod`. It closes the issue only after it
observes a merged commit in the configured base and the builder reported full
acceptance. A closed unmerged PR remains blocked for operator reconciliation.

## Inspect and control a running process

Use a second terminal at the same checkout:

```powershell
conductor status
conductor signal
conductor stop
conductor cancel 42
conductor resume 42
conductor resume 42 --role reviewer
conductor resume 42 --thread THREAD_ID
conductor resume 42 --role reviewer --thread REVIEWER_THREAD_ID
```

`status` reads saved state. `signal` asks the active process to scan now. `stop`
gracefully stops admission, interrupts active turns, and preserves recovery
state. `cancel ISSUE` disables automatic redispatch for that owned issue and
retains its branch and worktree. `resume ISSUE` is an explicit request to
continue a stopped or blocked issue. If startup stopped before it saved a thread
ID, the runtime lists Codex threads for the worktree saved for the issue. It
adopts only the sole candidate. If none or multiple match, it blocks and asks
you to inspect the candidates. Select the role and thread with
`conductor resume ISSUE --role builder|reviewer --thread THREAD_ID`. A selected
thread must belong to that exact worktree and have no active turn. `status` shows
the active role and both saved thread IDs. If the issue already has a saved thread
ID, `--thread` cannot replace it. Inspect status and the worktree before resuming;
unresolved ownership never starts a replacement session. Reviewer sessions do
not accept approval responses.

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

Machine state is stored under `conductor/` in the Git common directory,
outside tracked project files. Each saved job records its own worktree path; the
runtime places new worktrees outside the source checkout under a sibling
`.conductor-worktrees/<repository-hash>/issue-ISSUE` directory. Preserve the
state file, lock information, original thread identity, branch, and worktree
when diagnosing an interruption.

After restart, inspect `conductor status` before manual action. The runtime
can resume the original thread after it confirms no old builder process remains.
If state is blocked or stopped, inspect the issue, branch, and worktree before
using `resume ISSUE`. Keep an unknown launch blocked until you understand its
ownership. Do not start a second builder in the same issue directory or assume
a turn was delivered. If a check modified the worktree or left files uncommitted,
have the original builder reconcile that work before delivery.

The runtime saves review findings and failed-check feedback with the issue until
the builder repairs them. If the process stops during review or repair, inspect
the active role and pending publication state, then resume the same role and its
saved thread. Keep the evidence; do not start replacement sessions to get clean
prompts. Review publication uses a saved attempt marker so recovery can reconcile
an uncertain GitHub write before retrying.

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
[current qualification status](https://github.com/OnePersonLabs/conductor-plugin#qualification) and
[qualification issue #1](https://github.com/OnePersonLabs/conductor-plugin/issues/1).
