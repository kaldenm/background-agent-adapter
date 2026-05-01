# Pi Agent Adapter Spec — Replacing OpenCode with Pi

## Overview

This document specifies how to implement a `PiAdapter` that replaces `OpenCodeAdapter` in the
Open-Inspect sandbox runtime. Pi (`@mariozechner/pi-coding-agent`) runs in **RPC mode**
(`pi --mode rpc`) as a subprocess communicating via JSONL over stdin/stdout — a fundamentally
different integration pattern from OpenCode's HTTP serve + SSE model.

### Key Architectural Difference

| Aspect                  | OpenCode (current)                                              | Pi (target)                                                                    |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Process model**       | HTTP server on a port, SSE event stream                         | Subprocess with stdin/stdout JSONL                                             |
| **Session creation**    | `POST /session` → session ID                                    | Implicit (one session per process), or `--session <path>`                      |
| **Prompting**           | `POST /session/{id}/prompt_async` + SSE `/event`                | `{"type": "prompt", "message": "..."}` on stdin                                |
| **Events**              | SSE stream with `message.updated`, `message.part.updated`, etc. | JSONL stdout: `agent_start`, `message_update`, `tool_execution_*`, `agent_end` |
| **Health check**        | `GET /global/health`                                            | Process alive + stdin/stdout responsive                                        |
| **Stop/Abort**          | `POST /session/{id}/abort`                                      | `{"type": "abort"}` on stdin                                                   |
| **Session persistence** | Managed by OpenCode server (SQLite DB)                          | JSONL session files in `~/.pi/agent/sessions/`                                 |

---

## AgentAdapter Method Mapping

### Entrypoint Process Methods

#### `install(workdir, session_config)`

**OpenCode**: Copies tools to `.opencode/tool/`, skills to `.opencode/skills/`, installs MCP
packages, deploys OAuth plugins.

**Pi**: Install Pi globally (or use a pre-installed binary in the image). Set up the equivalent
resources:

| OpenCode resource         | Pi equivalent                                                 | Location                                       |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `.opencode/tool/*.js`     | Extensions (TypeScript)                                       | `.pi/extensions/` or `~/.pi/agent/extensions/` |
| `.opencode/skills/`       | Skills (SKILL.md dirs)                                        | `.pi/skills/` or `~/.pi/agent/skills/`         |
| `.opencode/plugins/`      | Extensions                                                    | `.pi/extensions/`                              |
| MCP servers               | Extensions (Pi has no native MCP, build an extension) or skip | `.pi/extensions/mcp-bridge.ts`                 |
| `OPENCODE_CONFIG_CONTENT` | `settings.json` + env vars                                    | `.pi/settings.json`                            |

**Implementation plan:**

```python
async def install(self, workdir: Path, session_config: dict) -> None:
    # 1. Create .pi/ directory structure
    pi_dir = workdir / ".pi"
    pi_dir.mkdir(parents=True, exist_ok=True)
    (pi_dir / "extensions").mkdir(exist_ok=True)
    (pi_dir / "skills").mkdir(exist_ok=True)

    # 2. Copy custom tools as Pi extensions
    #    Each OpenCode tool.js must be rewritten as a Pi extension
    #    that calls pi.registerTool({...})
    self._install_extensions(workdir)

    # 3. Copy skills (same format — Pi uses SKILL.md too)
    self._install_skills(workdir)

    # 4. Write .pi/settings.json with permissions config
    #    Pi has no permission popups by default; extensions can gate
    self._write_settings(workdir, session_config)

    # 5. Write AGENTS.md for project context (equivalent to OpenCode context)
    self._write_agents_md(workdir)

    # 6. Install bin scripts (same as OpenCode — agent-agnostic)
    self._install_bin_scripts()
```

#### `start(workdir, session_config)`

**OpenCode**: Launches `opencode serve --port 4096`, waits for HTTP health.

**Pi**: Launches `pi --mode rpc` as a subprocess. "Healthy" means the process is alive and
responding to commands on stdin/stdout.

```python
async def start(self, workdir: Path, session_config: dict) -> None:
    # 1. Set API key env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    env = self._build_env(session_config)

    # 2. Build CLI args
    provider = session_config.get("provider", "anthropic")
    model = session_config.get("model", "claude-sonnet-4-20250514")
    args = [
        "pi",
        "--mode", "rpc",
        "--provider", provider,
        "--model", model,
        "--no-session",  # or --session-dir /tmp/pi-sessions
    ]

    # 3. Spawn subprocess
    self.process = await asyncio.create_subprocess_exec(
        *args,
        cwd=workdir,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # 4. Wait for ready (Pi RPC mode is ready immediately once process starts)
    #    Validate with a get_state command
    await self._wait_for_ready()
```

#### `get_process()`

**Identical pattern** — return `self.process`.

#### `forward_logs()`

**OpenCode**: Reads from process stdout (which is both logs and data).

**Pi**: Reads from **stderr** only. stdout is reserved for JSONL protocol data.

```python
async def forward_logs(self) -> None:
    if not self.process or not self.process.stderr:
        return
    try:
        async for line in self.process.stderr:
            print(f"[pi] {line.decode().rstrip()}")
    except Exception as e:
        print(f"[pi_adapter] Log forwarding error: {e}")
```

---

### Bridge Subprocess Methods

#### `configure(http_client, port)`

**OpenCode**: Stores http_client and constructs base_url for HTTP API calls.

**Pi**: Does not use HTTP at all. This method is mostly a no-op. However, we still store
configuration for the stdin/stdout protocol. The adapter needs access to the subprocess pipes, not
an HTTP client.

**Design decision**: Since Pi communicates via subprocess pipes (not HTTP), the bridge needs the
adapter to either:

- (a) Have a reference to the spawned process (set during `start()`), OR
- (b) Start its own Pi subprocess in the bridge process

Given the two-process architecture (entrypoint starts the agent, bridge communicates with it), we
need a **shared-memory or IPC** approach. Two options:

**Option A — Single Pi process, shared pipes via file descriptors:** The entrypoint passes the
process FDs to the bridge. Complex, fragile.

**Option B — Bridge spawns its own Pi process (recommended):** The bridge subprocess spawns
`pi --mode rpc` itself. The entrypoint's `start()` becomes a readiness check only. This maps cleanly
to Pi's architecture since each Pi process IS a session.

**Option C — Pi in subprocess mode with a named pipe / Unix socket:** Not supported by Pi RPC mode
(stdin/stdout only).

**Recommendation: Option B.** The bridge owns the Pi process. The entrypoint validates installation
and pre-warms nothing (or spawns+kills a test instance). This is cleaner because Pi RPC mode is
designed as a subprocess protocol.

```python
def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
    # http_client not needed for Pi (no HTTP API)
    # port not needed for Pi (no server)
    # Store for potential future use
    self._configured = True
```

#### `create_session(repo_path)`

**OpenCode**: `POST /session` → returns session ID string.

