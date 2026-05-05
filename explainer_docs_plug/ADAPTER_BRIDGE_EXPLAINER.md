# Bridge.py — Adapter Changes Explainer

How the pluggable adapter layer works inside `bridge.py`.

Ctrl+F `[ADAPTER CHANGE]` in bridge.py to find every change.

---

## What is the bridge?

The middleman. Sits between:

- **Control plane** (WebSocket to the cloud — manages sessions, talks to web UI)
- **Agent** (the coding tool running inside the sandbox — OpenCode, Pi, etc.)

The bridge receives commands ("here's a prompt") from the control plane and forwards events ("here's
a token") from the agent.

---

## What is the adapter?

A translation layer that **did not exist before this refactor**. Previously, the bridge talked
directly to OpenCode — 940 lines of OpenCode-specific code (SSE parsing, session creation, message
ID generation) were baked into bridge.py.

The adapter is the abstraction that says: "I don't care how the agent works internally. Just give me
standard events."

---

## Key terms

| Term                   | What it is                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bridge**             | `bridge.py`. Talks to control plane over WebSocket. Talks to agent through adapter.                                                                 |
| **adapter**            | The translator layer (created by this refactor). Knows how to talk to one specific agent. Lives in `adapters/opencode.py` or `adapters/pi.py`.      |
| **agent**              | The actual coding tool (OpenCode or Pi). Does the real work.                                                                                        |
| **control plane**      | Cloud server (Cloudflare Workers + Durable Objects) that manages sessions. Web UI connects to it.                                                   |
| **sandbox**            | The isolated environment where the agent runs. Contains the bridge, the agent, and the code.                                                        |
| **sandbox provider**   | Daytona (previously Modal). Creates, freezes (snapshots), and restores sandboxes. The bridge does NOT do the freezing — the provider does.          |
| **session ID**         | The agent's internal ID for its conversation/work. Needed to resume after snapshot restore.                                                         |
| **snapshot**           | Freezing the entire sandbox (files + state) so it can be restored later. Like saving a game. Performed by the **sandbox provider**, not the bridge. |
| **port**               | OpenCode runs as a localhost HTTP server on port 4096. Pi doesn't use a port — it uses stdin/stdout pipes.                                          |
| **event**              | A dict the adapter produces: `token`, `tool_call`, `step_start`, `step_finish`, `error`.                                                            |
| **execution_complete** | "The prompt is done." The bridge sends this itself — never the adapter. This guarantees it always gets sent even if the adapter has a bug.          |

---

## Who does what in a snapshot?

```
1. Control plane sends "snapshot" command to bridge (over WebSocket)
2. Bridge asks adapter: "what's your session ID?"
3. Bridge sends snapshot_ready event (with session ID) back to control plane
4. Control plane tells the sandbox provider (Daytona): "freeze this sandbox"
5. Daytona freezes the sandbox (filesystem, processes, everything)

Later, on restore:
1. Daytona unfreezes the sandbox
2. Bridge boots up, calls adapter.load_session_id()
3. Adapter reads the saved session ID from disk
4. Agent resumes its conversation from where it left off
```

---

## The 9 adapter changes (Ctrl+F: `[ADAPTER CHANGE]`)

| #   | Line | What                                    | Why                                                                                                                                                           |
| --- | ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 52   | `REQUIRED_EVENT_FIELDS` validation dict | Events used to come from code in this file — correctness was visible. Now they come from an external adapter, so we validate before sending to control plane. |
| 2   | 173  | `adapter.configure(http_client, port)`  | Hand the adapter tools to talk to the agent. OpenCode uses HTTP + port. Pi ignores both (uses stdin/stdout pipes). Each adapter takes what it needs.          |
| 3   | 178  | `adapter.load_session_id()`             | On boot: "was this sandbox restored from a snapshot? Load the saved session ID so the agent can resume." Paired with #8.                                      |
| 4   | 512  | `_validate_event()` method              | The guard function. Checks every adapter event has required fields. Protects the control plane from garbage.                                                  |
| 5   | 555  | `adapter.create_session()`              | First prompt arrives, no session yet. Tell the agent "start a session for this repo." Was hardcoded as `_create_opencode_session()`.                          |
| 6   | 559  | `adapter.send_prompt()` + validate loop | Send prompt to agent, get events back, validate each one, forward to control plane. Replaced ~300 lines of inline OpenCode SSE parsing.                       |
| 7   | 613  | `adapter.stop()`                        | User hit cancel. Tell the agent to abort. Was `_request_opencode_stop()`.                                                                                     |
| 8   | 620  | `adapter.get_session_id_for_snapshot()` | Taking a snapshot. Give the control plane the agent's session ID so #3 can load it back later.                                                                |
| 9   | 867  | `load_adapter(agent_name)` in main()    | Bridge CLI reads `AGENT_ADAPTER` env var and loads the right adapter. This is how you swap agents.                                                            |

---

## Before vs after

```
BEFORE (1,700 lines — OpenCode baked in):
  bridge._create_opencode_session()        → POST to localhost:4096/session
  bridge._stream_opencode_response_sse()   → 300 lines of SSE parsing
  bridge._request_opencode_stop()          → POST to localhost:4096/session/{id}/abort
  bridge._parse_sse_stream()               → SSE chunk parser
  bridge._fetch_final_message_state()      → GET final text from OpenCode API
  bridge._build_prompt_request_body()      → OpenCode-specific request format
  bridge.OpenCodeIdentifier                → ascending message ID generator
  ... (940 lines total)

AFTER (870 lines — agent-agnostic):
  self.adapter.configure()                 → "here's the http client and port"
  self.adapter.load_session_id()           → "any previous session to restore?"
  self.adapter.create_session()            → "start a session"
  self.adapter.send_prompt()               → "send this prompt, give me events"
  self.adapter.stop()                      → "abort"
  self.adapter.get_session_id_for_snapshot() → "what's your session ID?"
```

All 940 lines of OpenCode-specific code moved to `adapters/opencode.py`. The bridge doesn't know or
care which agent it's talking to.

---

## How agents communicate differently

```
OpenCode:
  Bridge  →  HTTP POST localhost:4096/session/{id}/prompt  →  OpenCode server
  Bridge  ←  Server-Sent Events (SSE stream)               ←  OpenCode server

Pi:
  Bridge  →  JSON written to stdin pipe   →  Pi subprocess
  Bridge  ←  JSON read from stdout pipe   ←  Pi subprocess
```

Both produce the same 5 event types: `token`, `tool_call`, `step_start`, `step_finish`, `error`. The
adapter handles the translation. The bridge sees no difference.

---

## How to swap agents

```bash
# Use OpenCode (default)
AGENT_ADAPTER=opencode

# Use Pi
AGENT_ADAPTER=pi

# Use something new you build
AGENT_ADAPTER=my_new_agent  # + implement AgentAdapter in adapters/my_new_agent.py
```

That's it. One env var.
