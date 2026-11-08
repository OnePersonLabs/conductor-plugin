# Coordinate phases through one current owner

`$conductor:pair-program` owns the human phase dialogue. `$conductor:direct-workflow`
owns explicitly requested autonomous coordination. Both compose the same action
skills and preserve the issue, local ownership and delivery contracts. An ordinary
action never starts either coordinator or background automation.

| Activity | Capability |
| --- | --- |
| Read and understand the current system | `$conductor:explore` |
| Establish a named issue | `$conductor:new-change` |
| Establish an issue and its next-phase plan | `$conductor:propose-change` |
| Plan complete next-phase work, keep later phases broad | `$conductor:plan-change` |
| Reconcile a plan with accepted decisions and current facts | `$conductor:update-change` |
| Implement, check and repair authorized work | `$conductor:apply-change` |
| Review the complete stable change independently | `$conductor:review-change` |
| Assess acceptance from scenario evidence | `$conductor:verify-change` |
| Present the completed phase and its limits | `$conductor:rolling-wave-report` |
| Select one next action | `$conductor:continue-change` |
| Close completed work or reopen a closed issue | `$conductor:close-change`, `$conductor:open-change` |

Use [phase artifacts](phase-artifacts.md) for the tracked plan/report lifecycle
and [managed work](managed-work.md) for the exact foreground bridge command API.
Do not invent an AppServer command or use native v2 subagent RPC. The coordinator
remains visible in the current chat and owns ordinary managed workers. It does
not take over Codex Desktop's private server or create a replacement user chat.

For pair programming, the visible coordinator normally stays in Default mode.
Configure its managed worker in actual Plan Mode, relay live questions to the
human and complete the phase dialogue. After the planning turn has completed,
the coordinator saves the accepted tracked plan. Compact at the completed-turn
boundary and switch the worker to Default mode for implementation. Independently
review and repair, then report and return to the human for the next phase decision.
Finish authorized delivery and closure, then stop.

If the coordinator's host is itself in Plan Mode, obey that host's write
restriction. Do not bypass it through a worker or save artifacts until a writable
coordinator turn is authorized. A worker mode does not change the host mode.

Synchronous autonomous coordination can plan and continue within accepted scope
without routine human phase gates. It asks for genuine product or authority
decisions. Explicit background mode retains the existing lifecycle, original
worker identity, holds, admission pauses, issue revisions and delivery controls.

Follow [managed work](managed-work.md#select-the-production-model-and-effort) for
production model selection, availability and completed-turn settings transitions.
Keep one live JSONL client through worker questions. An unavailable required
model blocks that dependent step.

When available, use $onepersonlabs:write-technical for developer explanations,
specifications, plans, reports and PR text; use $onepersonlabs:write-documentation
for user or contributor documentation and $onepersonlabs:write-ui for application
copy. These are optional writing helpers, not Conductor prerequisites. Lead with
the reader's goal or result, explain concrete behavior and preserve consequential
conditions, evidence and uncertainty.

During implementation through $conductor:apply-change, for each significant batch,
state an evidence-based agent elapsed-time range
when comparable completed work supports one. Otherwise say the estimate is
unknown and identify the missing comparison. Account for preparation,
implementation, verification, coordination, repair and waiting when they affect
the next decision. Do not add parallel durations as elapsed time. Compare at
natural work boundaries when a range is exceeded, scope expands or failures
repeat. Do not run a sleeping timer agent or a separate timing service.

After two failed repair cycles without progress on the same observable problem,
stop dependent implementation. Compare bounded repair, replacement of the affected
responsibility and revision of the failed assumption. Require new evidence before
changing the causal hypothesis or next decision. Use $onepersonlabs:optimize-workflow
when available and useful. Otherwise inspect the cost and delay of the next batch.
Remove repeated preparation and retain required checks. Choose a smaller coherent
batch or a different supported mechanism. This fallback needs no companion skill.
