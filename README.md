# Symphony Lite

Symphony Lite is a foreground Codex worker pool for carrying authorized GitHub
issues through pull-request delivery. It selects open issues with the configured
ready label, creates isolated worktrees, starts or resumes Codex sessions, runs
the repository's configured checks, opens PRs, routes new review or failed-check
evidence back to the original builder, and reconciles merge and issue status.

## Try it

1. Install the `symphony-lite` plugin from this repository's local marketplace
   using Codex's plugin UI or CLI. With the CLI, run:

   ```powershell
   codex plugin marketplace add 'C:\path\to\symphony-lite'
   codex plugin add symphony-lite@symphony-lite
   ```

2. Install the foreground CLI separately:

   ```powershell
   npm install -g 'C:\path\to\symphony-lite'
   # Or, when the GitHub repository is available:
   npm install -g github:OnePersonLabs/symphony-lite
   ```

3. From the target repository, explicitly ask Codex to use
   `$symphony-lite:setup-repo-workflow` to inspect the workflow and prepare
   `symphony-lite.json`. Setup must confirm the actual issue scope authority,
   repository, base branch, existing checks, and PR requirements. The runtime
   requires `authorized: true`, a base branch, and at least one configured check
   before it can run.
4. Review and approve that file only when ready issues are genuinely authorized
   for execution. It is the project configuration and can authorize GitHub
   writes by the foreground coordinator.
5. In a terminal at the configured repository root, run `symphony-lite`. This
   starts the foreground process. Installation and setup do not start it.

When an issue meets the configured admission rules, the coordinator posts a
status comment and starts a builder in a separate worktree. Review the terminal
and issue before allowing this on a repository with real work. Read
[workflow and recovery](plugins/symphony-lite/docs/workflow.md)
for status, operator controls, and interrupted work. Read
[repository configuration](plugins/symphony-lite/docs/configuration.md) for the
settings and required authorization boundary.

## Important limits

Symphony Lite is foreground software. It runs only while its process is active;
it does not install a service, scheduler, or unattended startup task. The
deterministic checks and package installation do not establish live runtime
qualification. Confirm the current qualification state before relying on it.
Configuring and installing the plugin do not establish that a project's checks,
permissions, credentials, or delivery policy are suitable.

The runtime uses a GitHub ready label, open-issue state, dependency blockers,
configured checks, review decisions, and PR merge state. It does not replace a
project's source of product meaning or acceptance evidence. Keep those in the
project's existing records.

## Contributor checks

From this checkout, run:

```powershell
npm run test:contract
npm run test:unit
npm run test:docs
```

`npm run test:installed` additionally installs the local marketplace package in
a temporary Codex home, confirms Codex discovered it, compares the installed
plugin tree with source, and checks the installed documentation links. It does
not run the worker or start an issue. `npm run verify` runs the deterministic
contract, unit, and documentation checks; it does not run model evaluations or
the installed-package checkpoint.

For maintainers, the
[2026-10-20 runtime selection evidence](docs/runtime-selection-2026-10-20.md)
preserves the pinned comparison and requirements that informed the implementation.

Skills and their activation metadata ship inside
[`plugins/symphony-lite`](plugins/symphony-lite/). See the
[GitHub workflow skill](plugins/symphony-lite/skills/github-workflow/SKILL.md)
for issue and delivery policy and the
[setup skill](plugins/symphony-lite/skills/setup-repo-workflow/SKILL.md) for
explicit repository configuration.
