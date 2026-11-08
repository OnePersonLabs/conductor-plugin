---
name: rolling-wave-report
description: Explicitly report existing phase results, evidence and unfinished work with a static responsive HTML graph.
---

# Report the phase result

Report completed or existing work retrospectively. This capability can run on its
own; it does not start execution or prescribe a planning mode or human checkpoint.
Follow [repository scope](../../references/repository-scope.md) for tracked local
artifacts and [phase artifacts](../../references/phase-artifacts.md) for the saved
report path and review lifecycle. Read [checkpoint delivery](references/checkpoint.md)
before authoring or repairing the report.

The checkpoint reference owns report content, graph construction and visual
checks, using [the static HTML template](assets/navigation.html). Follow that
single presentation contract when creating or repairing the report.

Return a concise result and a clickable link using the report's absolute path.
Repair the same report in place. If it adds a final documentation delta after
implementation review, commit it and return that delta to the same reviewer for
confirmation of the final exact head. Reuse unaffected evidence. Report authorship
does not authorize issue closure, publication, implementation or another phase.
