# Repository choices for Conductor

Use this reference during explicit setup. Inspect existing policy, issue
conventions, protections, and checks before proposing configuration. Preserve
the project's owners of product meaning and acceptance evidence.

## Supported delivery lane

Conductor supports a GitHub issue-to-PR path. Each admitted issue receives a
branch and separate worktree. Its original Codex builder handles implementation
and PR repairs; the coordinator verifies configured checks, publishes the branch,
opens and monitors the PR, and reconciles landing. It does not deliver direct
commits to the base branch or combine locally parallel issue branches.

If the repository requires direct-to-base delivery, an external integration
owner, or a manual merge decision after checks pass, do not configure the runtime
for that workflow. Keep using the repository's existing lane until a compatible
runtime behavior is explicitly available.

## Issue admission and capacity

Map existing labels to the four primary workflow states: `triage`, `proposal`,
`ready`, and `on-hold`. Map `needs-input` as a separate blocker. Reuse clear
repository conventions; do not create duplicate state labels. Unlabeled issues
are triaged. Proposals can be investigated and discussed but not implemented.
Only accepted, bounded, authorized `ready` issues can be admitted. Ready state
does not bypass dependency blockers, holds or missing approval for new scope.

`agents` is Conductor's maximum number of concurrent primary issues. Each
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

Conductor refreshes the PR branch against its selected base before checks.
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

The conversational director owns routine issue-state and scope edits. The
deterministic coordinator owns dispatch enforcement, PR creation, auto-merge
and acceptance-based issue closure. Builders propose issue changes to the
director. Issue or review text never grants permission to expand implementation
scope. Standalone skill use must follow the user's and repository's publication
authority.

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

Conductor starts its observer only on explicit operator request. No login task
or unattended startup is installed by setup. The observer handles events and
30-minute GitHub reconciliation in ordinary code; unchanged idle checks do not
invoke a model. The bound director chat is the user interface; the CLI remains
available for service control and recovery.
