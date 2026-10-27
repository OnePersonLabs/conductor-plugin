# Conductor

Conductor runs authorized GitHub issues through a foreground Codex worker
pool. It selects issues with a ready label and starts isolated builders. By
default, a separate read-only reviewer checks each PR before merge. Conductor
runs configured checks, publishes review findings, routes repairs to the original
builder, and follows each issue through merge.

## Try it

Use Node.js 24 or newer, Git, GitHub CLI (`gh`), and Codex with its local App
Server. Authenticate `gh` for the target repository. Confirm `gh auth status`
succeeds in the environment where the worker will run.

1. Use the Codex plugin UI or CLI to install the plugin from the local
   marketplace in this checkout:

   ```powershell
   codex plugin marketplace add 'C:\path\to\conductor-plugin'
   codex plugin add conductor@conductor
   ```

   If Codex runs in WSL, use the WSL path to the checkout:

   ```sh
   codex plugin marketplace add /path/to/conductor-plugin
   codex plugin add conductor@conductor
   ```

   This makes the local plugin available to Codex. It does not publish the
   plugin to a marketplace. Install it in the Codex environment that will run
   the workflow. Start a fresh Codex session there so it can discover the setup
   skill.

2. Install the foreground CLI separately from the plugin. On Windows, install
   from the checkout or the known GitHub source:

   ```powershell
   npm install -g 'C:\path\to\conductor-plugin'
   # Or install the GitHub source directly:
   npm install -g github:OnePersonLabs/conductor-plugin
   ```

   In WSL or another POSIX shell, use its Node/npm installation and paths:

   ```sh
   npm install -g /path/to/conductor-plugin
   # Or install the GitHub source directly:
   npm install -g github:OnePersonLabs/conductor-plugin
   ```

   Windows and WSL have separate Node installations and PATH values. Install
   the CLI in each environment where you will run it. These commands install
   the CLI from source. They do not publish an npm registry package or start
   the worker.

3. From the target repository, explicitly ask Codex to use
   `$conductor:setup-repo-workflow` to inspect the workflow and prepare
   `conductor.json`. Setup must confirm the actual issue scope authority,
   repository, base branch, existing checks, and PR requirements. The runtime
   requires `authorized: true`, a base branch, and at least one configured check
   before it can run.
4. Review and approve that file only when ready issues are genuinely authorized
   for execution. It is the project configuration and can authorize GitHub
   writes by the foreground coordinator.
5. In a terminal at the configured repository root, run `conductor`. This
   starts the foreground process. Installation and setup do not start it.

When an issue meets the configured admission rules, the coordinator posts a
status comment and starts a builder in a separate worktree. Review the terminal
and issue before allowing this on a repository with real work. Read
[workflow and recovery](plugins/conductor/docs/workflow.md)
for status, operator controls, and interrupted work. Read
[repository configuration](plugins/conductor/docs/configuration.md) for the
settings and required authorization boundary.

## Important limits

Conductor runs in the foreground while its process is active. It does not
install a service, scheduler, or unattended startup task. The
deterministic checks and package installation do not establish live runtime
qualification. Confirm the current qualification state before relying on it.
Configuration and plugin installation do not establish whether a target
repository has suitable checks, permissions, credentials, or delivery policy.

The runtime uses a GitHub ready label, open-issue state, dependency blockers,
configured checks, review decisions, and PR merge state. It does not replace
project records for product meaning or acceptance evidence. Keep those records
with the project.

## Qualification

Bounded Windows and WSL delivery checks completed, including parallel builders,
original-thread repair, and interruption/resumption. These checks do not qualify
every runtime behavior or a production repository. The disposable trial is
complete; no production workers are running.

## Contributor checks

From this checkout, run:

```powershell
npm run test:contract
npm run test:unit
```

`npm run test:installed` additionally installs the local marketplace package in
a temporary Codex home, confirms Codex discovered it, compares the installed
plugin tree with source. It does not run the worker or start an issue.
`npm run verify` runs the deterministic contract and unit checks; it does not
run model evaluations or the installed-package checkpoint.

For maintainers, the
[2026-10-20 runtime selection evidence](https://github.com/OnePersonLabs/conductor-plugin/blob/main/docs/runtime-selection-2026-10-20.md)
preserves the pinned comparison and requirements that informed the implementation.

Skills and their activation metadata ship inside
[`plugins/conductor`](plugins/conductor/). See the
[GitHub workflow skill](plugins/conductor/skills/github-workflow/SKILL.md)
for issue and delivery policy and the
[setup skill](plugins/conductor/skills/setup-repo-workflow/SKILL.md) for
explicit repository configuration.
