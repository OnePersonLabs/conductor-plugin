# Keep phase plans and reports with the work

Use tracked files in the target Git repository:

```text
.conductor/plans/<UTC timestamp>_phase-plan_<slug>.md
.conductor/reports/<UTC timestamp>_phase-report_<slug>.html
```

The timestamp is UTC with zero-padded fields and milliseconds:
`yyyyMMddTHHmmssfffZ`, for example `20261108T112233047Z`. Derive a readable slug
from the phase name. Create files without overwriting existing paths. If a name
collides, obtain a fresh timestamp or append a distinguishing suffix and retry
exclusive creation. Do not replace an unrelated artifact.

A plan records the outcome, accepted constraints, broad later phases and the
complete next phase: behavior, consumers, interfaces, owners, acceptance,
verification, dependencies, resource constraints and stopping point. Link its
issue or direct request and relevant evidence. Preserve uncertain claims as
uncertain. A substantive replan creates a linked successor plan; identify the
superseded plan in both directions. Do not silently rewrite accepted history.

The visible coordinator normally stays in Default mode while its managed worker
plans in actual Plan Mode. After the planning turn completes and the human phase
decision is established, the coordinator saves the agreed plan. The worker returns
plan content and evidence; the coordinator owns saving and issue updates. If the
coordinator's host is itself in Plan Mode, its write restrictions still apply.
Do not bypass that host restriction through a worker or another execution path.

A phase report is authored durable content, not temporary diagnostics. Repair the
same report in place when its account or presentation needs correction. Use
`$conductor:report-phase` for the report and static HTML graph. Keep raw logs and
disposable captures out of these records. Existing recovery owners retain only
the unresolved state their contracts require.

The issue contains high-level phases, acceptance and native sub-issues. Link the
tracked files instead of copying their detailed plans into a second task ledger.
Complete substantive issue-body changes before independent review because they
can invalidate the reviewed requirements. Add later report links in comments
unless the body must change for a substantive reason; preserve concurrent edits.

Commit task-owned implementation before independent review. Review the complete
task change against its recorded start baseline. A report created after that
review changes the final head: commit the report, then return the documentation
delta to the same reviewer for confirmation of that exact final head. Reuse
unaffected checks and review evidence. Do not create another report merely to
report that confirmation. Delivery uses the final confirmed head.
