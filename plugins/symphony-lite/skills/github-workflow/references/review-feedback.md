# Preserve and resume PR feedback

Use this receipt when a reviewed batch has a remote tail that may outlive the
current turn, or when an interrupted reply/resolution sequence must resume
without repeating judgment. The authorized caller retains responsibility for
the checkout, edits, commit, publication, replies, resolutions and PR body. The
receipt preserves the reviewed decision and observed progress; it grants no new
authority. The helper never mutates GitHub.

## Prepare before editing

Choose the handoff path and preflight it before making changes. For a private
scratch receipt, omit `--path`; retain the absolute path returned by preflight.
For a caller-supplied path, preserve that exact path. Preflight refuses existing
paths and tests exclusive temporary-file creation in the parent.

```powershell
$skillDir = (Resolve-Path '<absolute github-workflow skill directory>').Path
python "$skillDir/scripts/pending-feedback.py" preflight --path '<handoff path>'
```

If preflight fails, stop before edits. Do not replace a rejected path. Without
`--path`, preflight creates a private scratch directory and returns its unused
`pending.json` path; the caller owns its retention.

After judgment, prepare a separate UTF-8 JSON input file. Capture the PR host,
base repository, number and canonical URL, plus the actual head repository/ref
from fetched PR metadata (fork PRs can have different base and head repos).
For each covered feedback item retain its stable identity, URL, exact decoded
body SHA-256, verdict, exact reply body and whether an authoritative thread
resolution is required. Hash the original fetched body bytes encoded as UTF-8;
do not hash a paraphrase or a normalized reconstruction. Carry typed
`needs-human` decision context and residuals without collapsing them to prose.
Store exact planned PR checklist bullets and versions changing only `[ ]` to
`[x]`.

```powershell
python "$skillDir/scripts/pending-feedback.py" create --input '<prepared JSON>' --path '<preflight handoff path>'
python "$skillDir/scripts/pending-feedback.py" validate --path '<handoff path>'
```

Creation validates original JSON bytes, rejects duplicate JSON keys, uses
exclusive creation with private file permissions, fsyncs and reads the receipt
back. Do not retype a received receipt before validation. A receipt has
`schema_version: 1`, `status: pending`, PR identity, `fix_commit` (full lowercase
40-character SHA, or `null` for no code change), actual verification outcome,
`actions`, `body_ticks`, and typed `residuals`. Action kinds are `thread`,
`comment`, and `review`; thread actions carry stable thread and root-comment
IDs. The allowed verdicts are `fixed`, `fixed-differently`, `replied`,
`not-addressing`, `declined`, and `needs-human`. Only an ordinary thread verdict
requires resolution. A `needs-human` action carries its typed decision context
and stays open.

For a code-fix batch, finish authorized local validation and record the actual
commit SHA before saving the receipt. Do not publish here. Save the whole
reviewed remote tail, including actions that themselves required no code
change. A no-change batch records `fix_commit: null`; verification must still
describe what was actually checked. Keep the exact reply bytes and any
successful-but-not-yet-verified progress.

## Checkpoint and recover

After each verified remote action, update only progress and status in a separate
input file and checkpoint it:

```powershell
python "$skillDir/scripts/pending-feedback.py" checkpoint --input '<updated receipt JSON>' --path '<handoff path>'
```

Checkpoint writes atomically and refuses changes to prepared PR identity, fix
SHA, verification, action/source identities, exact replies, verdicts, tick
intent, or human decisions. It validates the replacement before and after the
write. Progress records observations; fresh GitHub state remains authoritative.
If a later write fails, preserve earlier verified progress, leave the batch
pending, and report the specific blocker.

On resume, validate and inspect publication before any reply, resolution, or PR
body write:

```powershell
python "$skillDir/scripts/pending-feedback.py" inspect-publication --path '<handoff path>'
```

This performs read-only `gh api` GETs. It fetches current PR metadata for the
saved host/base/number and verifies canonical URL, number, base repository,
head repository and head ref. For a non-null fix SHA it compares that commit to
the actual current head on the saved head repository; only compare status
`ahead` or `identical` with the fix SHA as merge base proves reachability. For a
null fix SHA, fresh identity verification is sufficient. An unverified result
exits successfully with `publication.verified: false`; exit code zero alone
never authorizes writes. Do not translate a missing SHA after rebase/squash or
infer publication from a push report. A non-null fix also requires saved
verification `passed` or `pre-existing-failure` before conversation completion.

After publication is proven, fetch fresh conversations through the supported
GitHub connector or read-only CLI. Exhaust every relevant page of review threads,
PR comments, reviews, and nested replies before matching sources or prior replies.
Follow each connection's cursor independently. A partial or unavailable result
cannot establish absence or completion; retain pending state and report the gap.
The root workflow must
reconcile every saved source by identity and current decoded body hash, and
inspect replies and resolution independently before retrying. A POST receipt or
saved progress is not proof of visible submission. Adopt a prior reply only
when its identity, exact decoded body, relationship to the saved source and
visible state are verified; then perform only any missing resolution. If the
process stopped after a successful POST, find and adopt that reply instead of
duplicating it. Changed source or related context remains pending for a new
judgment; do not rewrite the stored decision or reopen a resolved thread.

Apply only saved checklist ticks against the fresh PR body, and only when each
saved bullet is unambiguous. Re-fetch to verify all actions and ticks, then
checkpoint observed progress. Unrelated new feedback belongs to a separate
pass. Human residuals remain typed and open.

Use `status: completed` only after every eligible saved reply, required
resolution and tick has been freshly verified; human threads intentionally left
open do not block completion. Keep `pending` for incomplete or blocked work. If
no valid receipt exists or observed progress cannot be checkpointed, return
`incomplete-handoff` with actual remote successes and the exact recovery
blocker. Return the validated receipt path to the root caller; a push alone
does not finish the review conversation.
