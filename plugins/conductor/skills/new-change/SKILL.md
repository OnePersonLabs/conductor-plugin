---
name: new-change
description: Create a named GitHub change issue with a clear purpose, type and repository labels, without planning or implementation.
---

# Create a named change

Follow [repository scope](../../references/repository-scope.md) for issue work and
[issue context](../../references/issue-context.md). Expect a name for the new
change. If the request has no usable name, ask for it before creating the issue.

Read repository issue conventions, templates, enabled native issue types,
existing labels and current related work. Choose the native type and labels from
the change's purpose using those conventions. Native issue types and labels are
separate fields; a `bug` label does not set the native `Bug` type. Honor explicit
user type and label overrides unless they conflict with a required repository
constraint; explain that conflict before writing. Do not invent a universal type
taxonomy.

Check for duplicates across relevant pages, including closed outcomes that could
already satisfy the request. Resolve ambiguity with the user instead of creating
another issue. A unique existing equivalent can become the current issue after
explaining the match; do not silently overwrite it.

Create only the authorized issue record: name, purpose, known outcome, supplied
constraints, appropriate type and labels. Use [shared issue policy](../../references/workflow.md)
for state and relationships. New planning does not establish readiness or
implementation authority. Preserve current user text and concurrent metadata.
State intended writes and read back the created issue.

## Set and verify the native issue type

Enumerate the target repository's enabled types with
`GET /repos/OWNER/REPO/issue-types`. An available authenticated CLI can perform
this read even when the connector has no issue-type field:

```text
gh api repos/OWNER/REPO/issue-types
```

Match the user's override or selected classification to the returned type.
Use its canonical `name` for REST's `type` field, not its numeric `id` or `node_id`.
Do not assume that example names such as `Bug`, `Feature` or `Task` are enabled.

Create with `POST /repos/OWNER/REPO/issues` and include `"type": "Bug"` when
`Bug` is the selected enabled name. If the creation tool omits the type, set it
on that same issue with `PATCH /repos/OWNER/REPO/issues/NUMBER`. A connector's
missing field does not establish that GitHub cannot set native types. Before
falling back to labels, use another available authorized API path, such as:

```text
gh api --method POST repos/OWNER/REPO/issues --input ISSUE.json
gh api --method PATCH repos/OWNER/REPO/issues/NUMBER -f type=Bug
gh api repos/OWNER/REPO/issues/NUMBER
```

The POST example is an alternative creation path, not a second issue creation.
`ISSUE.json` contains the complete authorized title, body, labels and selected
`type`. Preserve unrelated fields when patching. Dispose of a temporary payload
after its remote effects are reconciled. Reconcile an uncertain POST before retrying.

Read back the issue's native `type.name` and labels. GitHub can silently drop
type or labels without sufficient repository access; a successful request alone
does not prove that either was applied. If the selected type is unavailable or
no authorized API path can apply it, report the concrete limitation and use the
repository's conventional labels where supported. Do not silently drop an
explicit override, substitute another native type or claim that labels fulfilled
the native-type request. Report any remaining mismatch.

See GitHub's [enabled repository types](https://docs.github.com/en/rest/repos/issue-types#list-issue-types-for-a-repository),
[issue creation](https://docs.github.com/en/rest/issues/issues#create-an-issue),
[issue updates](https://docs.github.com/en/rest/issues/issues#update-an-issue) and
[CLI API payloads](https://cli.github.com/manual/gh_api) for the supported contracts.

Keep the resolved issue current in this session. Return its ID, link and known
gaps. Do not plan, implement, create a director or close related work.
