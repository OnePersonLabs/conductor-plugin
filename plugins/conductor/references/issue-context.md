# Resolve the issue and preserve its current state

An issue target is optional for actions that also support a direct local request.
Accept a number, `#number`, issue URL or name. An explicit target wins over saved
context. Otherwise use the first established current issue in this order: this
session, this worktree, then this repository's work context. Never choose the newest issue or a
global current issue. If no issue is established and the user gave a direct local
request, work from that request without forcing issue creation.

## Resolve identity with the read-only CLI

When the action requires an existing issue, call the canonical resolver from the target
checkout. Do not run it merely to investigate or implement a direct local request
that needs no issue. Resolve the plugin root from this installed skill package:

```text
node <plugin-root>/bin/conductor.mjs resolve-issue --target "ID, #ID, URL or name"
node <plugin-root>/bin/conductor.mjs resolve-issue --current ID
node <plugin-root>/bin/conductor.mjs resolve-issue
```

For every new user request, call it again with that request's literal target.
Do not reuse a prior candidate list, inferred filter or normalized query. Use
`--current` only when no explicit target was supplied and this session, worktree
or repository already established that issue. The helper does not save current
context. An explicit target wins; errors and no match never fall back to current.

The resolver applies the issue-scope check and fetches fresh GitHub data. Name
matching includes every page, open and closed issues, and excludes pull requests.
A unique exact title match wins after whitespace normalization and case folding.
Duplicate exact matches produce choices from that exact tier only. If no exact
match exists, all partial matches produce choices, even if there is only one.
Every selection list is in descending issue-number order.
An absent target and current produce a selection list, even if only one issue
exists; the newest issue is never an implicit target.

Handle the JSON result by `status`:

- `resolved` contains the repository, literal `query` or `currentUsed`, and the
  full fresh `issue` snapshot. Only now check state and choose the requested action.
  This issue can become current in the conversation; resolution grants no write authority.
- `selection-required` contains `candidates` with only `number` and `title`, plus
  the preformatted `selection`. Show that complete string verbatim and ask for
  an issue ID. Rows are `[42]: Issue name`, separated by newlines. Do not replace
  them with counts, summaries, state groups or an earlier list. Preserve the
  previous current issue until one identity resolves. If the list is empty,
  say no issues are available instead of inventing a current issue.
- `not-found` means a successful name query found no matches. Report the literal
  target and ask for another target; preserve previous current context.

Authentication, transport, malformed configuration, inaccessible numeric IDs,
pull-request targets and foreign repository URLs are errors. Report the concrete
error; do not relabel it as no matches or silently search a different target.

For a URL, verify the repository against the checkout. A foreign repository URL
does not authorize a checkout switch. Report the mismatch and establish the
intended target before dependent work.

Do not implement another title search in a caller. The shared resolver owns
identity matching and selection formatting; the requested action owns what
happens after identity resolves.

Read the current issue body, history, labels, native blocked-by relationships,
parent and sub-issues before changing work. Recover accepted decisions and any
linked tracked plan and report. Optional Conceptor records supply accepted product
meaning; issue activity alone does not replace that owner or authorize new scope.

Read [shared issue policy](workflow.md) before tracker mutations. The current
coordinator owns authorized issue writes; a delegated planner, builder or reviewer
returns proposed changes. State intended writes before acting. Re-read the issue
immediately before each write, preserve concurrent unrelated text and metadata,
use expected revisions when supported, then read back the result. Reconcile an
uncertain write before retrying. Authentication, an issue label and a completed
plan do not grant execution authority.

Keep the resolved issue current in this session after closure. Do not silently
move to another issue. `$conductor:continue-change` stops on a closed current
issue. Reopening does not restore previous verification claims or authorize work.
