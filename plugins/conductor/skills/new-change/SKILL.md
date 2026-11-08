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
gh api repos/OWNER/REPO/issues/NUMBER --jq '{number, type_name: (.type.name // null), labels: [.labels[].name]}'
```

The POST example is an alternative creation path, not a second issue creation.
`ISSUE.json` contains the complete authorized title, body, labels and selected
`type`. Preserve unrelated fields when patching. Dispose of a temporary payload
after its remote effects are reconciled. Reconcile an uncertain POST before retrying.

Count the native type as applied only when a fresh issue GET returns `type.name`
exactly matching the selected canonical name. An absent, null or mismatched value
is not success, even if enumeration lists the type or a write echoes its input.
If needed and authorized, make one same-issue PATCH followed by another GET;
do not repeat a PATCH already attempted for this mismatch. If the value still
does not match, report native assignment as unavailable or unconfirmed for this
operation and use the repository's conventional labels where supported.

Verify the returned labels separately. GitHub can silently drop fields without
sufficient access, but missing native assignment can also reflect repository-owner
feature availability. Do not diagnose missing permissions from a null type alone.
GitHub documents [organization issue types](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-types-in-an-organization)
and [removal of types on transfer to a personal account](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository#whats-transferred-with-a-repository).
Report the observed type and labels, any known limitation and the unsatisfied
override. Do not silently substitute another native type or claim that labels
fulfilled a native-type request.

See GitHub's [enabled repository types](https://docs.github.com/en/rest/repos/issue-types#list-issue-types-for-a-repository),
[issue creation](https://docs.github.com/en/rest/issues/issues#create-an-issue),
[issue updates](https://docs.github.com/en/rest/issues/issues#update-an-issue) and
[CLI API payloads](https://cli.github.com/manual/gh_api) for the supported contracts.

Keep the resolved issue current in this session. Return its ID, link and known
gaps. Do not plan, implement, create a director or close related work.
