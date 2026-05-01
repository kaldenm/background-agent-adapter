# Pi Agent Adapter Spec — Replacing OpenCode with Pi

## Overview

This document specifies how to implement a `PiAdapter` that replaces
`OpenCodeAdapter` in the Open-Inspect sandbox runtime. Pi (`@mariozechner/pi-coding-agent`)
runs in **RPC mode** (`pi --mode rpc`) as a subprocess communicating via
JSONL over stdin/stdout — a fundamentally different integration pattern
from OpenCode's HTTP serve + SSE model.

### Key Architectural Difference

| Aspect | OpenCode (current) | Pi (target) |
|--------|-------------------|-------------|
| **Process model** | HTTP server on a port, SSE event stream | Subprocess with stdin/stdout JSONL |
| **Session creation** | `POST /session` → session ID | Implicit (one session per process), or `--session <path>` |
| **Prompting** | `POST /session/{id}/prompt_async` + SSE `/event` | `{"type": "prompt", "message": "..."}` on stdin |
| **Events** | SSE stream with `message.updated`, `message.part.updated`, etc. | JSONL stdout: `agent_start`, `message_update`, `tool_execution_*`, `agent_end` |
| **Health check** | `GET /global/health` | Process alive + stdin/stdout responsive |
| **Stop/Abort** | `POST /session/{id}/abort` | `{"type": "abort"}` on stdin |
| **Session persistence** | Managed by OpenCode server (SQLite DB) | JSONL session files in `~/.pi/agent/sessions/` |

---

## AgentAdapter Method Mapping

### Entrypoint Process Methods

#### `install(workdir, session_config)`

**OpenCode**: Copies tools to `.opencode/tool/`, skills to `.opencode/skills/`,
installs MCP packages, deploys OAuth plugins.

**Pi**: Install Pi globally (or use a pre-installed binary in the image).
Set up the equivalent resources:

| OpenCode resource | Pi equivalent | Location |
|-------------------|---------------|----------|
| `.opencode/tool/*.js` | Extensions (TypeScript) | `.pi/extensions/` or `~/.pi/agent/extensions/` |
| `.opencode/skills/` | Skills (SKILL.md dirs) | `.pi/skills/` or `~/.pi/agent/skills/` |
| `.opencode/plugins/` | Extensions | `.pi/extensions/` |
| MCP servers | Extensions (Pi has no native MCP, build an extension) or skip | `.pi/extensions/mcp-bridge.ts` |
| `OPENCODE_CONFIG_CONTENT` | `settings.json` + env vars | `.pi/settings.json` |

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

**Pi**: Launches `pi --mode rpc` as a subprocess. "Healthy" means the process
is alive and responding to commands on stdin/stdout.

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

**Pi**: Does not use HTTP at all. This method is mostly a no-op. However,
we still store configuration for the stdin/stdout protocol. The adapter
needs access to the subprocess pipes, not an HTTP client.

**Design decision**: Since Pi communicates via subprocess pipes (not HTTP),
the bridge needs the adapter to either:
- (a) Have a reference to the spawned process (set during `start()`), OR
- (b) Start its own Pi subprocess in the bridge process

Given the two-process architecture (entrypoint starts the agent, bridge
communicates with it), we need a **shared-memory or IPC** approach. Two options:

**Option A — Single Pi process, shared pipes via file descriptors:**
The entrypoint passes the process FDs to the bridge. Complex, fragile.

**Option B — Bridge spawns its own Pi process (recommended):**
The bridge subprocess spawns `pi --mode rpc` itself. The entrypoint's `start()`
becomes a readiness check only. This maps cleanly to Pi's architecture since
each Pi process IS a session.

**Option C — Pi in subprocess mode with a named pipe / Unix socket:**
Not supported by Pi RPC mode (stdin/stdout only).

**Recommendation: Option B.** The bridge owns the Pi process. The entrypoint
validates installation and pre-warms nothing (or spawns+kills a test instance).
This is cleaner because Pi RPC mode is designed as a subprocess protocol.

```python
def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
    # http_client not needed for Pi (no HTTP API)
    # port not needed for Pi (no server)
    # Store for potential future use
    self._configured = True
```

#### `create_session(repo_path)`

**OpenCode**: `POST /session` → returns session ID string.

**Pi**: Sessions are implicit per-process. When bridge spawns Pi, that IS
the session. Return a synthetic session ID (could be a UUID or the session
file path).

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

**For snapshot restore**: Use `pi --session <path>` or `pi -c` to continue
a previous session. The session JSONL file is the persistence artifact.

#### `send_prompt(session_id, content, message_id, model, reasoning_effort)`

**OpenCode**: Complex SSE streaming with message correlation, part tracking,
cumulative text assembly, child session tracking.

**Pi**: Send `{"type": "prompt", "message": "..."}` on stdin, read JSONL
events from stdout until `agent_end`. Much simpler event model.

**Event mapping (Pi → Open-Inspect bridge events):**