**Pi**: Sessions are implicit per-process. When bridge spawns Pi, that IS the session. Return a
synthetic session ID (could be a UUID or the session file path).

If the bridge spawns Pi on `configure()` or lazily on first `create_session()`:

```python
async def create_session(self, repo_path: str) -> str:
    # Spawn pi --mode rpc if not already running
    if not self._pi_process:
        await self._spawn_pi(repo_path)

    # Pi doesn't have explicit session creation in RPC mode.
    # The session exists as long as the process lives.
    # Generate a synthetic session ID for tracking.
    self._session_id = str(uuid.uuid4())
    await self.save_session_id(self._session_id)
    return self._session_id
```

**For snapshot restore**: Use `pi --session <path>` or `pi -c` to continue a previous session. The
session JSONL file is the persistence artifact.

#### `send_prompt(session_id, content, message_id, model, reasoning_effort)`

**OpenCode**: Complex SSE streaming with message correlation, part tracking, cumulative text
assembly, child session tracking.

**Pi**: Send `{"type": "prompt", "message": "..."}` on stdin, read JSONL events from stdout until
`agent_end`. Much simpler event model.

**Event mapping (Pi → Open-Inspect bridge events):**

| Pi event                       | Bridge event                                                                                                       | Notes                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `message_update` (text_delta)  | `{"type": "token", "content": cumulative_text, "messageId": msg_id}`                                               | Accumulate deltas into cumulative text |
| `tool_execution_start`         | `{"type": "tool_call", "tool": name, "args": {...}, "status": "running", "messageId": msg_id}`                     |                                        |
| `tool_execution_update`        | `{"type": "tool_call", "tool": name, "args": {...}, "status": "running", "output": partial, "messageId": msg_id}`  |                                        |
| `tool_execution_end`           | `{"type": "tool_call", "tool": name, "args": {...}, "status": "completed", "output": result, "messageId": msg_id}` |                                        |
| `tool_execution_end` (isError) | `{"type": "tool_call", "tool": name, "status": "error", "output": error, "messageId": msg_id}`                     |                                        |
| `turn_start`                   | `{"type": "step_start", "messageId": msg_id}`                                                                      |                                        |
| `turn_end`                     | `{"type": "step_finish", "messageId": msg_id}`                                                                     | Include cost/tokens from usage         |
| `agent_end`                    | _(signals completion — bridge emits `execution_complete`)_                                                         |                                        |
| Error in streaming             | `{"type": "error", "error": "...", "messageId": msg_id}`                                                           |                                        |

**Implementation sketch:**

```python
async def send_prompt(
    self, session_id, content, message_id, model=None, reasoning_effort=None
) -> AsyncIterator[dict[str, Any]]:
    # 1. Optionally switch model before prompting
    if model:
        await self._set_model(model, reasoning_effort)

    # 2. Send prompt command
    cmd = {"type": "prompt", "message": content}
    self._write_stdin(cmd)

    # 3. Read events until agent_end
    cumulative_text = ""
    async for event in self._read_events():
        event_type = event.get("type")

        if event_type == "response" and event.get("command") == "prompt":
            if not event.get("success"):
                yield {"type": "error", "error": event.get("error", "Unknown"), "messageId": message_id}
                return
            continue

        if event_type == "turn_start":
            yield {"type": "step_start", "messageId": message_id}

        elif event_type == "message_update":
            ame = event.get("assistantMessageEvent", {})
            if ame.get("type") == "text_delta":
                cumulative_text += ame["delta"]
                yield {"type": "token", "content": cumulative_text, "messageId": message_id}

        elif event_type == "tool_execution_start":
            yield {
                "type": "tool_call",
                "tool": event["toolName"],
                "args": event.get("args", {}),
                "callId": event["toolCallId"],
                "status": "running",
                "output": "",
                "messageId": message_id,
            }

        elif event_type == "tool_execution_update":
            partial = event.get("partialResult", {})
            output = self._extract_text(partial.get("content", []))
            yield {
                "type": "tool_call",
                "tool": event["toolName"],
                "args": event.get("args", {}),
                "callId": event["toolCallId"],
                "status": "running",
                "output": output,
                "messageId": message_id,
            }

        elif event_type == "tool_execution_end":
            result = event.get("result", {})
            output = self._extract_text(result.get("content", []))
            status = "error" if event.get("isError") else "completed"
            yield {
                "type": "tool_call",
                "tool": event["toolName"],
                "args": event.get("args", {}),
                "callId": event["toolCallId"],
                "status": status,
                "output": output,
                "messageId": message_id,
            }

        elif event_type == "turn_end":
            msg = event.get("message", {})
            usage = msg.get("usage", {})
            yield {
                "type": "step_finish",
                "cost": usage.get("cost", {}).get("total"),
                "tokens": usage,
                "messageId": message_id,
            }

        elif event_type == "agent_end":
            # Done — bridge will emit execution_complete
            return
```

#### `stop(session_id)`

**OpenCode**: `POST /session/{id}/abort`

**Pi**: `{"type": "abort"}` on stdin.

```python
async def stop(self, session_id: str) -> None:
    self._write_stdin({"type": "abort"})
```

#### `health_check()`

**OpenCode**: `GET /global/health` → 200.

**Pi**: Check if process is alive + optionally send `get_state` and await response.

```python
async def health_check(self) -> bool:
    if not self._pi_process or self._pi_process.returncode is not None:
        return False

    try:
        # Send get_state with short timeout as health probe
        response = await asyncio.wait_for(
            self._send_command({"type": "get_state"}),
            timeout=2.0,
        )
        return response.get("success", False)
    except (TimeoutError, Exception):
        return False
```

#### `load_session_id()` / `save_session_id(session_id)` / `get_session_id_for_snapshot()`

**Same pattern as OpenCode** — file-based persistence of a session identifier. For Pi, the session
ID could map to the JSONL session file path, enabling snapshot restore via `pi --session <path>`.

```python
SESSION_ID_FILE = Path("/tmp/pi-session-id")

async def load_session_id(self) -> str | None:
    if not self.SESSION_ID_FILE.exists():
        return None
    return self.SESSION_ID_FILE.read_text().strip() or None

async def save_session_id(self, session_id: str) -> None:
    self._session_id = session_id
    self.SESSION_ID_FILE.write_text(session_id)

def get_session_id_for_snapshot(self) -> str | None:
    return self._session_id
```

#### `shutdown()`

**OpenCode**: Sends SIGTERM to the `opencode serve` process, waits 10s, then SIGKILL.

**Pi**: Same pattern — close stdin (Pi exits gracefully on stdin EOF), then SIGTERM, then SIGKILL as
fallback.

```python
async def shutdown(self) -> None:
    """Gracefully shut down Pi process."""
    proc = self._pi_process
    if not proc or proc.returncode is not None:
        return

    # Closing stdin signals Pi to exit cleanly
    if proc.stdin:
        proc.stdin.close()

    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except TimeoutError:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except TimeoutError:
            proc.kill()
            await proc.wait()
```

