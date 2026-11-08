---
name: pair-program
description: Pair program through a rolling wave workflow with managed-worker Plan Mode, human phase decisions, implementation and independent review.
---

# Pair program one agreed phase at a time

Keep the current coordinator visible in this chat. Work on one issue or the user's
direct local request; do not force issue creation. Follow
[repository scope](../../references/repository-scope.md),
[issue context](../../references/issue-context.md) when applicable,
[phase workflow](../../references/phase-workflow.md) and
[phase artifacts](../../references/phase-artifacts.md).

Read [managed work](../../references/managed-work.md) before starting a worker.
Use its exact foreground bridge API for a persistent ordinary AppServer worker.
The coordinator owns that worker, its questions and write boundaries. Do not use
native v2 subagent RPC, take over Desktop's private server or create another user
chat. Keep one live JSONL client through questions. Preserve the original worker
for related implementation and repairs and the independent reviewer for rechecks.

## Plan through actual human dialogue

Keep the visible coordinator in Default mode during the ordinary workflow.
Configure the owned managed worker in actual Plan Mode for initial phase planning
and substantive replanning. Relay its live questions to the human and return the
answers through the same live bridge client. A heading or approval does not
establish the worker's mode; verify the actual configured turn mode.

If the coordinator's host is itself in Plan Mode, obey its write restrictions.
Do not bypass that restriction through a worker or another path. Saving the plan
requires an authorized writable coordinator turn; this exceptional host gate does
not make a user mode switch part of the ordinary workflow.

Recover accepted goals, current roadmap, constraints and decisions. Use
$conductor:plan-change to develop complete next-phase behavior, consumers,
interfaces, owners, acceptance, verification, resources and stopping point.
Keep later phases broad. Discuss consequential choices with the human and use
$conductor:ask-user for decisions that remain theirs. Do not require repeated
approval for already authorized routine choices.

After the dialogue, human phase decision and terminal completion of the planning
turn, save the agreed tracked plan through the coordinator. The worker's Plan turn
returns plan content; it does not save the repository plan or make issue writes.
Complete substantive issue-body changes before independent review.

## Implement and review the authorized phase

Begin implementation only when the phase is authorized. Compact the completed
planning turn and switch the managed worker to Default mode through the supported
bridge protocol. Use $conductor:apply-change through that same owned worker.
Verify catalogue availability. Use Astra high for complex production planning
and Sol 6.1 xhigh for bounded planning. Use Sol 6.1 high for implementation and
Astra medium for independent review. Follow the managed-work protocol: compact at a
completed-turn boundary before changing model or effort, await correlated success,
apply settings atomically, then start the next turn. Report missing required
models; do not silently substitute.

Finish connected implementation and required checks, then commit task-owned work.
Start $conductor:review-change with fresh initial context, complete requirements,
task-start baseline and full cumulative diff, current issue/request revision and
exact head, without the builder's verdict. Preserve the builder's tools and
permissions. The original builder repairs findings and the same reviewer rechecks.
Stop dependent work and return to the planning dialogue if evidence invalidates
the accepted approach; apply the two-failed-repair reassessment rule.

## Report, decide and finish

Use $conductor:report-phase after review and repair. Commit its authored report,
then have the same reviewer confirm the documentation delta and exact final head.
Reuse unaffected checks and review evidence; do not start a report recursion.
Return the phase result, limits and tracked report to the human. Let the human
decide the next phase; a proposed next phase is not permission to execute it.
For the next planning turn, configure the managed worker in actual Plan Mode
through the same completed-turn transition protocol.

Keep delivery separate from the phase result. Complete authorized publication,
landing and $conductor:close-change only when their requirements are met. Preserve
holds and unresolved delivery operations. When the requested work and authorized
delivery are complete, STOP. Do not choose another issue or turn the human
checkpoint into background automation.
