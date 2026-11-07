# Compose phase-based work

Read this reference after the repository setup gate when an assignment involves
multi-phase work with human review or replanning checkpoints. Conductor supplies
work steps; an available process skill can coordinate their order and phase
boundaries. Ordinary issue edits and full automation alone do not select this
human-checkpoint process.

## Select the process and the step

For a coordinating root, load `$onepersonlabs:rolling-wave-workflow` when it is
exposed as available and the requested work matches its description. Reuse it if
already loaded. Its instructions own phase cadence, the Plan Mode requirement
for plotting, the checkpoint story, and the return to the human. Follow the
current host mode; a skill cannot change it by declaration.

Use the applicable Conductor step without creating a second plan or coordinator:

| Activity | Step |
| --- | --- |
| Plan the next connected phase | `$conductor:plan` |
| Implement the authorized phase | `$conductor:implement` |
| Independently review a supplied scope | `$conductor:review` |
| Update GitHub work records | `$conductor:manage-issues` |

Conductor retains repository setup, GitHub acceptance and delivery, original
builder/reviewer ownership, holds, and runtime controls. Product meaning remains
with its existing owner. A phase can report useful results while required issue
delivery remains unfinished; checkpoint reporting does not satisfy or bypass
those delivery requirements.

Delegated builders, planners, and reviewers complete their assigned scope and
return to the coordinating root. They do not initiate another process, ask the
human for a mode switch, or impose a phase ceremony on a bounded assignment.
The root incorporates their evidence and remains responsible for the checkpoint.

## Keep either workflow independent

If Rolling Wave Workflow is unavailable, disabled, or irrelevant, continue the
selected Conductor skill normally. Do not search disabled caches, require
installation, or impose companion-only rules. Reciprocal skill pointers mean
load once and reuse, not repeatedly invoke each other.

Ordinary phase work does not start or adopt a director. If automation already
owns affected work, its existing owner must apply its supported controls for an
agreed phase boundary and reconcile workers and delivery. Preserve current
authority, holds, admission state, and outstanding operations. A companion skill
does not grant runtime control or authorize a mode change.