---

## Model and Thinking Level Mapping

### Provider/Model Strings

**OpenCode**: `"anthropic/claude-sonnet-4-6"`

**Pi RPC**: Use `set_model` command:

```json
{ "type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514" }
```

Or pass via CLI: `pi --provider anthropic --model claude-sonnet-4-20250514`

### Reasoning Effort → Thinking Level

**OpenCode**: Provider-specific options (Anthropic adaptive thinking, budgetTokens; OpenAI
reasoningEffort).

**Pi**: Unified `set_thinking_level` with levels: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`.

| Open-Inspect reasoning_effort | Pi thinking level                             |
| ----------------------------- | --------------------------------------------- |
| `"low"`                       | `"low"`                                       |
| `"medium"`                    | `"medium"`                                    |
| `"high"`                      | `"high"`                                      |
| `"max"`                       | `"xhigh"` (OpenAI codex-max only) or `"high"` |
| `None` / unset                | `"medium"` (default)                          |

```python
def _map_reasoning_effort(self, effort: str | None) -> str:
    mapping = {
        "low": "low",
        "medium": "medium",
        "high": "high",
        "max": "xhigh",
    }
    return mapping.get(effort or "medium", "medium")
```

---

## Session Lifecycle and Snapshots

### Fresh Session Boot

1. `install()` → set up `.pi/` directory, extensions, skills, settings
2. `start()` → spawn `pi --mode rpc --no-session` (or with `--session-dir`)
3. Bridge calls `create_session()` → Pi process is already the session
4. Bridge sends prompts → Pi streams responses

### Snapshot Restore

1. Sandbox restores from filesystem snapshot (`.pi/` and session files intact)
2. `start()` → spawn `pi --mode rpc --session <saved-session-file> -c`
3. Bridge calls `load_session_id()` → reads saved session path
4. Pi continues from existing context

### Session File for Snapshots

Pi sessions are JSONL files. For snapshot purposes:

- **Session state artifact**: The JSONL file at `~/.pi/agent/sessions/<project>/<session>.jsonl`
- **Session ID**: The session file path (or UUID embedded in filename)
- On restore, pass `--session <path>` to resume

---

## Configuration Files

### `.pi/settings.json` (project-level)

```json
{
  "thinkingLevel": "medium",
  "autoCompaction": true,
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time"
}
```

### API Key Injection

Pi reads standard env vars:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `GEMINI_API_KEY`

The adapter's `start()` sets these from `session_config`.

### OAuth (ChatGPT Plus/Max)

Pi supports `/login` for OAuth subscriptions. For headless RPC mode, the API key approach is more
reliable. If OAuth is needed, Pi's extension system could handle token refresh (similar to
OpenCode's `codex-auth-plugin.js`).

---

## Extension Mapping (OpenCode Tools → Pi Extensions)

### `create-pull-request.js` Tool

**OpenCode**: A `.opencode/tool/` JavaScript file exporting `tool()`.

**Pi**: A TypeScript extension in `.pi/extensions/`:

```typescript
// .pi/extensions/create-pull-request.ts
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "create_pull_request",
    label: "Create Pull Request",
    description: "Create a GitHub pull request",
    parameters: Type.Object({
      title: Type.String({ description: "PR title" }),
      body: Type.String({ description: "PR body" }),
      branch: Type.String({ description: "Source branch" }),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Call the same CLI script at /usr/local/bin/create-pull-request
      const result = await Bun.$`create-pull-request ${params.branch} ${params.title}`;
      return {
        content: [{ type: "text", text: result.stdout.toString() }],
      };
    },
  });
}
```

### MCP Server Integration

Pi does not have native MCP support. Options:

1. **Extension that bridges MCP**: Write a Pi extension that spawns MCP servers and registers their
   tools with `pi.registerTool()`.
2. **Skip MCP**: If MCP tools are not critical for the workload.
3. **Community package**: Use or build a `pi-mcp-bridge` package.

---

## Compaction

**OpenCode**: Automatic, signals `session.compacted` SSE event.

**Pi RPC**: `compact` command or auto-compaction (enabled by default). Events: `compaction_start` /
`compaction_end` on stdout.

The adapter should watch for `compaction_start`/`compaction_end` events but does NOT need to forward
them to the bridge — they're internal session management. The bridge only cares about
token/tool/completion events.

---

## Timeouts and Error Handling

### Inactivity Timeout

**OpenCode**: SSE stream timeout (`SSE_INACTIVITY_TIMEOUT`).

**Pi**: Read timeout on stdout. If no events for N seconds, consider the process hung.

```python
# Read with timeout on stdout
async def _read_events(self) -> AsyncIterator[dict]:
    while True:
        try:
            line = await asyncio.wait_for(
                self._pi_process.stdout.readline(),
                timeout=self._inactivity_timeout,
            )
            if not line:
                return  # EOF — process exited
            yield json.loads(line.decode())
        except TimeoutError:
            raise RuntimeError(f"Pi process inactive for {self._inactivity_timeout}s")