| Pi event | Bridge event | Notes |
|----------|-------------|-------|
| `message_update` (text_delta) | `{"type": "token", "content": cumulative_text, "messageId": msg_id}` | Accumulate deltas into cumulative text |
| `tool_execution_start` | `{"type": "tool_call", "tool": name, "args": {...}, "status": "running", "messageId": msg_id}` | |
| `tool_execution_update` | `{"type": "tool_call", "tool": name, "args": {...}, "status": "running", "output": partial, "messageId": msg_id}` | |
| `tool_execution_end` | `{"type": "tool_call", "tool": name, "args": {...}, "status": "completed", "output": result, "messageId": msg_id}` | |
| `tool_execution_end` (isError) | `{"type": "tool_call", "tool": name, "status": "error", "output": error, "messageId": msg_id}` | |
| `turn_start` | `{"type": "step_start", "messageId": msg_id}` | |
| `turn_end` | `{"type": "step_finish", "messageId": msg_id}` | Include cost/tokens from usage |
| `agent_end` | *(signals completion — bridge emits `execution_complete`)* | |
| Error in streaming | `{"type": "error", "error": "...", "messageId": msg_id}` | |

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

**Same pattern as OpenCode** — file-based persistence of a session identifier.
For Pi, the session ID could map to the JSONL session file path, enabling
snapshot restore via `pi --session <path>`.

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

**Pi**: Same pattern — close stdin (Pi exits gracefully on stdin EOF), then
SIGTERM, then SIGKILL as fallback.

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
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Or pass via CLI: `pi --provider anthropic --model claude-sonnet-4-20250514`

### Reasoning Effort → Thinking Level

**OpenCode**: Provider-specific options (Anthropic adaptive thinking, budgetTokens; OpenAI reasoningEffort).

**Pi**: Unified `set_thinking_level` with levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

| Open-Inspect reasoning_effort | Pi thinking level |
|-------------------------------|-------------------|
| `"low"` | `"low"` |
| `"medium"` | `"medium"` |
| `"high"` | `"high"` |
| `"max"` | `"xhigh"` (OpenAI codex-max only) or `"high"` |
| `None` / unset | `"medium"` (default) |

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

