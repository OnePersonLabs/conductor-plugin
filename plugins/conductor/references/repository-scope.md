# Repository setup gate

Every Conductor skill except `$conductor:setup-repo-workflow` requires valid setup
for its target repository. Apply this gate before investigation, questions,
planning, review, edits, delegation, GitHub operations or director lifecycle work,
including when the user invokes a skill explicitly. Reading this prerequisite
and running its local check are the only Conductor actions allowed before it passes.

1. Identify the target checkout from the request or current working directory.
   Do not borrow setup from a different repository to handle a remote issue.
   If no target checkout can be identified, stop this skill.
2. From that checkout or one of its subdirectories, run the packaged CLI:

   `node <plugin-root>/bin/conductor.mjs check-setup`

   Resolve `<plugin-root>` from this skill's installed package location, not a
   guessed global CLI or another plugin version. The check is local and read-only.
3. Continue only when the command exits successfully and returns
   `configured: true` for the intended GitHub repository. Recheck when the target
   repository or its configuration changes. Do not infer setup from skill
   installation, an AGENTS.md mention, labels, a chat title or saved runtime state.

The check validates version 2 `conductor.json` and its match to the target
repository's origin. It prefers the current checkout's file. When that file is
missing in a linked worktree, it reads the main checkout of the same Git repository.
An invalid local file cannot fall back to another file. Missing, invalid,
unsupported or mismatched setup, and an unavailable check, all stop this skill.

On failure, perform no Conductor task work and do not create or repair setup,
start a director, ask Conductor workflow questions or alter issues. For an
explicit invocation, report the concrete setup failure to the user or assigning
agent and point to `$conductor:setup-repo-workflow`. For implicit selection, leave
the skill inactive and continue the ordinary request under the host and repository
instructions, without imposing Conductor policy or requiring setup.

Setup does not grant execution authority. A valid file with `authorized: false`
passes this gate for manual skills and synchronous coordination. A stopped
runner, paused admission or missing director binding does not invalidate setup.
Automation still requires its separate authority and lifecycle checks.

After this gate passes, use [the companion phase workflow](phase-workflow.md)
when the assignment involves a multi-phase roadmap and human review or replanning
checkpoints. It composes with available process skills; no companion is required
for ordinary Conductor work.