```

### Max Duration

Same concept — track wall clock time per prompt and abort if exceeded.

### Auto-Retry

Pi has built-in auto-retry for transient errors (overloaded, rate limit, 5xx). Events:
`auto_retry_start` / `auto_retry_end`. The adapter can forward these as info or ignore them (they're
transparent to the control plane).

---

## Process Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│ Modal Sandbox                                            │
│                                                          │
│  ┌─────────────────────┐    ┌─────────────────────────┐ │
│  │ Entrypoint/Supervisor│    │ Bridge Process           │ │
│  │                     │    │                           │ │
│  │ • Git sync          │    │  ┌───────────────────┐   │ │
│  │ • Install (.pi/)    │    │  │ pi --mode rpc     │   │ │
│  │ • Monitor processes │    │  │ (subprocess)      │   │ │
│  │                     │    │  │                   │   │ │
│  │                     │    │  │ stdin ← commands  │   │ │
│  │                     │    │  │ stdout → events   │   │ │
│  │                     │    │  │ stderr → logs     │   │ │
│  │                     │    │  └───────────────────┘   │ │
│  │                     │    │         ↕                 │ │
│  │                     │    │  PiAdapter (translates)   │ │
│  │                     │    │         ↕                 │ │
│  │                     │    │  WebSocket → Control Plane│ │
│  └─────────────────────┘    └─────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Complexity Eliminated by Switching to Pi

The OpenCode adapter's `send_prompt()` is ~400 lines because of SSE's non-sequential event model.
These entire subsystems **disappear** with Pi:

| OpenCode complexity                       | Why it exists                                                      | Pi equivalent                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `OpenCodeIdentifier` (ascending IDs)      | Correlate user message → assistant response across SSE             | Not needed — Pi events arrive in order, scoped to one prompt                |
| `allowed_assistant_msg_ids` tracking      | SSE streams ALL sessions' events; must filter to "ours"            | Not needed — Pi stdout only contains events for this session                |
| `pending_parts` buffer                    | Parts arrive before their parent message.updated                   | Not needed — Pi emits `tool_execution_start` only when tool actually starts |
| `tracked_child_session_ids`               | OpenCode sub-tasks spawn child sessions with their own events      | Not needed — Pi doesn't have sub-agents by default (single loop)            |
| `compaction_occurred` flag                | Post-compaction, parentID no longer matches; must widen acceptance | Not needed — Pi compaction is transparent; events keep flowing normally     |
| `_fetch_final_message_state()`            | SSE may miss final text; HTTP fetch fills gaps                     | Not needed — Pi `agent_end` event guarantees all data was emitted           |
| `emitted_tool_states` dedup               | SSE may re-emit same tool state on reconnect                       | Not needed — Pi events are sequential, no duplicates                        |
| SSE parsing (`_parse_sse_stream`)         | Custom `data:` line parsing with heartbeat reschedule              | Not needed — Pi uses JSONL (one `json.loads()` per line)                    |
| `buffer_part` / `MAX_PENDING_PART_EVENTS` | Backpressure for events arriving out of order                      | Not needed — Pi events are ordered                                          |

**Net result**: `send_prompt()` in the Pi adapter should be ~80-100 lines vs. ~400 in OpenCode.

---

## What Does NOT Map / Requires Changes

| OpenCode concept                   | Pi situation                                      | Action needed                          |
| ---------------------------------- | ------------------------------------------------- | -------------------------------------- |
| HTTP server on port                | No server — subprocess                            | Bridge owns Pi process directly        |
| SSE event stream                   | JSONL on stdout                                   | Simpler; no HTTP connection management |
| Session ID from server             | Synthetic ID + file path                          | Generate UUID, persist JSONL path      |
| `opencode serve` command           | `pi --mode rpc`                                   | Different binary, different args       |
| `OPENCODE_CONFIG_CONTENT` env var  | `.pi/settings.json` + CLI args + env vars         | Write config file                      |
| `OPENCODE_CLIENT=serve`            | Not needed                                        | Pi RPC mode is the equivalent          |
| `.opencode/` directory             | `.pi/` directory                                  | Different structure                    |
| MCP native support                 | Extension-based or skip                           | Build MCP bridge extension             |
| Sub-tasks / child sessions         | Not built-in (extension possible)                 | Single-session simplification          |
| `session.compacted` event          | `compaction_end` event                            | Map if needed                          |
| OAuth auth.json                    | Env vars (`ANTHROPIC_API_KEY`, etc.) or extension | Simpler for API keys                   |
| Message parts model (text, tool)   | Flat content arrays                               | Different content structure            |
| `message.part.updated` correlation | Direct `tool_execution_*` events                  | Much simpler                           |
| Per-provider thinking options      | Unified `set_thinking_level`                      | Pi abstracts this away                 |
| `prompt_async` endpoint            | Synchronous `prompt` command (non-blocking)       | Pi handles async internally            |

---

## Migration Checklist

- [ ] Create `adapters/pi.py` implementing `AgentAdapter`
- [ ] Register in `adapters/__init__.py` under name `"pi"`
- [ ] Rewrite custom tools as Pi extensions (TypeScript)
- [ ] Rewrite skills (format is compatible — same SKILL.md standard)
- [ ] Build/skip MCP bridge extension
- [ ] Add Pi binary to sandbox Docker image
- [ ] Update `SESSION_CONFIG` handling for Pi-specific fields
- [ ] Test snapshot save/restore with Pi session files
- [ ] Update entrypoint to handle `AGENT_ADAPTER=pi` env var
- [ ] Verify event translation produces correct bridge events for control plane
- [ ] Handle Pi's `extension_ui_request` events (likely ignore in headless mode)
- [ ] Handle `queue_update` events (likely ignore)
- [ ] Test model switching mid-session via `set_model` RPC command
- [ ] Test thinking level switching via `set_thinking_level`
- [ ] Test abort/stop behavior
- [ ] Test compaction (auto and manual)
- [ ] Test long-running prompts with inactivity timeout
- [ ] Update Docker image to include `npm install -g @mariozechner/pi-coding-agent`

---

## Appendix: Complete Event Translation Table

### Pi stdout → Bridge events (forwarded to control plane)

| Pi Event                                                                                      | When                    | Bridge Event                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `{"type": "response", "command": "prompt", "success": true}`                                  | After prompt accepted   | _(no bridge event — internal)_                                                                     |
| `{"type": "response", "command": "prompt", "success": false, "error": "..."}`                 | Prompt rejected         | `{"type": "error", "error": "...", "messageId": "..."}`                                            |
| `{"type": "agent_start"}`                                                                     | Agent begins processing | _(no bridge event)_                                                                                |
| `{"type": "turn_start"}`                                                                      | New LLM call begins     | `{"type": "step_start", "messageId": "..."}`                                                       |
| `{"type": "message_start", "message": {...}}`                                                 | Message begins          | _(no bridge event)_                                                                                |
| `{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "..."}}` | Streaming text          | `{"type": "token", "content": "<cumulative>", "messageId": "..."}`                                 |
| `{"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", ...}}`        | Thinking                | _(no bridge event — internal reasoning)_                                                           |
| `{"type": "message_end", "message": {...}}`                                                   | Message complete        | _(no bridge event)_                                                                                |
| `{"type": "tool_execution_start", "toolCallId": "...", "toolName": "...", "args": {...}}`     | Tool begins             | `{"type": "tool_call", "tool": "...", "args": {...}, "status": "running", "messageId": "..."}`     |
| `{"type": "tool_execution_update", "toolCallId": "...", "partialResult": {...}}`              | Tool streaming          | `{"type": "tool_call", "tool": "...", "status": "running", "output": "...", "messageId": "..."}`   |
| `{"type": "tool_execution_end", "toolCallId": "...", "result": {...}, "isError": false}`      | Tool done               | `{"type": "tool_call", "tool": "...", "status": "completed", "output": "...", "messageId": "..."}` |
| `{"type": "tool_execution_end", "toolCallId": "...", "result": {...}, "isError": true}`       | Tool failed             | `{"type": "tool_call", "tool": "...", "status": "error", "output": "...", "messageId": "..."}`     |
| `{"type": "turn_end", "message": {...}, "toolResults": [...]}`                                | Turn complete           | `{"type": "step_finish", "cost": ..., "tokens": {...}, "messageId": "..."}`                        |
| `{"type": "agent_end", "messages": [...]}`                                                    | Agent finished          | _(triggers `execution_complete` in bridge)_                                                        |
| `{"type": "compaction_start", ...}`                                                           | Compacting              | _(no bridge event — internal)_                                                                     |
| `{"type": "compaction_end", ...}`                                                             | Compaction done         | _(no bridge event — internal)_                                                                     |
| `{"type": "auto_retry_start", ...}`                                                           | Retrying                | _(no bridge event — internal)_                                                                     |
| `{"type": "auto_retry_end", "success": false, ...}`                                           | Retry failed            | `{"type": "error", "error": "...", "messageId": "..."}`                                            |
| `{"type": "extension_ui_request", ...}`                                                       | Extension wants UI      | _(ignore in headless — auto-timeout)_                                                              |
| `{"type": "extension_error", ...}`                                                            | Extension error         | _(log only)_                                                                                       |

### Bridge → Pi stdin (commands from control plane)

| Control Plane Command                                  | Pi RPC Command                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `{"type": "prompt", "content": "...", "model": "..."}` | `{"type": "set_model", ...}` + `{"type": "prompt", "message": "..."}` |
| `{"type": "stop"}`                                     | `{"type": "abort"}`                                                   |
| `{"type": "snapshot"}`                                 | _(adapter handles — no Pi equivalent needed)_                         |
| `{"type": "shutdown"}`                                 | Close stdin → Pi exits gracefully                                     |

---

## Comprehensive Testing Protocol

### Test Coverage Goals

**Target Coverage**: 80%+ including error paths and integration scenarios **Current Coverage**: ~40%
(happy path heavy, error path light)

### Test File Structure

```
packages/sandbox-runtime/tests/
├── test_pi_adapter_unit.py          # Unit tests for individual methods
├── test_pi_adapter_events.py        # Event translation tests
├── test_pi_adapter_errors.py        # Error path and failure mode tests
├── test_pi_adapter_concurrency.py   # Concurrency and synchronization tests
├── test_pi_adapter_integration.py   # End-to-end workflow tests
└── fixtures/
    └── pi_responses/                # Sample Pi RPC responses for mocking
        ├── get_state_success.json
        ├── prompt_response.json
        └── error_response.json
