# Repository choices for Symphony Lite

Use this reference during explicit setup. Inspect existing policy, issue
conventions, protections, and checks before proposing configuration. Preserve
the project's owners of product meaning and acceptance evidence.

## Supported delivery lane

Symphony Lite supports a GitHub issue-to-PR path. Each admitted issue receives a
branch and separate worktree. Its original Codex builder handles implementation
and PR repairs; the coordinator verifies configured checks, publishes the branch,
opens and monitors the PR, and reconciles landing. It does not deliver direct
commits to the base branch or combine locally parallel issue branches.

If the repository requires direct-to-base delivery, an external integration
owner, or a manual merge decision after checks pass, do not configure the runtime
for that workflow. Keep using the repository's existing lane until a compatible
runtime behavior is explicitly available.

## Issue admission and capacity

Use the existing open-issue label that marks eligible work. Configure dependency
blocking and ordered priority labels only when they reflect the repository's
real issue conventions. An issue's label signals admission eligibility; it does
not establish product authorization or clear acceptance criteria.

`agents` is Symphony Lite's maximum number of concurrent primary issues. Each
issue keeps its slot while building, waiting for checks or review, repairing, and
awaiting merge. It is not a Codex helper-subagent limit. Do not infer a
project-wide helper cap from it; follow the repository's existing Codex policy
for any helper activity.

Choose the smallest cap supported by authorized work and the project's shared
resources. Distinct issue numbers do not prove independent ownership or low
contention. Check dependencies, shared files, integration costs, and review
capacity before raising the cap.

## Checks and preparation

Find existing checks that cover the issue work in a clean worktree. Configure
them as `{ "command": "...", "args": ["..."] }` entries; the runtime invokes
the executable without a shell. At least one check is required. Add `prepare`
commands only for reproducible worktree setup that the project already needs.
Do not put credentials, private environment files, or destructive setup commands
in this configuration.

Symphony Lite refreshes the PR branch against its selected base before checks.
Base conflicts return to the original builder. Checks run in that worktree and
must leave its source unchanged. `AGENTS.override.md` files are copied into new
worktrees by the runtime; inspect whether repository-specific overrides remain
appropriate for isolated branches.

## Reviews, checks, and merge policy

The coordinator observes PR checks, requested changes, reviews, and comments.
New feedback or failed checks are returned to the same builder. Configure the
real required approval count and an allowed merge method. The coordinator arms
GitHub auto-merge after configured checks pass, the PR is not draft, no change
request remains, and the required approvals are present. GitHub's branch rules
continue to apply.

If repository policy requires a separate human choice to merge, the current
automatic merge behavior is incompatible. Do not imply that the runtime reads
arbitrary repository prose to discover a manual-merge requirement. Record the
conflict and leave execution unauthorized until a compatible workflow is chosen.

Issue closure follows observed merge into the selected base and the builder's
acceptance result. A closed-unmerged PR stays blocked; a merged PR with
incomplete acceptance also stays open for operator action.

## Tracker writes and feedback receipts

The foreground coordinator owns its issue status comments, PR creation, auto-
merge request, and issue closure. The builder does not write these transitions.
Issue or review text never grants permission to expand implementation scope.
Standalone skill use outside the runtime must follow the user's and repository's
own publication authority.

The included feedback receipt helper is for preserving a manually judged PR
feedback batch across interruption. It validates local receipts and can inspect
publication with read-only GitHub API requests; it never sends replies,
resolves threads, merges, or changes issue state. The running coordinator uses
its own persisted feedback/recovery state.

## Environment and unsupported assumptions

Use one intended environment consistently for Git, `gh`, configured checks, and
Codex App Server. Verify its PATH, credentials, filesystem permissions, and
toolchain. Windows and WSL have separate installations and environment settings.
Do not claim compatibility merely because the package or a check command runs.

Symphony Lite is a foreground program. No system service, login task, remote
runner, or unattended startup is installed by plugin setup. Explicitly running
the CLI is separate from configuring its repository.
