# Runtime selection evidence

**Evidence date:** 2026-10-20. This is a pinned, source-based comparison that
informed Conductor's requirements. It is not a current market survey, a
runtime qualification report, or evidence that the current implementation has
passed its live campaign. Recheck candidate releases and source before relying
on the comparison for a new decision.

**2026-10-27 follow-up:** OpenAI Symphony's current draft specification and
source were inspected at commit
[`be10a1b79df723d6d7612b5651c8522704dafb2e`](https://github.com/openai/symphony/tree/be10a1b79df723d6d7612b5651c8522704dafb2e).
Its useful boundary is a deterministic issue scheduler/workspace manager and
reconciler driven by a repository-owned workflow contract. The inspected
Linear workflow uses active states (`Todo`, `In Progress`, `Rework`, and
`Merging`) and leaves `Backlog` dormant; the GitHub adapter uses open issues,
excludes PR records and does not fetch blockers. This demonstrates that
workflow states are a viable admission policy, but not conversational issue
triage or a general dependency implementation.

Conductor's design applies the scheduler/policy separation to a different user
interaction: the director mediates triage, proposals, decisions and explicit
holds in chat; a deterministic local service owns dispatch, worker lifecycle,
dependencies, recovery and delivery. The adopted primary states are `triage`,
`proposal`, `ready` and `on-hold`; `needs-input` is a blocker modifier. This is
an adaptation, not a claim that Symphony implements the director or GitHub
hold inheritance. No Symphony implementation source is copied. Symphony's
latest release observed during this follow-up was v0.0.3 (2026-09-15); the
commit inspected above is newer development source and must not be described
as released behavior.

The same-thread wakeup candidate is supported by the installed `codex queue`
command and the current official [Codex developer command reference](https://learn.chatgpt.com/docs/developer-commands).
The CLI accepts a message for an existing session. That documents the queue
interface; it does not by itself qualify desktop wake delivery, busy-thread
queueing, restart behavior or quota effects. Those remain live acceptance
questions for a separately authorized campaign.

**2026-10-27 Windows proxy probe:** the local Codex CLI and generated
App Server protocol support connecting through the shared daemon proxy and
reading runtime thread status. In a read-only probe, the active Codex Desktop
chat returned `notLoaded` through the CLI daemon; a separate process confirmed
the status mismatch. The inspected protocol exposed no supported way for this
integration to attach to and observe that Desktop chat's live turn. Conductor
therefore rejects an unowned saved thread reported as `notLoaded`; it will not
assume that thread is idle or start a duplicate turn there.

The same shared CLI daemon supports creating and managing threads that
Conductor owns itself. That is a viable host-managed session path, but the
probe did not establish that such threads are visible or interactively
available in the Codex Desktop UI, nor verify same-thread concurrency against
a real running turn. The Windows probe was read-only and establishes no live
runner qualification. Product choice remains open: retain the intended Desktop
chat interaction by adding a supported lifecycle bridge, or accept a
Conductor-owned CLI session as the director surface. Do not describe either
path as qualified until its user-visible interaction and busy/idle behavior
are demonstrated in a separately authorized live trial.

## Requirements identified

The comparison did not find a released candidate that established all of these
behaviors together:

- project-specific limits on concurrent primary issues, kept distinct from
  Codex helper threads;
- ownership of one issue and its original builder session through repair,
  review, actual merge, and base synchronization;
- safe delivery of changed review or check evidence to the correct pending
  builder, including restart and uncertain transport outcomes;
- accurate issue state after merged and closed-unmerged PRs; and
- waiting for capacity, checks, or review without starting model turns merely
  to poll.

These are integrated acceptance boundaries. A queue, saved directory, webhook
response, passing component test, or PR link alone does not establish the full
issue-to-landing lifecycle.

## Pinned candidate observations

| Source inspected | Useful evidence | Boundary observed then |
| --- | --- | --- |
| [Itervox v0.2.1](https://github.com/vnovick/itervox/releases/tag/v0.2.1), source [`cb09d4b`](https://github.com/vnovick/itervox/tree/cb09d4bf1711f86479b47e4d9c665df07045ac88) | GitHub intake, bounded admission, dependencies, local Codex login, and saved-session continuation. | Input enqueue did not establish delivery to the intended pending question or acknowledge consumption; external merge reconciliation and Windows/WSL toolchain support were not established. |
| [Agent Orchestrator v0.14.3](https://github.com/OrchestratorInc/agent-orchestrator/releases/tag/v0.14.3), [SCM observer](https://github.com/OrchestratorInc/agent-orchestrator/blob/v0.14.3/backend/internal/observe/scm/observer.go) | Native PR/CI observation and retained-worker feedback. | The inspected hard-intake-cap change [#5649](https://github.com/OrchestratorInc/agent-orchestrator/pull/5649) was still open at that revision; that fix was not part of v0.14.3. |
| [GitHub Agentic Workflows v0.92.0](https://github.com/github/gh-aw/releases/tag/v0.92.0), [work queue](https://github.com/github/gh-aw/blob/v0.92.0/docs/src/content/docs/reference/work-queue.md) | A bounded fair dependency-aware queue was implemented. | Its Actions execution and authoritative Git ledger differ from the local Codex subscription workflow under consideration. |
| [OpenAI Symphony v0.0.3](https://github.com/openai/symphony/releases/tag/v0.0.3), [tagged README](https://github.com/openai/symphony/blob/v0.0.3/elixir/README.md) | A concrete GitHub issue integration and landing reference. | The tagged README described prototype software for evaluation; it was not deployment qualification. |

This comparison led to explicit ownership, confirmation, bounded issue capacity,
and recovery requirements. It did not authorize an upstream submission, service,
production run, installation into a user's normal Codex home, or model campaign.
The current implementation and the live qualification status must be judged
from their own code, test receipts, and bounded evidence.

## Provenance boundary

The adopted PR feedback receipt helper derives from
EveryInc/compound-engineering-plugin's `ce-resolve-pr-feedback` at
`8673dfb96ad62c5e0cb6bc50fce312e7a66487a0`. Its attribution and MIT terms are in
[`plugins/conductor/THIRD_PARTY_NOTICES.md`](../plugins/conductor/THIRD_PARTY_NOTICES.md).
No Itervox, Agent Orchestrator, GitHub Agentic Workflows, or OpenAI Symphony
runtime source was copied as part of this research transfer.