```

### 1. Unit Tests (`test_pi_adapter_unit.py`)

**Purpose**: Test individual methods in isolation with mocked Pi process.

#### Test Cases

```python
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path
from sandbox_runtime.adapters.pi import PiAdapter

class TestPiAdapterUnit:
    """Unit tests for PiAdapter methods."""

    @pytest.mark.asyncio
    async def test_install_creates_directory_structure(self, tmp_path):
        """Test that install() creates .pi/ directory structure."""
        adapter = PiAdapter()
        session_config = {"provider": "anthropic", "model": "claude-sonnet-4-20250514"}

        await adapter.install(tmp_path, session_config)

        assert (tmp_path / ".pi").exists()
        assert (tmp_path / ".pi" / "extensions").exists()
        assert (tmp_path / ".pi" / "skills").exists()
        assert (tmp_path / ".pi" / "settings.json").exists()

    @pytest.mark.asyncio
    async def test_start_creates_test_process(self, tmp_path):
        """Test that start() spawns and validates a test Pi instance."""
        adapter = PiAdapter()
        session_config = {"provider": "anthropic", "model": "claude-sonnet-4-20250514"}

        with patch.object(adapter, '_build_env') as mock_env:
            mock_env.return_value = {}
            with patch('asyncio.create_subprocess_exec') as mock_spawn:
                mock_process = AsyncMock()
                mock_process.returncode = None
                mock_spawn.return_value = mock_process

                await adapter.start(tmp_path, session_config)

                # Verify Pi was spawned with correct args
                mock_spawn.assert_called_once()
                call_args = mock_spawn.call_args
                assert "pi" in call_args[0]
                assert "--mode" in call_args[0]
                assert "rpc" in call_args[0]

    @pytest.mark.asyncio
    async def test_get_process_returns_handle(self, tmp_path):
        """Test that get_process() returns the subprocess handle."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        result = adapter.get_process()
        assert result == adapter._pi_process

    @pytest.mark.asyncio
    async def test_health_check_returns_true_for_healthy_process(self):
        """Test health_check() returns True when process is alive and responsive."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        with patch.object(adapter, '_send_command', new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"success": True}

            result = await adapter.health_check()
            assert result is True
            mock_send.assert_called_once_with({"type": "get_state"})

    @pytest.mark.asyncio
    async def test_health_check_returns_false_for_dead_process(self):
        """Test health_check() returns False when process is dead."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = 1  # Process exited

        result = await adapter.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_health_check_returns_false_on_timeout(self):
        """Test health_check() returns False when get_state times out."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        with patch.object(adapter, '_send_command', new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = asyncio.TimeoutError()

            result = await adapter.health_check()
            assert result is False

    @pytest.mark.asyncio
    async def test_save_and_load_session_id(self, tmp_path):
        """Test session ID persistence."""
        adapter = PiAdapter()
        adapter.SESSION_ID_FILE = tmp_path / "test-session-id"

        await adapter.save_session_id("test-session-123")
        result = await adapter.load_session_id()

        assert result == "test-session-123"

    @pytest.mark.asyncio
    async def test_load_session_id_returns_none_when_missing(self, tmp_path):
        """Test load_session_id() returns None when file doesn't exist."""
        adapter = PiAdapter()
        adapter.SESSION_ID_FILE = tmp_path / "nonexistent-session-id"

        result = await adapter.load_session_id()
        assert result is None
```

### 2. Event Translation Tests (`test_pi_adapter_events.py`)

**Purpose**: Verify Pi events are correctly translated to bridge events.

#### Test Cases

```python
import pytest
from sandbox_runtime.adapters.pi import PiAdapter

