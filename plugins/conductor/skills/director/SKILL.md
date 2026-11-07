---
name: director
description: Only for repositories with valid Conductor setup. Explicitly start or manage a Conductor director, choose synchronous coordination or full automation, or hand an existing automated director to another chat.
---

# Conductor director

Before using this skill, follow the [repository setup gate](../../references/repository-scope.md).
If the gate fails, stop this skill before any task work.

Use only when the user explicitly selects a director or asks to manage an existing
one. Ordinary issue, planning and implementation requests use the corresponding
skills in their current chat; do not start, adopt or ask to start a director from
those requests. Read [shared issue policy](../../references/workflow.md).

## Choose the mode and chat

The default director is synchronous: this agent coordinates work and any useful
authorized native subagents in the current chat. Work in the current checkout;
do not create worktrees, start a background runner, or bind the runtime. Full automation is a separate
explicit choice that uses the existing runtime lifecycle.

On an explicit start request, use the user's specified chat location. If location
is unspecified, ask whether to use this chat or a fresh chat before adopting or
creating either. A fresh chat requires the user's choice. Do not silently move
the work. Inspect the actual project, saved automation binding, pending handoff,
jobs, holds and recovery state before acting; a title or skill does not prove
ownership. Resolve an ambiguous switch from active automation with the user and
existing owner, without silently stopping it or taking over.

Name the director `🎬 <project> <MM/DD/YYYY hh:mm AM/PM>`, using the established
project name and the local creation or adoption time. Use the same format when
the user explicitly adopts this chat. For an authorized fresh chat, use the native
project chat creation tool with `gpt-6.1-sol` and low thinking when supported.
Verify the tool's model and effort fields; report unsupported settings rather than
silently substituting. Keep the current chat's model when adopting it unless the
user separately authorizes a change. Do not archive a prior chat automatically.

Pass the selected mode, repository, authorized operation and expected prior
binding in a fresh chat's first-turn instruction. The new chat verifies its actual
native UUID and the expected prior binding before any binding operation. Native
creation is for the explicitly selected fresh user chat; use native subagents
for bounded helpers, not additional user-facing coordinator chats.

## Begin with user decisions

Start `$conductor:ask-user` before implementation. Inspect accepted goals, current
issues, source and recorded answers first. Explain the current goal and ask only
the consequential decisions still unanswered. If those decisions are settled,
state the recovered direction and proceed without a redundant questionnaire.
Chat is the default interface; optional collaboration requires explicit selection.

The synchronous director owns the requested outcome and authorized issue writes.
Use `$conductor:manage-issues`, `$conductor:plan`, `$conductor:implement` and
`$conductor:review` as the work requires. Do routine planning in this agent. Use
`$conductor:planner` for a bounded delegated decision when independent judgment or
specialization justifies the cost. For independent planning, design review, or
self-contained assignments, explicitly set `fork_turns: "none"` and supply the
requirements, governing sources, actual proposal, authority and evidence without
the builder's verdict. Retain each helper's own context for related follow-ups. Keep one
coordinator and explicit writer ownership. Reconcile helpers and outstanding
operations before completion, cancellation or handoff.

Before synchronous checkout edits, verify automation is quiescent and no unresolved
owned workers or delivery operations conflict. Paused admission or a stopped
observer alone is insufficient. Preserve their recovery and ownership, report the
conflict and continue safe preparation. Do not silently stop, cancel or take over
automation to make synchronous work possible. Runtime controls remain the bound
automated director's responsibility.

## Full automation and handoff

Read [automation lifecycle](../../references/automation.md) only when the user
explicitly selects full automation or requests its existing runtime controls or
handoff. Reuse the saved director or pending handoff; do not create duplicates.
On a new startup, resolve initial user questions before enabling observation.
Keep initial admission paused and verify that pause before any builder dispatch.
Preserve previous holds, admission pauses and recovery restrictions. Only separately
authorized execution can activate admission after decisions are integrated.

For a plugin rollout, finish bundle edits, checks and publication before refreshing
installations and verifying hook trust plus required configuration/instruction
checks. Create replacement director chats only after that boundary. Keep the
installed bundle unchanged through handoff and lifecycle verification. A new bundle
change requires finishing and refreshing it before creating final replacements.
Do not refresh beneath their turns or refresh another environment without authority.
