---
name: verify-change
description: Verify issue X or an explicitly requested change against acceptance scenarios and report completeness, correctness and coherence.
---

# Assess acceptance evidence

Select this capability for an explicit acceptance-assessment request such as
“verify issue X.” Routine test completion does not select it.

Follow [repository scope](../../references/repository-scope.md) and
[issue context](../../references/issue-context.md). Read the full accepted outcome,
current requirements, dependencies, implementation, checks and review evidence.
Do not equate a passing command with complete acceptance.

Assess completeness, correctness and coherence through concrete scenarios and
connected consumers. For each material criterion, report one of: implemented
with supporting evidence; missing; not verified; or not applicable with a reason.
State the revision and environment to which the evidence applies. Distinguish
source inspection, exercised behavior and human comprehension. Use bounded
authorized diagnostics only when they can resolve a consequential uncertainty.
Keep product or environment claims unverified when the available evidence cannot
support them.

Return an advisory acceptance account with the remaining gaps and their owners.
Do not edit code, repair the implementation, change requirements, close the issue
or declare delivery from this assessment. The original builder owns repairs.