class TestPiEventTranslation:
    """Tests for Pi event to bridge event translation."""

    @pytest.mark.asyncio
    async def test_text_delta_becomes_token_event(self):
        """Test that Pi text_delta events are translated to token events."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"

        pi_event = {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "text_delta",
                "delta": "Hello",
                "partial": {"text": "Hello"}
            }
        }

        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event["type"] == "token"
        assert bridge_event["content"] == "Hello"
        assert bridge_event["messageId"] == "msg_123"

    @pytest.mark.asyncio
    async def test_tool_execution_start_becomes_tool_call_running(self):
        """Test tool execution start events become tool_call with status=running."""
        adapter = PiAdapter()

        pi_event = {
            "type": "tool_execution_start",
            "toolCallId": "call_123",
            "toolName": "bash",
            "args": {"command": "ls -la"}
        }

        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event["type"] == "tool_call"
        assert bridge_event["tool"] == "bash"
        assert bridge_event["status"] == "running"
        assert bridge_event["args"] == {"command": "ls -la"}
        assert bridge_event["messageId"] == "msg_123"

    @pytest.mark.asyncio
    async def test_tool_execution_end_success_becomes_tool_call_completed(self):
        """Test successful tool execution end becomes tool_call with status=completed."""
        adapter = PiAdapter()

        pi_event = {
            "type": "tool_execution_end",
            "toolCallId": "call_123",
            "toolName": "bash",
            "result": {
                "content": [{"type": "text", "text": "file1.txt\nfile2.txt"}]
            },
            "isError": False
        }

        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event["type"] == "tool_call"
        assert bridge_event["status"] == "completed"
        assert "file1.txt" in bridge_event["output"]

    @pytest.mark.asyncio
    async def test_tool_execution_end_error_becomes_tool_call_error(self):
        """Test failed tool execution end becomes tool_call with status=error."""
        adapter = PiAdapter()

        pi_event = {
            "type": "tool_execution_end",
            "toolCallId": "call_123",
            "toolName": "bash",
            "result": {
                "content": [{"type": "text", "text": "command not found"}]
            },
            "isError": True
        }

        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event["type"] == "tool_call"
        assert bridge_event["status"] == "error"
        assert "command not found" in bridge_event["output"]

    @pytest.mark.asyncio
    async def test_turn_start_becomes_step_start(self):
        """Test turn_start events become step_start events."""
        adapter = PiAdapter()

        pi_event = {"type": "turn_start"}
        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event["type"] == "step_start"
        assert bridge_event["messageId"] == "msg_123"

    @pytest.mark.asyncio
    async def test_turn_end_becomes_step_finish_with_usage(self):
        """Test turn_end events become step_finish with cost and tokens."""
        adapter = PiAdapter()

        pi_event = {
            "type": "turn_end",
            "message": {
                "usage": {
                    "input": 100,
                    "output": 50,
                    "cost": {"total": 0.003}
                }
            }
        }

        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event["type"] == "step_finish"
        assert bridge_event["cost"] == 0.003
        assert bridge_event["tokens"]["input"] == 100
        assert bridge_event["tokens"]["output"] == 50

    @pytest.mark.asyncio
    async def test_agent_end_signals_completion(self):
        """Test that agent_end returns None to signal completion."""
        adapter = PiAdapter()

        pi_event = {"type": "agent_end", "messages": []}
        bridge_event = adapter._translate_pi_event(pi_event, "msg_123")

        assert bridge_event is None  # Signals completion to send_prompt()

    def test_extract_text_from_content_array(self):
        """Test _extract_text() correctly extracts text from Pi content arrays."""
        adapter = PiAdapter()

        content = [
            {"type": "text", "text": "Line 1\n"},
            {"type": "text", "text": "Line 2\n"}
        ]

        result = adapter._extract_text(content)
        assert result == "Line 1\nLine 2\n"

    def test_extract_text_ignores_non_text_content(self):
        """Test _extract_text() ignores non-text content types."""
        adapter = PiAdapter()

        content = [
            {"type": "image", "data": "base64..."},
            {"type": "text", "text": "Only text"},
            {"type": "thinking", "thinking": "Internal reasoning"}
        ]

        result = adapter._extract_text(content)
        assert result == "Only text"
```

### 3. Error Path Tests (`test_pi_adapter_errors.py`)

**Purpose**: Test failure scenarios and error handling.

#### Test Cases

```python
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from sandbox_runtime.adapters.pi import PiAdapter

class TestPiAdapterErrorPaths:
    """Tests for error handling and failure modes."""

    @pytest.mark.asyncio
    async def test_send_prompt_handles_pi_crash(self, tmp_path):
        """Test that Pi crash during prompt yields error event instead of hanging."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"

        # Mock a Pi process that crashes
        mock_process = MagicMock()
        mock_process.stdin = MagicMock()
        mock_process.stdin.write = MagicMock(side_effect=BrokenPipeError("Broken pipe"))
        mock_process.stdin.flush = MagicMock()
        adapter._pi_process = mock_process

        events = []
        async for event in adapter.send_prompt("test", "msg_1"):
            events.append(event)

        # Should get error event, not hang forever
        assert len(events) > 0
        assert any(e.get("type") == "error" for e in events)
        assert any("Broken pipe" in str(e.get("error", "")) for e in events)

    @pytest.mark.asyncio
    async def test_send_prompt_handles_write_timeout(self, tmp_path):
        """Test that stdin write timeout yields error event."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"

        mock_process = MagicMock()
        mock_process.stdin = MagicMock()
        mock_process.stdin.write = MagicMock(side_effect=asyncio.TimeoutError())
        mock_process.stdin.flush = MagicMock()
        adapter._pi_process = mock_process

        events = []
        async for event in adapter.send_prompt("test", "msg_1"):
            events.append(event)

        assert any(e.get("type") == "error" for e in events)

    @pytest.mark.asyncio
    async def test_send_prompt_handles_stdout_read_error(self, tmp_path):
        """Test that stdout read errors yield error event."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"

        with patch.object(adapter, '_read_events', new_callable=AsyncMock) as mock_read:
            mock_read.side_effect = ConnectionResetError("Connection reset")

            events = []
            async for event in adapter.send_prompt("test", "msg_1"):
                events.append(event)

            assert any(e.get("type") == "error" for e in events)
            assert any("Connection reset" in str(e.get("error", "")) for e in events)

    @pytest.mark.asyncio
    async def test_create_session_handles_spawn_failure(self, tmp_path):
        """Test that Pi spawn failure raises clear error."""
        adapter = PiAdapter()

        with patch('asyncio.create_subprocess_exec') as mock_spawn:
            mock_spawn.side_effect = FileNotFoundError("pi not found")

            with pytest.raises(RuntimeError) as exc_info:
                await adapter.create_session(str(tmp_path))

            assert "pi not found" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_create_session_handles_get_state_timeout(self, tmp_path):
        """Test that get_state timeout during session creation is handled."""
        adapter = PiAdapter()

        with patch.object(adapter, '_spawn_pi', new_callable=AsyncMock):
            adapter._pi_process = MagicMock()
            adapter._pi_process.returncode = None

            with patch.object(adapter, '_send_command', new_callable=AsyncMock) as mock_send:
                mock_send.side_effect = asyncio.TimeoutError()

                with pytest.raises(RuntimeError) as exc_info:
                    await adapter.create_session(str(tmp_path))

                assert "timeout" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_health_check_handles_process_death_during_check(self):
        """Test health_check() when process dies during get_state."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        with patch.object(adapter, '_send_command', new_callable=AsyncMock) as mock_send:
            # Process dies during health check
            mock_send.side_effect = [
                {"success": True},  # First call succeeds
                BrokenPipeError()   # Second call fails (process died)
            ]

            # First call should succeed
            result1 = await adapter.health_check()
            assert result1 is True

            # Second call should handle the error gracefully
            result2 = await adapter.health_check()
            assert result2 is False

    @pytest.mark.asyncio
    async def test_save_session_id_handles_disk_full(self, tmp_path):
        """Test session ID save failure doesn't crash adapter."""
        adapter = PiAdapter()
        adapter.SESSION_ID_FILE = tmp_path / "test-session-id"

        with patch.object(adapter.SESSION_ID_FILE, 'write_text') as mock_write:
            mock_write.side_effect = OSError("No space left on device")

            # Should not raise, just log error
            await adapter.save_session_id("test-session")
            # Verify error was handled (would check logs in real test)

    @pytest.mark.asyncio
    async def test_shutdown_handles_already_dead_process(self):
        """Test shutdown() when process is already dead."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = 1  # Already dead

        # Should not raise, just return
        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_shutdown_handles_termination_timeout(self):
        """Test shutdown() when graceful termination times out."""
        adapter = PiAdapter()
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None
        adapter._pi_process.stdin = MagicMock()
        adapter._pi_process.stdin.is_closing = MagicMock(return_value=False)

        with patch('asyncio.wait_for') as mock_wait:
            # First wait (graceful) times out
            mock_wait.side_effect = [
                asyncio.TimeoutError(),  # Graceful shutdown timeout
                asyncio.TimeoutError(),  # SIGTERM timeout
                None                     # SIGKILL succeeds
            ]

            await adapter.shutdown()

            # Should have tried graceful, then SIGTERM, then SIGKILL
            assert mock_wait.call_count == 3
```

### 4. Concurrency Tests (`test_pi_adapter_concurrency.py`)

**Purpose**: Verify stdin/stdout synchronization under concurrent operations.

#### Test Cases

```python
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from sandbox_runtime.adapters.pi import PiAdapter

class TestPiAdapterConcurrency:
    """Tests for concurrent operation safety."""

    @pytest.mark.asyncio
    async def test_concurrent_health_check_and_prompt(self, tmp_path):
        """Test that health_check doesn't interfere with active prompt."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"
        adapter._stdin_lock = asyncio.Lock()
        adapter._event_queue = asyncio.Queue()

        # Mock Pi process
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        # Mock event stream
        async def mock_read_events():
            yield {"type": "turn_start"}
            yield {"type": "agent_end"}

        with patch.object(adapter, '_read_events', side_effect=mock_read_events):
            with patch.object(adapter, '_write_stdin'):
                # Start prompt in background
                prompt_task = asyncio.create_task(
                    list(adapter.send_prompt("test", "msg_1"))
                )

                # Run health check concurrently
                with patch.object(adapter, '_send_command', new_callable=AsyncMock) as mock_send:
                    mock_send.return_value = {"success": True}
                    is_healthy = await adapter.health_check()

                # Both should complete without corruption
                assert is_healthy
                events = await prompt_task
                assert len(events) > 0

    @pytest.mark.asyncio
    async def test_concurrent_prompts_are_sequentialized(self, tmp_path):
        """Test that multiple prompts don't corrupt stdin via locking."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"
        adapter._stdin_lock = asyncio.Lock()
        adapter._event_queue = asyncio.Queue()

        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        write_count = 0

        async def mock_write_stdin(cmd):
            nonlocal write_count
            await asyncio.sleep(0.1)  # Simulate slow write
            write_count += 1

        with patch.object(adapter, '_write_stdin', side_effect=mock_write_stdin):
            async def mock_read_events():
                yield {"type": "turn_start"}
                yield {"type": "agent_end"}

            with patch.object(adapter, '_read_events', side_effect=mock_read_events):
                # Start multiple prompts concurrently
                tasks = [
                    asyncio.create_task(list(adapter.send_prompt(f"test{i}", f"msg_{i}")))
                    for i in range(3)
                ]

                # All should complete
                results = await asyncio.gather(*tasks)
                assert all(len(r) > 0 for r in results)

                # All writes should have happened (no corruption)
                assert write_count == 3

    @pytest.mark.asyncio
    async def test_event_queue_prevents_unbounded_growth(self, tmp_path):
        """Test that event queue with maxsize prevents memory leaks."""
        from collections import deque

        adapter = PiAdapter()
        adapter._event_queue = asyncio.Queue(maxsize=10)  # Small queue for testing
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        dropped_events = []

        async def mock_read_stdout():
            # Flood with events
            for i in range(20):  # More than queue size
                try:
                    await asyncio.wait_for(
                        adapter._event_queue.put({"type": "test", "id": i}),
                        timeout=0.01
                    )
                except asyncio.TimeoutError:
                    dropped_events.append(i)

        # Start reader task
        reader_task = asyncio.create_task(mock_read_stdout())
        await asyncio.sleep(0.1)

        # Should have dropped some events
        assert len(dropped_events) > 0

        # Cleanup
        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_stop_during_active_prompt(self, tmp_path):
        """Test that stop() works correctly when prompt is running."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"
        adapter._stdin_lock = asyncio.Lock()
        adapter._event_queue = asyncio.Queue()

        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        stop_called = False

        async def mock_read_events():
            # Simulate long-running prompt
            for i in range(5):
                yield {"type": "turn_start"}
                await asyncio.sleep(0.1)
                if stop_called:
                    break

        with patch.object(adapter, '_read_events', side_effect=mock_read_events):
            with patch.object(adapter, '_write_stdin') as mock_write:
                # Start prompt
                prompt_task = asyncio.create_task(
                    list(adapter.send_prompt("test", "msg_1"))
                )

                # Wait a bit, then stop
                await asyncio.sleep(0.15)
                await adapter.stop("test-session")
                stop_called = True

                # Prompt should end (not hang forever)
                try:
                    await asyncio.wait_for(prompt_task, timeout=1.0)
                except asyncio.TimeoutError:
                    pytest.fail("Prompt did not stop after abort command")

                # Verify abort was sent
                abort_calls = [call for call in mock_write.call_args_list
                              if "abort" in str(call)]
                assert len(abort_calls) > 0
