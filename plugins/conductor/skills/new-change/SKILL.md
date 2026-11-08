---
name: new-change
description: Create a named GitHub change issue with a clear purpose, type and repository labels, without planning or implementation.
---

# Create a named change

Follow [repository scope](../../references/repository-scope.md) for issue work and
[issue context](../../references/issue-context.md). Expect a name for the new
change. If the request has no usable name, ask for it before creating the issue.

Read repository issue conventions, templates, existing type labels and current
related work. Classify the change from its purpose using those conventions.
Honor explicit user type and label overrides unless they conflict with a required
repository constraint; explain that conflict before writing. Do not invent a
universal type taxonomy.

Check for duplicates across relevant pages, including closed outcomes that could
already satisfy the request. Resolve ambiguity with the user instead of creating
another issue. A unique existing equivalent can become the current issue after
explaining the match; do not silently overwrite it.

Create only the authorized issue record: name, purpose, known outcome, supplied
constraints, appropriate type and labels. Use [shared issue policy](../../references/workflow.md)
for state and relationships. New planning does not establish readiness or
implementation authority. Preserve current user text and concurrent metadata.
State intended writes and read back the created issue.

Keep the resolved issue current in this session. Return its ID, link and known
gaps. Do not plan, implement, create a director or close related work.
