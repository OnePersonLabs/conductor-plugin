---
name: explore
description: Investigate product source and explore ideas, requirements or design options through a read-only discussion. Map what exists and what is missing without implementing changes or requiring an issue or plan artifact.
---

# Explore the current system

Follow the question that helps the user understand the problem or choose a
direction. Trace concrete source behavior, clarify requirements and compare
grounded alternatives as needed. Do not force an implementation plan or a fixed
interview sequence.

Identify the user's question and target directory. Read current instructions and
relevant source, consumers and failure paths. Read-only local exploration needs
no Git repository, Conductor configuration, issue or artifact.

When the question targets GitHub work, follow [repository scope](../../references/repository-scope.md)
for issue operations and [issue context](../../references/issue-context.md) for
the target. Local source investigation remains available without GitHub setup.

Explain the observable behavior, the evidence that supports it and what remains
unknown. Recover accepted meaning from its existing owner when a distinction
changes the answer. Distinguish recorded reasons from inference.

Use source reads, read-only commands and bounded read-only helpers when they
improve the investigation after setup and integration cost. Give helpers a clear
question, scope, evidence requirement and stop condition. No issue, saved plan,
Conductor configuration or director is a prerequisite.

Do not mutate project files or external state, create issues, save plans or start
a coordinator, director or background service. A helper has only the read-only
authority of this exploration.
Return findings and consequential unanswered questions. Exploration does not
require a planning ceremony or authorize implementation.