```

### 5. Integration Tests (`test_pi_adapter_integration.py`)

**Purpose**: End-to-end workflow tests with real Pi process (if available) or comprehensive mocking.

#### Test Cases

```python
import pytest
import asyncio
from pathlib import Path
from sandbox_runtime.adapters.pi import PiAdapter

class TestPiAdapterIntegration:
    """End-to-end integration tests for Pi adapter."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_full_prompt_workflow_with_tools(self, tmp_path):
        """Test complete prompt flow with tool execution."""
        pytest.skip("Requires real Pi binary - run with: pytest -m integration")

        adapter = PiAdapter()
        session_config = {
            "provider": "anthropic",
            "model": "claude-sonnet-4-20250514"
        }

        # Setup
        await adapter.install(tmp_path, session_config)
        session_id = await adapter.create_session(str(tmp_path))

        # Execute prompt with tool call
        events = []
        async for event in adapter.send_prompt(
            session_id, "List files in current directory", "msg_1"
        ):
            events.append(event)

        # Verify event sequence
        event_types = [e.get("type") for e in events]
        assert "step_start" in event_types
        assert "tool_call" in event_types
        assert "step_finish" in event_types

        # Verify tool call details
        tool_calls = [e for e in events if e.get("type") == "tool_call"]
        assert len(tool_calls) > 0
        assert tool_calls[0]["tool"] in ["bash", "read", "list"]

        # Cleanup
        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_session_snapshot_and_restore(self, tmp_path):
        """Test session persistence across adapter restarts."""
        adapter = PiAdapter()
        session_config = {
            "provider": "anthropic",
            "model": "claude-sonnet-4-20250514"
        }

        # Create initial session
        await adapter.install(tmp_path, session_config)
        session_id_1 = await adapter.create_session(str(tmp_path))

        # Send a prompt
        events_1 = []
        async for event in adapter.send_prompt(
            session_id_1, "Remember: test value = 42", "msg_1"
        ):
            events_1.append(event)

        # Shutdown adapter
        await adapter.shutdown()

        # Create new adapter instance (simulates restart)
        adapter_2 = PiAdapter()
        adapter_2.SESSION_ID_FILE = adapter.SESSION_ID_FILE

        # Restore session
        restored_session_id = await adapter_2.load_session_id()
        assert restored_session_id == session_id_1

        # Send follow-up prompt
        events_2 = []
        async for event in adapter_2.send_prompt(
            restored_session_id, "What was the test value?", "msg_2"
        ):
            events_2.append(event)

        # Should have context from previous prompt
        assert len(events_2) > 0

        # Cleanup
        await adapter_2.shutdown()

    @pytest.mark.asyncio
    async def test_model_switching_mid_session(self, tmp_path):
        """Test switching models during an active session."""
        adapter = PiAdapter()
        session_config = {
            "provider": "anthropic",
            "model": "claude-sonnet-4-20250514"
        }

        await adapter.install(tmp_path, session_config)
        session_id = await adapter.create_session(str(tmp_path))

        # Send prompt with default model
        events_1 = []
        async for event in adapter.send_prompt(
            session_id, "First prompt", "msg_1"
        ):
            events_1.append(event)

        # Switch model
        with patch.object(adapter, '_send_command', new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"success": True}
            await adapter._set_model("claude-opus-4-6", "high")

            # Verify set_model was called
            model_calls = [call for call in mock_send.call_args_list
                          if "set_model" in str(call)]
            assert len(model_calls) > 0

        # Send prompt with new model
        events_2 = []
        async for event in adapter.send_prompt(
            session_id, "Second prompt", "msg_2", model="claude-opus-4-6"
        ):
            events_2.append(event)

        assert len(events_2) > 0

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_multiple_prompts_same_session(self, tmp_path):
        """Test multiple sequential prompts in the same session."""
        adapter = PiAdapter()
        session_config = {
            "provider": "anthropic",
            "model": "claude-sonnet-4-20250514"
        }

        await adapter.install(tmp_path, session_config)
        session_id = await adapter.create_session(str(tmp_path))

        # Send multiple prompts
        for i in range(3):
            events = []
            async for event in adapter.send_prompt(
                session_id, f"Prompt number {i+1}", f"msg_{i+1}"
            ):
                events.append(event)

            # Each prompt should complete successfully
            assert len(events) > 0
            assert any(e.get("type") == "step_finish" for e in events)

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_inactivity_timeout_detection(self, tmp_path):
        """Test that inactivity timeout is detected and handled."""
        adapter = PiAdapter()
        adapter._inactivity_timeout = 0.5  # Short timeout for testing
        adapter._session_id = "test-session"
        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None

        # Mock event stream that hangs
        async def mock_read_events():
            yield {"type": "turn_start"}
            await asyncio.sleep(10)  # Simulate hang (longer than timeout)
            yield {"type": "agent_end"}

        with patch.object(adapter, '_read_events', side_effect=mock_read_events):
            with patch.object(adapter, '_write_stdin'):
                events = []
                with pytest.raises(RuntimeError) as exc_info:
                    async for event in adapter.send_prompt("test", "msg_1"):
                        events.append(event)

                assert "inactive" in str(exc_info.value).lower()
                assert "timeout" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_extension_ui_auto_response(self, tmp_path):
        """Test that extension_ui_request events are auto-responded to."""
        adapter = PiAdapter()
        adapter._session_id = "test-session"
        adapter._stdin_lock = asyncio.Lock()
        adapter._event_queue = asyncio.Queue()

        adapter._pi_process = MagicMock()
        adapter._pi_process.returncode = None
        adapter._pi_process.stdin = MagicMock()

        ui_responses = []

        def mock_write_stdin(cmd):
            if cmd.get("type") == "extension_ui_response":
                ui_responses.append(cmd)

        adapter._pi_process.stdin.write = mock_write_stdin
        adapter._pi_process.stdin.flush = MagicMock()

        # Simulate extension_ui_request in event stream
        async def mock_read_events():
            yield {"type": "turn_start"}
            yield {"type": "agent_end"}

        with patch.object(adapter, '_read_events', side_effect=mock_read_events):
            # Simulate receiving extension_ui_request
            await adapter._event_queue.put({
                "type": "extension_ui_request",
                "id": "req-123",
                "method": "confirm",
                "title": "Allow operation?"
            })

            # Start UI handler task
            ui_task = asyncio.create_task(adapter._handle_extension_ui_requests())

            # Wait a bit for auto-response
            await asyncio.sleep(0.2)

            # Verify auto-response was sent
            assert len(ui_responses) > 0
            assert ui_responses[0]["type"] == "extension_ui_response"
            assert ui_responses[0]["id"] == "req-123"
            assert ui_responses[0]["confirmed"] == False  # Safe default

            # Cleanup
            ui_task.cancel()
            try:
                await ui_task
            except asyncio.CancelledError:
                pass
```

### Test Execution

**Run all tests**:

```bash
cd packages/sandbox-runtime
pytest tests/test_pi_adapter_*.py -v
```

**Run only unit tests**:

```bash
pytest tests/test_pi_adapter_unit.py -v
```

**Run integration tests (requires real Pi binary)**:

```bash
pytest tests/test_pi_adapter_integration.py -v -m integration
```

**Run with coverage**:

```bash
pytest tests/test_pi_adapter_*.py --cov=sandbox_runtime.adapters.pi --cov-report=html
```

### Test Coverage Targets

- **Line Coverage**: ≥80%
- **Branch Coverage**: ≥75%
- **Error Path Coverage**: ≥90% of identified failure modes

### Continuous Integration

Add to CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Run PI adapter tests
  run: |
    cd packages/sandbox-runtime
    pytest tests/test_pi_adapter_*.py -v --cov=sandbox_runtime.adapters.pi

- name: Check coverage thresholds
  run: |
    cd packages/sandbox-runtime
    pytest tests/test_pi_adapter_*.py --cov=sandbox_runtime.adapters.pi --cov-fail-under=80
```

### Test Maintenance

**When to update tests**:

- Pi RPC protocol changes
- New event types added
- Adapter interface changes
- New failure modes discovered in production

**Test review checklist**:

- [ ] All error paths have corresponding tests
- [ ] Event translation is verified for all event types
- [ ] Concurrency scenarios are tested
- [ ] Integration tests cover critical workflows
- [ ] Tests are fast (unit tests < 1s each)
- [ ] Tests are deterministic (no flaky tests)
- [ ] Test names clearly describe what they test
