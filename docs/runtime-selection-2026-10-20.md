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

The selected design keeps the Desktop chat as the director. Desktop lifecycle
hooks report prompt start, stop and interruption to Conductor, and wakeups are
delivered through the Desktop session queue when that director is idle. This
path avoids inferring Desktop activity from the CLI's separate daemon. A
“wakeup” message typed in Desktop is already a live user turn; its hook tells
the service not to send a second prompt. If Desktop is closed, the service
cannot launch or resume its private server; a queued wake is stored for the
native host to consume when it loads the bound chat. Delivery across restart
has not yet been qualified in a live trial. For a new repository, the initial director prompt binds
that native thread as its first action; setup waits for host completion and
verifies the saved binding before allowing issue inspection or dispatch.

The Windows proxy probe was read-only and does not qualify the Desktop hook,
queue delivery, busy/idle suppression, restart recovery, user-visible thread
creation or quota effects. Those behaviors still require a separately
authorized, budgeted live trial. The CLI daemon remains available for terminal
clients, but its sessions are not the selected Desktop director surface.

## Requirements identified

**2026-10-27 bounded Windows Desktop trial:** publication and Windows/WSL
installation completed, with five Conductor hooks trusted in each home. A
fresh app-server listed those five hooks; the already-running shared daemon
listed none. A new native Desktop chat enabled the admission-paused observer
and settled revision 2, but no native lifecycle receipt appeared and activity
remained `unknown`. Automatic wakeup was therefore suppressed. This does not
qualify queued delivery. The trial observer was explicitly stopped with zero
jobs. Repeat after a full Desktop restart; opening a new chat alone was
insufficient in this trial.

**2026-10-27 resumed trial after Desktop restart:** the saved native chat
restarted observation and settled revision 4 with admission paused. The first
status read remained `unknown`, but later inspection found the matching manual
turn's active/idle receipts (revision 2). The earlier missing-receipt conclusion
was premature. The Desktop binary (0.165.0-alpha.1.2), queried in a
fresh read-only app-server, listed all five Conductor hooks as trusted and
enabled. Another installed hook recorded the trial's actual `Stop` event, but
Conductor's temporary, metadata-only lifecycle probe produced no receipt.
The earlier cache diagnosis therefore does not establish the cause.

A direct native `thread/queue/add` probe woke that same Desktop chat. It
reported receipt of the queued message, inspected and settled revision 4, and
returned to idle; the native queue was empty afterward. This establishes
native queue delivery on the loaded Desktop chat, not Conductor's automatic
idle detection. Two live turns were used in this resumed trial. The observer
was stopped, no issue jobs ran, and the temporary probe was removed. Resolve
the missing Conductor lifecycle receipts before declaring automatic wakeup
qualified; do not synthesize an idle receipt or repeat restart as a proven fix.

**2026-10-27 follow-up diagnosis:** a human `wakeup` produced a second matching
active/idle pair. In the subsequent three-turn bounded trial, one delegated
diagnostic turn and two automatic native queue turns ran with admission paused.
Both automatic turns handled their batches and settled revisions 7 and 8.
Conductor activity nevertheless remained at the earlier manual turn's revision
4, while the existing OnePersonLabs hook recorded the automatic turn's Stop.
The Conductor probe recorded no invocation, including before JSON parsing.
This isolates the remaining investigation to Conductor hook selection or launch;
it does not establish an upstream cause. Native queue delivery is demonstrated,
but automatic busy/idle tracking is not qualified. The observer was stopped
with zero jobs and the temporary instrumentation was removed.

Conductor now suspends subsequent automatic wakes when queue deletion reports
that a settled message is absent and there is no matching native consumption
receipt. Acknowledgement cannot release this hold by reusing older idle state.
A matching native receipt or a new explicit native turn can recover it. The
safety change has deterministic coverage; it has not had another live turn.

**2026-10-27 Desktop reload and bounded acceptance:** the earlier diagnostic
ran after stdin finished; its silence did not establish missing invocation.
This trial instrumented process entry, input completion, parsing, imports,
handler result and exit, without prompt contents. Two initial turns produced
neither the trial-scoped entry trace nor new Conductor receipts. The actual
Desktop Settings > Hooks listing showed the five Conductor hooks enabled.
Refreshing installation/trust alone and an ordinary composer submission did
not change the result. Toggling the Conductor UserPromptSubmit hook off and
back on through native Desktop settings did: the next ordinary `wakeup`
recorded entry, input completion, successful handling and exit, followed by
matching active/idle receipts for native turn
`01a18010-86cd-7741-8979-2e3db282e1ec` (activity revisions 5 and 6).

The demonstrated repair is native runtime configuration reload. The exact
internal stale object was not observed. Codex's
[plugin trust implementation](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/plugin_trust.rs)
compares current bundle contents with captured trust, and its
[configuration processor](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server/src/request_processors/config_processor.rs)
can refresh loaded thread configuration. Those mechanisms support the stale
runtime explanation; they do not prove a particular trust rejection occurred.
No handler logic, timeout, registrations or native thread ownership changed.

Temporary instrumentation was removed and the clean plugin refreshed in both
Windows and WSL. The same native settings reload was applied. The observer
was stopped and restarted with the saved chat binding; `conductor wakeup`
then created batch `780e6a69-4ad9-409a-9c04-06737f75965a`, queue item
`01a18012-c2ba-7522-a5d1-eeaa7df8a7b6`, and actual native turn
`01a18012-d18b-7d93-8158-c0f5d1e5d919`. SQLite independently showed active
revision 7 and idle revision 8 with that exact turn and batch marker.
Persisted state recorded native consumption and settlement of check revision
13. Three passive signals while active left the batch count unchanged;
there were no remaining events or pending checks. Native queue listing was
empty and Desktop reported the same completed turn and idle chat. No fifth
director turn was submitted; a subsequent quiet interval of more than three
minutes showed the same completed turn and no new native turn. The existing
OnePersonLabs watch record independently recorded Stop at the final turn's
completion timestamp. Admission stayed paused with zero issue jobs and
no trial GitHub writes. This establishes automatic delivery and lifecycle
tracking together on this host, not production worker delivery.

Shutdown encountered a separate `EPERM` replacing `state.json` on Windows.
The stop request was consumed but did not finish saving shutdown state. The
verified trial observer PID was terminated; its stale recovery metadata was
preserved rather than rewritten to claim a clean shutdown. Automatic wakeup
passed; graceful shutdown under that persistence error remains a separate
limitation. Computer use was limited to installation recovery and the manual
composer test, never the normal Conductor runner.

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
