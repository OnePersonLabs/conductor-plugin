# Symphony Lite PR delivery

Use this page to understand the coordinator's PR path. The repository's
configured checks and GitHub branch protections remain authoritative.

The builder works in the issue branch and reports its acceptance result. The
coordinator verifies committed source against configured checks, pushes the
branch, creates the PR, and records its PR number. It does not use a PR closing
keyword; it checks merge and acceptance itself.

While a PR is open, the coordinator observes check results, requested changes,
reviews, and comments. New feedback or failed checks is sent to the original
builder for repair. The issue stays assigned to that builder and continues to
occupy an issue slot while it waits for review or merge.

Auto-merge is requested only after configured checks pass, no change request
remains, the PR is not draft, and the configured number of approvals is present.
GitHub can continue waiting for its branch-protection requirements. The selected
`mergeMethod` controls the requested merge type. Symphony Lite does not provide a
separate human merge-approval step once these conditions are met.

After merge, the coordinator fetches the selected base and verifies that it
contains the merged revision. It closes the issue only if the builder's result
also marked acceptance complete. If the PR closes without merge, the issue
remains blocked. If merge cannot be proven in the base or acceptance is
incomplete, the issue remains open for operator reconciliation.

A local push, a PR marked closed, an auto-merge request, or a finished Codex turn
alone does not establish completed delivery. Inspect the PR, base, issue
acceptance, and saved runtime status before reporting success.
