# Check the capability's prerequisites

Choose prerequisites for the operation being performed. Local work does not need
GitHub automation configuration. Setup and authority are separate questions.

| Operation | Prerequisite |
| --- | --- |
| Read-only local exploration | Identify the requested directory; no Git or setup check |
| Local planning, tracked artifacts, implementation, review or synchronous coordination | Git checkout; validate any existing Conductor configuration |
| GitHub issue inspection or writes | Local requirements plus verified GitHub repository identity; authenticate for the requested operation |
| Background automation | Full repository setup and explicit automated execution authority |

Resolve the package root from the current skill's installed location. From the
target checkout, run the applicable read-only check:

```text
node <plugin-root>/bin/conductor.mjs check-scope local
node <plugin-root>/bin/conductor.mjs check-scope issues
node <plugin-root>/bin/conductor.mjs check-scope automation
```

`local` is the default. It requires Git but permits an absent `conductor.json`.
`issues` additionally verifies the GitHub origin identity without requiring full
automation setup. `automation` requires the existing full setup contract and
`authorized: true`. These checks do not grant permission to write, publish,
dispatch, close an issue or take over existing workers.

The result identifies `scope`, `root`, `configured` and, when applicable,
`repository`, `configPath` and `authorized`. Check that they describe the intended
checkout. A linked worktree can inherit configuration from its own main checkout.
An invalid local file cannot fall back to another file. Missing configuration is
allowed for local and issue work; malformed, unsupported or mismatched existing
configuration is a failure and must not be silently bypassed.

If a required check fails or is unavailable, stop dependent Conductor operations
and report the concrete failure. Use `$conductor:setup-repo-workflow` only for an
authorized setup or migration request. Do not repair configuration merely to make
an ordinary action proceed. Recheck when the target repository or configuration
changes. An explicit foreign issue URL does not authorize switching checkouts.

Before local edits, inspect current automation ownership and recovery state. A
stopped service or paused admission does not prove that workers or delivery have
stopped. Continue only when no owned worker or unresolved delivery operation can
conflict. Preserve bindings, holds, jobs, branches and worktrees. Ask the existing
owner to reconcile a conflict; do not silently stop automation or take ownership.

Ordinary actions never start a director, create a user chat or enable background
automation. Direct local requests remain valid without a mandatory issue. Read
[issue context](issue-context.md) only when an issue is requested or already owns
the work. Read [phase workflow](phase-workflow.md) for coordinated phases.