Pi supports `/login` for OAuth subscriptions. For headless RPC mode,
the API key approach is more reliable. If OAuth is needed, Pi's extension
system could handle token refresh (similar to OpenCode's `codex-auth-plugin.js`).

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

1. **Extension that bridges MCP**: Write a Pi extension that spawns MCP servers
   and registers their tools with `pi.registerTool()`.
2. **Skip MCP**: If MCP tools are not critical for the workload.
3. **Community package**: Use or build a `pi-mcp-bridge` package.

---

## Compaction

**OpenCode**: Automatic, signals `session.compacted` SSE event.

**Pi RPC**: `compact` command or auto-compaction (enabled by default).
Events: `compaction_start` / `compaction_end` on stdout.

The adapter should watch for `compaction_start`/`compaction_end` events but
does NOT need to forward them to the bridge — they're internal session management.
The bridge only cares about token/tool/completion events.

---

## Timeouts and Error Handling

### Inactivity Timeout

**OpenCode**: SSE stream timeout (`SSE_INACTIVITY_TIMEOUT`).

**Pi**: Read timeout on stdout. If no events for N seconds, consider the
process hung.

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

Pi has built-in auto-retry for transient errors (overloaded, rate limit, 5xx).
Events: `auto_retry_start` / `auto_retry_end`. The adapter can forward these
as info or ignore them (they're transparent to the control plane).

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

The OpenCode adapter's `send_prompt()` is ~400 lines because of SSE's
non-sequential event model. These entire subsystems **disappear** with Pi:

| OpenCode complexity | Why it exists | Pi equivalent |
|--------------------|--------------|--------------|
| `OpenCodeIdentifier` (ascending IDs) | Correlate user message → assistant response across SSE | Not needed — Pi events arrive in order, scoped to one prompt |
| `allowed_assistant_msg_ids` tracking | SSE streams ALL sessions' events; must filter to "ours" | Not needed — Pi stdout only contains events for this session |
| `pending_parts` buffer | Parts arrive before their parent message.updated | Not needed — Pi emits `tool_execution_start` only when tool actually starts |
| `tracked_child_session_ids` | OpenCode sub-tasks spawn child sessions with their own events | Not needed — Pi doesn't have sub-agents by default (single loop) |
| `compaction_occurred` flag | Post-compaction, parentID no longer matches; must widen acceptance | Not needed — Pi compaction is transparent; events keep flowing normally |
| `_fetch_final_message_state()` | SSE may miss final text; HTTP fetch fills gaps | Not needed — Pi `agent_end` event guarantees all data was emitted |
| `emitted_tool_states` dedup | SSE may re-emit same tool state on reconnect | Not needed — Pi events are sequential, no duplicates |
| SSE parsing (`_parse_sse_stream`) | Custom `data:` line parsing with heartbeat reschedule | Not needed — Pi uses JSONL (one `json.loads()` per line) |
| `buffer_part` / `MAX_PENDING_PART_EVENTS` | Backpressure for events arriving out of order | Not needed — Pi events are ordered |

**Net result**: `send_prompt()` in the Pi adapter should be ~80-100 lines vs. ~400 in OpenCode.

---

## What Does NOT Map / Requires Changes

| OpenCode concept | Pi situation | Action needed |
|-----------------|--------------|---------------|
| HTTP server on port | No server — subprocess | Bridge owns Pi process directly |
| SSE event stream | JSONL on stdout | Simpler; no HTTP connection management |
| Session ID from server | Synthetic ID + file path | Generate UUID, persist JSONL path |
| `opencode serve` command | `pi --mode rpc` | Different binary, different args |
| `OPENCODE_CONFIG_CONTENT` env var | `.pi/settings.json` + CLI args + env vars | Write config file |
| `OPENCODE_CLIENT=serve` | Not needed | Pi RPC mode is the equivalent |
| `.opencode/` directory | `.pi/` directory | Different structure |
| MCP native support | Extension-based or skip | Build MCP bridge extension |
| Sub-tasks / child sessions | Not built-in (extension possible) | Single-session simplification |
| `session.compacted` event | `compaction_end` event | Map if needed |
| OAuth auth.json | Env vars (`ANTHROPIC_API_KEY`, etc.) or extension | Simpler for API keys |
| Message parts model (text, tool) | Flat content arrays | Different content structure |
| `message.part.updated` correlation | Direct `tool_execution_*` events | Much simpler |
| Per-provider thinking options | Unified `set_thinking_level` | Pi abstracts this away |
| `prompt_async` endpoint | Synchronous `prompt` command (non-blocking) | Pi handles async internally |

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

| Pi Event | When | Bridge Event |
|----------|------|-------------|
| `{"type": "response", "command": "prompt", "success": true}` | After prompt accepted | *(no bridge event — internal)* |
| `{"type": "response", "command": "prompt", "success": false, "error": "..."}` | Prompt rejected | `{"type": "error", "error": "...", "messageId": "..."}` |
| `{"type": "agent_start"}` | Agent begins processing | *(no bridge event)* |
| `{"type": "turn_start"}` | New LLM call begins | `{"type": "step_start", "messageId": "..."}` |
| `{"type": "message_start", "message": {...}}` | Message begins | *(no bridge event)* |
| `{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "..."}}` | Streaming text | `{"type": "token", "content": "<cumulative>", "messageId": "..."}` |
| `{"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", ...}}` | Thinking | *(no bridge event — internal reasoning)* |
| `{"type": "message_end", "message": {...}}` | Message complete | *(no bridge event)* |
| `{"type": "tool_execution_start", "toolCallId": "...", "toolName": "...", "args": {...}}` | Tool begins | `{"type": "tool_call", "tool": "...", "args": {...}, "status": "running", "messageId": "..."}` |
| `{"type": "tool_execution_update", "toolCallId": "...", "partialResult": {...}}` | Tool streaming | `{"type": "tool_call", "tool": "...", "status": "running", "output": "...", "messageId": "..."}` |
| `{"type": "tool_execution_end", "toolCallId": "...", "result": {...}, "isError": false}` | Tool done | `{"type": "tool_call", "tool": "...", "status": "completed", "output": "...", "messageId": "..."}` |
| `{"type": "tool_execution_end", "toolCallId": "...", "result": {...}, "isError": true}` | Tool failed | `{"type": "tool_call", "tool": "...", "status": "error", "output": "...", "messageId": "..."}` |
| `{"type": "turn_end", "message": {...}, "toolResults": [...]}` | Turn complete | `{"type": "step_finish", "cost": ..., "tokens": {...}, "messageId": "..."}` |
| `{"type": "agent_end", "messages": [...]}` | Agent finished | *(triggers `execution_complete` in bridge)* |
| `{"type": "compaction_start", ...}` | Compacting | *(no bridge event — internal)* |
| `{"type": "compaction_end", ...}` | Compaction done | *(no bridge event — internal)* |
| `{"type": "auto_retry_start", ...}` | Retrying | *(no bridge event — internal)* |
| `{"type": "auto_retry_end", "success": false, ...}` | Retry failed | `{"type": "error", "error": "...", "messageId": "..."}` |
| `{"type": "extension_ui_request", ...}` | Extension wants UI | *(ignore in headless — auto-timeout)* |
| `{"type": "extension_error", ...}` | Extension error | *(log only)* |

### Bridge → Pi stdin (commands from control plane)

| Control Plane Command | Pi RPC Command |
|----------------------|----------------|
| `{"type": "prompt", "content": "...", "model": "..."}` | `{"type": "set_model", ...}` + `{"type": "prompt", "message": "..."}` |
| `{"type": "stop"}` | `{"type": "abort"}` |
| `{"type": "snapshot"}` | *(adapter handles — no Pi equivalent needed)* |
| `{"type": "shutdown"}` | Close stdin → Pi exits gracefully |
