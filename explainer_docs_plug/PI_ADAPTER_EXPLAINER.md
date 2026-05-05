# Pi.py — Pi Adapter Cheat Sheet

The Pi adapter (`adapters/pi.py`, ~400 lines) implements the 13-method interface for Pi, which
communicates via stdin/stdout JSONL pipes (RPC mode) instead of HTTP.

---

## How Pi communicates (vs OpenCode)

**OpenCode** = calling a restaurant. It's a server at localhost:4096. You send HTTP requests, it
streams back SSE responses. It exists independently of the bridge.

**Pi** = hiring someone to sit next to you and pass notes. The adapter spawns Pi as a subprocess,
writes JSON to its stdin, reads JSON from its stdout. No server, no port, no HTTP. Pi only exists
because the adapter created it.

---

## The 4 big ideas in pi.py

### 1. Two-way communication over one pipe

Pi has one stdout but sends two kinds of things through it:

- **Responses** to commands ("yes I changed the model")
- **Streaming events** during a prompt ("token: Hello", "tool_call: editing file")

The adapter sorts them with `_read_stdout()` into two queues:

- `_response_queue` — for `_send_command()` to find its answers
- `_event_queue` — for `send_prompt()` to yield as translated events

Without this split, a command response could get stuck behind 50 streaming events.

### 2. The adapter owns the Pi process

The adapter spawns Pi (`_spawn_pi()`), holds its stdin/stdout pipes, and kills it on shutdown. This
is different from OpenCode where the entrypoint starts the server and the adapter just connects to
it.

Consequence: if the bridge dies, Pi dies too. But the sandbox filesystem preserves everything
already completed, and the session file lets Pi resume on restart.

### 3. Translation (filtering, really)

Pi emits ~15 event types. The control plane only understands 5. The adapter's `_translate_event()`
method:

- Events the control plane needs → translate to standard format
  - `turn_start` → `step_start`
  - `turn_end` → `step_finish` (with token/cost info)
  - `message_update` (text_delta) → `token`
  - `tool_execution_start/update/end` → `tool_call`
  - `auto_retry_end` (failed) → `error`
- Events the control plane doesn't need → return None (dropped)
  - `agent_start`, `message_start`, `message_end`, `queue_update`, `compaction_start`,
    `compaction_end`, `auto_retry_start`, `extension_error`

The rule: if it maps to one of the 5 types, translate it. If not, drop it.

### 4. Everything that could block gets handled

| Situation                              | Solution                            |
| -------------------------------------- | ----------------------------------- |
| Pi asks a UI question (confirm/select) | Auto-approve — no human in sandbox  |
| Pi asks for text input (input/editor)  | Cancel — can't fake meaningful text |
| Pi doesn't respond to a command        | Timeout after 10s                   |
| Pi stops sending events mid-prompt     | Timeout after 120s                  |
| Pi process dies                        | Detect EOF on stdout, yield error   |
| Two writes to stdin at once            | Lock prevents garbled JSON          |

---

## Key methods and what they do

### Entrypoint side (boot)

| Method           | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `install()`      | Write `.pi/settings.json`, copy skills into `.pi/agent/skills/` |
| `start()`        | Just validate `pi --version` works. Does NOT spawn Pi yet.      |
| `get_process()`  | Return process handle (or None)                                 |
| `forward_logs()` | No-op — bridge handles Pi's stderr directly                     |

### Bridge side (communication)

| Method              | What it does                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `configure()`       | Ignores http_client/port. Reads env vars, finds workspace, sets up queues.                           |
| `ensure_session()`  | Spawns Pi if not running. May resume (from session file) or create fresh. Bridge doesn't care which. |
| `send_prompt()`     | Write prompt to stdin → wait for ack → stream translated events from queue                           |
| `stop()`            | Write `{"type": "abort"}` to stdin                                                                   |
| `health_check()`    | Is the process still alive?                                                                          |
| `load_session_id()` | Read `/tmp/pi-session-path` from disk                                                                |
| `save_session_id()` | Write session path to `/tmp/pi-session-path`                                                         |
| `shutdown()`        | Close stdin → wait → terminate → kill                                                                |

### Internal plumbing

| Method                   | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `_spawn_pi()`            | Build command, launch subprocess, start reader tasks, wait for ready |
| `_write_stdin()`         | Write one JSON line (with lock to prevent garbling)                  |
| `_send_command()`        | Write command with unique ID, wait for response with matching ID     |
| `_read_stdout()`         | Background task: read JSONL, sort into response_queue vs event_queue |
| `_translate_event()`     | Pi native events → standard 5 types (or None to drop)                |
| `_handle_extension_ui()` | Auto-approve/cancel Pi's UI dialogs so it doesn't hang               |

---

## The lazy spawn order

The bridge controls the call order. The adapter doesn't get to choose:

```
1. adapter.configure()         ← set up queues, read env vars
2. adapter.load_session_id()   ← check disk for saved session (may set self._session_id)
3. ...first prompt arrives...
4. adapter.ensure_session()    ← NOW spawn Pi (with --session or --no-session)
5. adapter.send_prompt()       ← talk to Pi
```

Pi is spawned lazily in step 4 (not earlier) because it needs to know whether to resume or start
fresh — and that info isn't available until after step 2.

---

## Status events (bonus type)

The adapter emits `agent_status` events ("spawning", "ready", "prompting", "model_switched") for the
web UI to show progress. These are NOT one of the 5 core event types — the bridge passes them
through without validating. No translation needed; they're created directly in the format the
control plane expects.
