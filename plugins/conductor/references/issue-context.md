# Resolve the issue and preserve its current state

An issue target is optional for actions that also support a direct local request.
Accept a number, `#number`, issue URL or name. An explicit target wins over saved
context. Otherwise use the first established current issue in this order: this
session, this worktree, then this repository's work context. Never choose the newest issue or a
global current issue. If no issue is established and the user gave a direct local
request, work from that request without forcing issue creation.

For a URL, verify the repository against the checkout. A foreign repository URL
does not authorize a checkout switch. Report the mismatch and establish the
intended target before dependent work.

For a name, search all relevant result pages and exclude pull requests. First try
a unique normalized exact title match (trim/collapse whitespace and compare case
insensitively). If there are duplicate exact matches or only ambiguous partial
matches, show every relevant candidate as `[ID]: [name]`, followed by its number
and a short description when useful. Ask for an ID; do not pick the newest or
highest-ranked result. Include closed issues for $conductor:open-change and every
explicit target. Do not omit a matching candidate
because it appears on a later page.

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
