# Deliver a phase report

Use this reference after a phase or when reporting existing work. Recover the
result and consequential evidence from the current conversation, commits,
results, and existing work records. Use bounded history lookup only when an
unresolved historical fact changes the report. Do not reconstruct every command.

## Write a concise report

When available, use $onepersonlabs:write-technical for the report and chart text.
Conductor remains usable without it. Explain what was built or
changed through what it does. Then say whether it worked and what remains
unfinished. The reader must understand the result without the conversation's
internal labels or history.

Retain causes and decisions only when they explain the result or next action.
Separate completed work, experiments, interrupted reviews, and proposed work.
An exhausted allowance or
interrupted check is not a passing check. Keep qualifications beside the claims
they limit; omit those that do not affect the takeaway. Link supporting detail
instead of narrating the work process.

Account for preparation, implementation, verification, coordination, rework, and
waiting when these distinctions affect the next action. Parallel durations
overlap. Compare equivalent work; do not turn different workloads into a speedup
claim. State unknown intervals or usage directly. Reuse any existing workflow
account, including findings from $onepersonlabs:optimize-workflow when available,
rather than creating a separate ledger.

## Draw the route

Copy [the standalone template](../assets/navigation.html) into the tracked report
path defined by [phase artifacts](../../../references/phase-artifacts.md).
Deliver static, JavaScript-free HTML with
embedded CSS, linked HTML cards, and authored inline SVG edges. Do not include scripts, event
handlers, JavaScript URLs, runtime data blocks, or external dependencies.
Replace the illustrative content directly in the HTML and SVG before delivery.
Escape story text and attribute values for their HTML context. Evidence links
may use local files, HTTP, or HTTPS; reject executable link schemes.

Select meaningful events that explain the result, unfinished work, or the next
decision. Omit routine events that do not change that account. Preserve supported
connections among the selected events, including consequential failed branches,
repairs, reunions and unfinished endpoints. Do not fabricate a branch or remove a
consequential branch to simplify the chart. Do not turn it into a command history
or worker diary.
Update the title, summary, checkpoint, actor labels, roadmap, graph cards,
supporting detail, accounting, and next action together. Give each event a stable
anchor, actor, name, state and short description. Add supporting prose or evidence
links when they explain a cause, decision, result or limit beyond the card itself;
do not require a separate story paragraph for every event.
Show a bold numbered name, a short description below it, and a visible owner and
status on each linked card. Match card numbers and names to any linked detail
headings. A card can link directly to supporting evidence or another relevant
report section when a separate detail entry adds no information.
Do not add a separate key that repeats the card names. Use concrete names and
descriptions that explain the actual goal, attempt, result, or limitation.
Update SVG paths, arrowheads, accessible descriptions, and grid placement to fit
the actual graph. The template places edges in a gutter and spans the grid gaps
between their source and destination cards, so card heights can follow content.
Rows express narrative order, not measured time. Edges identify their source,
destination, and outcome; include only supported connections. Route edges through
lane gutters and row gaps so they do not cross unrelated nodes.

Use CSS for responsive layout. Allow ordinary document scrolling only; do not
create scrollable panels, fixed-height graph viewports, or horizontal page
overflow. Let content determine section height. On viewports below 768 pixels,
stack the full-width graph above the supporting result, unfinished work, next
action, and details. At 768 pixels and wider, place the graph beside that support
in roughly equal columns with a 24-pixel gap. Keep card names and descriptions
readable at a 360-pixel viewport and in the half-width column at 768 pixels.
Wrap card text instead of scaling it with SVG geometry.
If the graph becomes too dense, split it into connected figures
with explicit continuation labels and stable event numbers. Preserve consequential
supported branches and reunions; do not hide or discard the graph on narrow screens
or in print, shrink its text beyond legibility, or clip overflow to conceal it.

Use actor colors for the root and worker paths. Labels, symbols, and line styles
carry meaning independently of color. Mark abandoned and interrupted branches
at their endpoints. A repair path rejoins at the repaired result. A review that
did not finish cannot rejoin as approval. Label planned routes as proposed.
Do not fabricate branches to make the chart more interesting.

Give the broad roadmap a current position and direction. Expand only the
selected phase. Use native links from graph cards to relevant detail or evidence.
Include outgoing connections as text
links so the route remains understandable without the drawing. Describe unfinished
work and its existing owner. The report records results and possible next actions;
it does not issue workflow, mode-switch or human-stop commands.

Keep one chart for the review consumer and update it in place. Preserve authored
content and accepted conclusions with their existing owners. Retain temporary
captures only while they support the current visual review, then remove them.
This presentation does not authorize retaining an execution diary or copying
raw logs into project documentation.

## Inspect before delivery

Open the saved HTML file directly in the available browser. Do not start a web
server to preview or deliver the checkpoint. Check desktop and phone sizes,
long labels, branch directions and reunion points. With JavaScript disabled,
confirm that all content and the graph render. Exercise graph-to-story links,
return links where present, keyboard focus, text connections, and evidence links. Check that
the page has no horizontal overflow or nested scroll containers at either size.
Check at 360 pixels, at the 768-pixel layout transition, and at desktop width.
Check that numbered card names, descriptions, statuses, arrowheads, branch
endpoints, and reunion points remain legible on phones and in print.
Confirm that long labels wrap and the story
remains complete. Fix observed defects and recheck
the affected behavior. Report rendered legibility separately from unobserved
human comprehension.

Deliver the concise report with a clickable Markdown link to the saved HTML file
using its absolute filesystem path. Include the next review action when needed.
Report authorship does not authorize execution, publication or closure.
