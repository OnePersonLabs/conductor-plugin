# Keep one foreground worker through planning and implementation

Use the foreground bridge when an authorized coordinator needs an ordinary Codex
worker to plan, ask questions, compact its context, and continue with another native
mode, model or reasoning effort. The coordinator stays visible and owns the human
conversation, scope, integration and delivery. The bridge owns one worker thread
and one live App Server client. It does not start a director, scheduler or service.

The coordinator must follow its own host mode. A coordinator in Plan Mode must not
use a Default-mode worker to perform implementation that its host forbids. A worker
mode change does not change the coordinator's mode or grant new authority.

## Start and keep the process alive

From the target Git checkout, use the installed plugin's absolute CLI path:

```powershell
node '<plugin-root>/bin/conductor.mjs' managed --session phase-work
```

Keep this foreground process and its stdin open. In a terminal tool, use a persistent
PTY session (`exec_command` with `tty: true`), then use `write_stdin` with that same
session ID. Each command is one JSON line. Do not pipe a finite input file into the
bridge: EOF closes its client and leaves recovery for unfinished work.

`bridge-ready` reports the session state. Use a different `id` for every command.
Replies have `{id, ok, result}` or `{id, ok:false, error}`. Events have `event`,
`sessionId` and, where applicable, the command or turn ID. A command acknowledgment
does not establish successful model completion. Preserve terminal events while
relaying questions. Do not restart the process to answer a question.

```json
{"id":"start-1","command":"start"}
{"id":"plan-config-1","command":"configure","mode":"plan","model":"gpt-6.1-sol","effort":"xhigh"}
{"id":"plan-1","command":"turn","prompt":"Investigate the authorized change. Ask me through request_user_input when a consequential decision is missing, then return the plan. Do not edit files."}
```

Wait for each control reply before its dependent command. `turn` acknowledges the
submission; wait for its `turn-completed` event with `success:true` before treating
the work as completed. `message` contains the worker's answer. The worker inherits
the configured tools, sandbox and approvals; the bridge installs no special role
permissions. A configured host restriction can still block a requested operation.

The bridge checks the live model catalogue before configuration. It rejects an
unavailable model or effort and never substitutes one. The production choices are
Sol 6.1 xhigh for bounded planning, Astra high for complex planning, Sol 6.1 high
for implementation, and Astra medium for independent review. Select the choice
appropriate to the assignment; the transport does not choose policy for you.

## Answer a question on the same client

A `request` event includes the native server `request.id`, `method` and `params`.
For `item/tool/requestUserInput`, show its questions in the coordinator's human
interface. Retain that native request ID and send the human's actual answer:

```json
{"id":"answer-1","command":"respond","requestId":0,"response":{"answers":{"test_color":{"answers":["Blue"]}}}}
```

The example's `test_color` must match the received question ID. Approval requests
use their native response shape, such as `{"decision":"decline"}`. Do not invent
a decision or grant authority because a server request exists. Responses are not
echoed or written into bridge recovery. Explicit credential fields in incoming
requests are redacted; do not put secrets into prompts or ordinary question text.

`written:true, consumed:false` means the response reached the local transport.
The bridge waits for the matching host item or terminal turn before clearing the
pending request. It refuses configuration while an answer remains unconsumed.

## Compact and change the worker's mode

After a successful planning turn, the coordinator saves any authored plan through
its authorized owner. A worker in Plan Mode cannot write the plan file for you.
When implementation is authorized, submit one configuration request:

```json
{"id":"implementation-config-1","command":"configure","mode":"default","model":"gpt-6.1-sol","effort":"high"}
```

After the first work turn, a changed configuration requires a successful terminal
previous turn and no pending operation or request. The bridge compacts first. It
requires the matching `contextCompaction` item and successful terminal compaction
turn, then updates native mode/model/effort together and verifies the host's
`thread/settings/updated` notification. `configured:true` is emitted only after
that evidence. Initial configuration before the first turn needs no compaction;
requesting already applied settings leaves them unchanged.

Only after the configuration reply succeeds, start the authorized next turn:

```json
{"id":"implementation-1","command":"turn","prompt":"Implement the approved plan within the assigned files. Return the changed behavior and verification evidence."}
```

## Inspect, interrupt and recover without duplicating work

```json
{"id":"status-1","command":"status"}
{"id":"interrupt-1","command":"interrupt"}
```

Interrupt acknowledges a request to stop the current owned turn. Wait for the
terminal host event. An interrupted or failed turn is not a successful boundary
for changing settings. Resume useful work under the current verified settings
and obtain a successful turn before changing them.

Recovery lives under the repository's Git common directory at
`conductor/managed/<session-id>/session.json`. It holds only the worker identity,
checkout, settings and pending operation metadata. It is separate from automated
director `state.json` and gives no ownership of automated issues. One live writer
owns each session. A live or foreign owner blocks another process; a previous
App Server process that is still alive also blocks recovery.

After EOF, transport loss or process failure, restart the bridge in the same
checkout with the same session ID. Inspect its status and reconcile the original
host history before resuming:

```json
{"id":"reconcile-1","command":"reconcile"}
{"id":"resume-1","command":"start"}
```

Reconciliation does not replay a prompt, answer, compaction or settings update.
If turn submission lost its acknowledgment before recording a turn ID, the bridge
returns a summary of host turns. Inspect it, then identify the terminal turn:

```json
{"id":"reconcile-2","command":"reconcile","expectedTurnId":"<observed-terminal-turn-id>"}
```

Active work or a missing terminal receipt remains blocked. If initial thread
creation has an unknown outcome and no thread ID was saved, locate and reconcile
the original host operation before starting another session. The bridge does not
guess a thread identity or create a replacement. Native multi-agent v2 subagents
reject direct App Server control; this bridge creates an ordinary owned thread.

## Finish and remove bridge recovery

After the terminal result is integrated and no operation or request remains:

```json
{"id":"close-1","command":"close"}
```

The bridge closes its client, removes its session recovery directory and exits.
The worker's authored conversation remains in Codex; the bridge does not delete or
archive it. Unfinished sessions retain recovery until their outcome is reconciled.
EOF is a disconnect, not this completion operation. Report missing receipts,
transport loss and cleanup failures as unfinished work.
