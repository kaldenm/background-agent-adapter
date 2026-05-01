# Spec: Making Open-Inspect Agent-Pluggable

## Goal
Right now OpenCode is smeared across 3 files (94 references in bridge.py alone). The whole refactor is one move: pull all OpenCode-specific code out of the bridge and entrypoint into its own adapter file, and leave behind generic `self.adapter.*` calls.

After refactoring, OpenCode still works exactly the same — we're just moving where the code lives. Nothing breaks. Tests pass. Then, and only then, can we swap in a different agent by creating a new adapter file.

The order is:
1. **Refactor** — extract OpenCode into an adapter, make bridge/entrypoint generic
2. **Verify** — run tests, confirm OpenCode works exactly as before
3. **Swap** (later) — add a new adapter file, set an env var, done

Every claim verified against source code on 2024-04-30 with line numbers.

---

## Current State: What Needs To Move

Three files currently have OpenCode baked in. After the refactor, all agent-specific code lives in `adapters/opencode.py` and these files become generic.

### File 1: Docker Image — `packages/modal-infra/src/images/base.py`

Installs OpenCode into the sandbox container.

```python
# Line 110: installs OpenCode CLI
"npm install -g opencode-ai@latest",
# Line 114: installs OpenCode plugin SDK
"npm install -g @opencode-ai/plugin@latest zod",
# Lines 122-126: pre-builds OpenCode plugin deps into /app/opencode-deps/
```

**After refactor:** Still installs OpenCode (we're not swapping yet). But the adapter is what knows how to use it — the image just makes it available.

---

### File 2: Entrypoint — `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`

Boots the sandbox. Currently calls `start_opencode()` directly.

**All OpenCode-specific code in this file:**

| Method/Reference | Line | What it does |
|------------------|------|-------------|
| `OPENCODE_PORT = 4096` | 43 | Hardcoded port constant |
| `self.opencode_process` | 57 | Process handle for OpenCode |
| `self.opencode_ready` | 64 | Event flag for health check |
| `self.session_id_file` | 86 | Path to `/tmp/opencode-session-id` |
| `_install_tools()` | 295 | Copies tools into `.opencode/tool/` |
| `_install_skills()` | 353 | Copies skills into `.opencode/skills/` |
| `_setup_openai_oauth()` | 375 | Writes auth.json to `~/.local/share/opencode/` |
| `_build_mcp_config()` | 532 | Converts MCP servers to OpenCode format |
| `start_opencode()` | 646 | Builds config, sets env vars, launches process |
| `_forward_opencode_logs()` | 720 | Forwards OpenCode stdout |
| `_wait_for_health()` | 731 | Polls `localhost:4096/global/health` |
| `start_bridge()` | 753 | Passes `--opencode-port` to bridge subprocess |
| `monitor_processes()` | 822 | Restarts `start_opencode()` on crash (line 863) |
| `run()` | 1235 | Calls `await self.start_opencode()` in boot sequence |
| `shutdown()` | 1315 | Terminates `self.opencode_process` |

**After refactor:** All moves into `adapters/opencode.py`. The entrypoint just says:
```python
agent_name = os.environ.get("AGENT_ADAPTER", "opencode")
adapter = load_adapter(agent_name)
await adapter.start(config)
```

---

### File 3: Bridge — `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`

This is the tangled file. It mixes "talk to the agent" and "talk to the SessionDO" in one class.

**All OpenCode-specific code in this file (94 references total):**

| Method/Reference | Line | What it does |
|------------------|------|-------------|
| `OpenCodeIdentifier` class | 43 | Generates ascending message IDs for OpenCode |
| `OPENCODE_REQUEST_TIMEOUT` | 137 | Timeout constant for OpenCode HTTP calls |
| `opencode_port` param | 158 | Constructor param, hardcoded default 4096 |
| `self.opencode_base_url` | 165 | `http://localhost:{port}` |
| `self.opencode_session_id` | 187 | Stored session ID for OpenCode |
| `self.session_id_file` | 188 | Path to persist session ID across restarts |
| `self.http_client` | 192 | httpx client for OpenCode localhost API |
| `_handle_snapshot()` | 1384 | Sends `opencodeSessionId` back to control plane |
| `_handle_stop()` | 1375 | Calls `_request_opencode_stop()` — hits `POST /session/{id}/abort` |
| `_load_session_id()` | 1622 | Loads session ID from file, validates against OpenCode API |
| `_save_session_id()` | 1652 | Persists session ID to file |
| `_request_opencode_stop()` | 1659 | `POST /session/{id}/abort` on OpenCode |
| `_create_opencode_session()` | 664 | `POST /session` to create OpenCode session |
| `_transform_part_to_event()` | 697 | Translates OpenCode's part format → generic events |
| `ANTHROPIC_THINKING_BUDGETS` | 755 | Reasoning effort constants |
| `_build_prompt_request_body()` | 766 | Builds OpenCode-specific request body |
| `_parse_sse_stream()` | 828 | Parses SSE format from OpenCode |
| `_stream_opencode_response_sse()` | 868 | ~300 lines: SSE streaming, child sessions, compaction, dedup |
| `_fetch_final_message_state()` | 1283 | Fetches final text from OpenCode API after session.idle |
| `main()` | 1724 | CLI entry point with `--opencode-port` arg |

**Stays in bridge (generic SessionDO communication):**

| Method | Line | What it does |
|--------|------|-------------|
| `_connect_and_run()` | 319 | WebSocket connection to SessionDO with reconnection |
| `_handle_prompt()` | 590 | Git identity setup → calls adapter → sends events |
| `_send_event()` | 400 | Buffering, ACKs, retry logic to SessionDO |
| `_heartbeat_loop()` | 385 | Keep-alive pings |
| reconnection logic | 220, 277 | Exponential backoff, event buffer replay |
| `_handle_push()` | 1401 | Git push flow |
| `_configure_git_identity()` | 1573 | Set git user for commits |
| `_handle_shutdown()` | 1394 | Graceful shutdown (generic) |

**Why they must be separated** — `_handle_prompt()` (lines 590-660) is a sandwich:
```
Line 611: generic  — _configure_git_identity()
Line 618: specific — _create_opencode_session()
Line 623: specific — _stream_opencode_response_sse()
Line 629: generic  — _send_event()
```

After refactor:
```
Line 611: generic  — _configure_git_identity()
Line 618: generic  — self.adapter.create_session()
Line 623: generic  — self.adapter.send_prompt()
Line 629: generic  — _send_event()
```

---

### Minor: OpenCode naming leaks outside the sandbox

Not blockers. Not part of the refactor. Just awareness:

- **Control plane** has `opencode_session_id` as a column/field (`schema.ts` line 21, `types.ts` line 119, `client.ts` line 227). Pass-through string — never interpreted. Any agent can use it or leave it `null`.
- **Web UI** `tool-formatters.ts` assumes camelCase `filePath` because OpenCode uses camelCase. Has snake_case fallbacks.
- **Optional cleanup later:** rename `opencode_session_id` → `agent_session_id` (one DB migration + find-and-replace).

---

## The Event Contract

Source: `packages/control-plane/src/session/sandbox-events.ts`

This is what the SessionDO expects from the bridge. The adapter must emit events in this format:

```python
# Text streaming
{"type": "token", "content": "partial text...", "messageId": "msg_123"}

# Tool usage
{"type": "tool_call", "tool": "edit", "args": {...}, "callId": "call_1",
 "status": "running", "output": "", "messageId": "msg_123"}

# Tool finished
{"type": "tool_result", "messageId": "msg_123"}

# Reasoning step boundaries
{"type": "step_start", "messageId": "msg_123"}
{"type": "step_finish", "cost": 0.003, "tokens": {...}, "reason": "end_turn",
 "messageId": "msg_123"}

# Prompt finished (REQUIRED)
{"type": "execution_complete", "success": true, "messageId": "msg_123"}
{"type": "execution_complete", "success": false, "error": "...", "messageId": "msg_123"}

# Snapshot ready (includes agent session ID for restore)
# NOTE: must also add this to SandboxEvent union in packages/shared/src/types/index.ts
{"type": "snapshot_ready", "agentSessionId": "ses_abc123"}

# Optional
{"type": "artifact", "artifactType": "pr" | "screenshot", "url": "...", "metadata": {...}}
{"type": "git_sync", "status": "complete", "sha": "abc123"}
{"type": "push_complete", ...}
{"type": "push_error", ...}
```

**`execution_complete` is critical.** (`sandbox-events.ts` line 166) — triggers snapshot, next prompt in queue, message status update, callback notifications. Without it, the session hangs forever.

---

## The Adapter Interface

```python
# adapters/base.py
from abc import ABC, abstractmethod
from typing import AsyncIterator, Any
from pathlib import Path
import httpx

class AgentAdapter(ABC):
    """Implement this to plug any coding agent into Open-Inspect.
    
    This class gets instantiated in TWO separate processes:
    - Entrypoint process: calls install() and start()
    - Bridge subprocess: calls create_session(), send_prompt(), stop()
    See 'The Two-Process Problem' section for why.
    """

    # --- Entrypoint process methods (agent lifecycle) ---

    @abstractmethod
    async def install(self, workdir: Path) -> None:
        """One-time setup: tools, plugins, config files.
        Called after git clone, before first prompt."""

    @abstractmethod
    async def start(self, config: dict) -> None:
        """Launch the agent process. Block until healthy.
        config contains: provider, model, mcp_servers, etc."""

    @abstractmethod
    def get_process(self) -> "asyncio.subprocess.Process | None":
        """Return the agent's subprocess handle (for monitor_processes crash detection)."""

    @abstractmethod
    async def forward_logs(self) -> None:
        """Forward agent stdout to supervisor stdout."""

    # --- Bridge subprocess methods (agent communication) ---

    @abstractmethod
    def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
        """Called by bridge on boot. Gives adapter the shared http_client
        and the port the agent is listening on."""

    @abstractmethod
    async def create_session(self, repo_path: str) -> str:
        """Create a working session. Return a session ID."""

    @abstractmethod
    async def send_prompt(
        self,
        session_id: str,
        content: str,
        message_id: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Send a prompt, yield events in the standard format.
        
        MUST yield events matching the event contract above.
        MUST NOT yield execution_complete — the bridge handles that.
        """

    @abstractmethod
    async def stop(self, session_id: str) -> None:
        """Cancel current execution."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Is the agent process alive?"""

    @abstractmethod
    async def load_session_id(self) -> str | None:
        """Load persisted session ID (for snapshot restore). Return None if no session."""

    @abstractmethod
    async def save_session_id(self, session_id: str) -> None:
        """Persist session ID to disk (survives bridge restart)."""

    @abstractmethod
    def get_session_id_for_snapshot(self) -> str | None:
        """Return the current session ID for snapshot metadata.
        Sent to control plane in snapshot_ready event."""

    async def shutdown(self) -> None:
        """Clean up before sandbox exits. Optional."""
        pass
```

---

## New File Structure

```
packages/sandbox-runtime/src/sandbox_runtime/
  adapters/
    __init__.py
    base.py              ← the interface above
    opencode.py          ← all OpenCode-specific code extracted here
  bridge.py              ← generic only — calls self.adapter.*
  entrypoint.py          ← loads adapter by env var, passes to bridge
```

---

## Important: The Two-Process Problem

The bridge runs as a **separate subprocess** — not in the same Python process as the entrypoint. The entrypoint launches it with `python -m sandbox_runtime.bridge` (line 772). This means you can't pass an adapter object from the entrypoint to the bridge in memory. They're two different programs.

Why does the bridge run as a separate process? Because the bridge needs to crash and restart independently of the agent. If the WebSocket to the SessionDO drops, the bridge restarts. If OpenCode crashes, the entrypoint restarts it. They have separate crash/restart lifecycles, so they run as separate processes monitored by `monitor_processes()` (line 822).

This means the adapter gets instantiated **twice**, doing **different jobs** in each process:

```
Entrypoint process (manages the agent's lifecycle):
  adapter.install()         ← set up tools, config, plugins
  adapter.start()           ← launch the agent process
  adapter.get_process()     ← for crash detection in monitor_processes
  adapter.forward_logs()    ← pipe agent stdout to supervisor
  adapter.start()           ← restart on crash

Bridge subprocess (talks to the agent's API):
  adapter.configure()       ← receive http_client and port
  adapter.load_session_id() ← restore from previous session
  adapter.create_session()  ← POST to agent's localhost API
  adapter.send_prompt()     ← stream events from agent
  adapter.stop()            ← tell agent to cancel current work
  adapter.save_session_id() ← persist for snapshot restore
  adapter.get_session_id_for_snapshot() ← for snapshot_ready event
```

This is fine — both processes already read env vars independently (`AGENT_ADAPTER=opencode`), so each one imports and instantiates the adapter on its own. The lifecycle methods only get called in the entrypoint. The communication methods only get called in the bridge.

The bridge also owns its own `httpx.AsyncClient` (line 192) for talking to the agent on localhost. After the refactor, the bridge passes this to the adapter via `configure()` — the adapter doesn't create its own.

---

## Surgery Plan

### Step 1: Create the adapter interface

Create two new files. Nothing else changes.

```python
# NEW FILE: adapters/__init__.py
from .base import AgentAdapter

def load_adapter(name: str) -> AgentAdapter:
    if name == "opencode":
        from .opencode import OpenCodeAdapter
        return OpenCodeAdapter()
    raise ValueError(f"Unknown agent adapter: {name}")
```

```python
# NEW FILE: adapters/base.py
# (the AgentAdapter ABC shown in the interface section above)
```

- **Risk:** None. New files.
- **Test:** `from sandbox_runtime.adapters import load_adapter` works.

---

### Step 2: Extract OpenCode adapter

Create `adapters/opencode.py`. Move all OpenCode-specific code here.

**From entrypoint.py — these methods move entirely:**

```python
# BEFORE in entrypoint.py:
class SandboxSupervisor:
    OPENCODE_PORT = 4096                            # line 43
    self.opencode_process = None                     # line 57
    self.opencode_ready = asyncio.Event()            # line 64
    self.session_id_file = Path("/tmp/opencode-session-id")  # line 86

    def _install_tools(self, workdir):               # line 295 — copies into .opencode/tool/
    def _install_skills(self, workdir):              # line 353 — copies into .opencode/skills/
    def _setup_openai_oauth(self):                   # line 375 — writes auth.json
    def _build_mcp_config(self, mcp_servers):        # line 532 — OpenCode MCP format
    async def start_opencode(self):                  # line 646 — builds config, launches process
    async def _forward_opencode_logs(self):          # line 720 — pipes stdout
    async def _wait_for_health(self):                # line 731 — polls health endpoint

# AFTER in adapters/opencode.py:
class OpenCodeAdapter(AgentAdapter):
    PORT = 4096

    # --- Entrypoint methods ---

    async def install(self, workdir: Path) -> None:
        # _install_tools() code moves here (was line 295)
        # _install_skills() code moves here (was line 353)
        # codex-auth-plugin deployment moves here (was line 679)
        pass

    async def start(self, config: dict) -> None:
        # _setup_openai_oauth() code moves here (was line 375)
        # _build_mcp_config() moves here (was line 532)
        # opencode_config JSON building moves here (was line 654)
        # env var setup moves here (was lines 688, 694)
        self.process = await asyncio.create_subprocess_exec(
            "opencode", "serve", "--port", str(self.PORT),
            "--hostname", "0.0.0.0", "--print-logs",
            cwd=workdir, env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        await self._wait_for_health()  # (was line 731)

    def get_process(self):
        return self.process  # for monitor_processes crash detection

    async def forward_logs(self):
        # _forward_opencode_logs() moves here (was line 720)
        pass

    async def health_check(self) -> bool:
        # hits localhost:4096/global/health
        pass
```

**From bridge.py — these methods/classes move entirely:**

```python
# BEFORE in bridge.py:
class OpenCodeIdentifier:                    # line 43 — ascending ID generation

class AgentBridge:
    OPENCODE_REQUEST_TIMEOUT = 30.0          # line 137
    ANTHROPIC_THINKING_BUDGETS = {...}       # line 755
    ANTHROPIC_ADAPTIVE_THINKING_MODELS = ... # line 759
    ANTHROPIC_ADAPTIVE_EFFORTS = ...         # line 764

    def _build_prompt_request_body(self):    # line 766
    def _transform_part_to_event(self):      # line 697
    def _parse_sse_stream(self):             # line 828
    async def _create_opencode_session(self): # line 664
    async def _stream_opencode_response_sse(self): # line 868 (~300 lines)
    async def _fetch_final_message_state(self): # line 1283
    async def _load_session_id(self):        # line 1622
    async def _save_session_id(self):        # line 1652
    async def _request_opencode_stop(self):  # line 1659

# AFTER in adapters/opencode.py:
class OpenCodeAdapter(AgentAdapter):
    # OpenCodeIdentifier moves here
    # ANTHROPIC_THINKING_BUDGETS + constants move here
    # _build_prompt_request_body moves here
    # _transform_part_to_event moves here
    # _parse_sse_stream moves here
    # _fetch_final_message_state moves here

    # --- Bridge methods ---

    def configure(self, http_client, port):
        self.http_client = http_client
        self.base_url = f"http://localhost:{port}"

    async def create_session(self, repo_path: str) -> str:
        # _create_opencode_session() code (was line 664)
        resp = await self.http_client.post(f"{self.base_url}/session", json={})
        resp.raise_for_status()
        session_id = resp.json().get("id")
        await self.save_session_id(session_id)
        return session_id

    async def send_prompt(self, session_id, content, message_id, ...) -> AsyncIterator:
        # _stream_opencode_response_sse() code (was line 868, ~300 lines)
        # _transform_part_to_event() called internally
        # _fetch_final_message_state() called internally
        # yields generic events: {"type": "token", ...}, {"type": "tool_call", ...}
        pass

    async def stop(self, session_id: str) -> None:
        # _request_opencode_stop() code (was line 1659)
        await self.http_client.post(
            f"{self.base_url}/session/{session_id}/abort"
        )

    async def load_session_id(self) -> str | None:
        # _load_session_id() code (was line 1622)
        # reads from /tmp/opencode-session-id, validates against API
        pass

    async def save_session_id(self, session_id: str) -> None:
        # _save_session_id() code (was line 1652)
        pass

    def get_session_id_for_snapshot(self) -> str | None:
        return self._session_id  # sent in snapshot_ready event
```

- **Risk:** Medium. ~700 lines moving total. Must keep exact same behavior.
- **Test:** existing tests must pass:
  - `test_bridge_sse.py`
  - `test_bridge_message_tracking.py`
  - `test_codex_auth_plugin_setup.py`
  - `test_openai_oauth_setup.py`

---

### Step 3: Rewire bridge.py to use adapter

**Constructor:**
```python
# BEFORE (line 117):
class AgentBridge:
    def __init__(self, sandbox_id, session_id, control_plane_url, auth_token, opencode_port=4096):
        self.opencode_port = opencode_port
        self.opencode_base_url = f"http://localhost:{opencode_port}"
        self.opencode_session_id = None
        self.session_id_file = Path(tempfile.gettempdir()) / "opencode-session-id"
        self.http_client = None

# AFTER:
class AgentBridge:
    def __init__(self, sandbox_id, session_id, control_plane_url, auth_token, adapter: AgentAdapter):
        self.adapter = adapter
        self._session_id = None
        self.http_client = None  # still created here, passed to adapter via configure()
```

**Prompt handling (the sandwich fix):**
```python
# BEFORE (_handle_prompt, line 590):
async def _handle_prompt(self, cmd):
    await self._configure_git_identity(...)           # generic — stays

    if not self.opencode_session_id:
        await self._create_opencode_session()          # OpenCode — DELETE

    async for event in self._stream_opencode_response_sse(
        message_id, content, model, reasoning_effort   # OpenCode — DELETE
    ):
        if event.get("type") == "error":
            had_error = True
        await self._send_event(event)                  # generic — stays

    await self._send_event({"type": "execution_complete", ...})  # generic — stays

# AFTER:
async def _handle_prompt(self, cmd):
    await self._configure_git_identity(...)           # generic — stays

    if not self._session_id:
        self._session_id = await self.adapter.create_session(self.repo_path)

    async for event in self.adapter.send_prompt(
        self._session_id, content, message_id, model, reasoning_effort
    ):
        if event.get("type") == "error":
            had_error = True
        await self._send_event(event)                 # generic — stays

    await self._send_event({"type": "execution_complete", ...})  # generic — stays
```

**Stop handling:**
```python
# BEFORE (_handle_stop, line 1375):
async def _handle_stop(self):
    task = self._current_prompt_task
    if task and not task.done():
        task.cancel()
    await self._request_opencode_stop(reason="command")  # OpenCode — DELETE

# AFTER:
async def _handle_stop(self):
    task = self._current_prompt_task
    if task and not task.done():
        task.cancel()
    if self._session_id:
        await self.adapter.stop(self._session_id)        # generic
```

**Event validation (add to _send_event or _handle_prompt):**
```python
# NEW — validate adapter events before sending to SessionDO
REQUIRED_FIELDS = {
    "token": ["content", "messageId"],
    "tool_call": ["tool", "status", "messageId"],
    "tool_result": ["messageId"],
    "step_start": ["messageId"],
    "step_finish": ["messageId"],
}

def _validate_event(self, event: dict) -> None:
    event_type = event.get("type")
    required = REQUIRED_FIELDS.get(event_type)
    if required:
        missing = [f for f in required if f not in event]
        if missing:
            self.log.error("bridge.invalid_adapter_event",
                event_type=event_type, missing_fields=missing)
            raise ValueError(f"Adapter emitted {event_type} missing: {missing}")
```
Called in the prompt loop before `_send_event()`:
```python
async for event in self.adapter.send_prompt(...):
    self._validate_event(event)  # fail fast if adapter is wrong
    await self._send_event(event)
```

**Snapshot handling:**
```python
# BEFORE (_handle_snapshot, line 1384):
async def _handle_snapshot(self):
    await self._send_event({
        "type": "snapshot_ready",
        "opencodeSessionId": self.opencode_session_id,   # OpenCode — DELETE
    })

# AFTER:
async def _handle_snapshot(self):
    await self._send_event({
        "type": "snapshot_ready",
        "agentSessionId": self.adapter.get_session_id_for_snapshot(),  # generic
    })
```

**Session restore on boot:**
```python
# BEFORE (inside _connect_and_run, loads session from file):
await self._load_session_id()   # OpenCode — DELETE

# AFTER:
self._session_id = await self.adapter.load_session_id()  # generic
```

**CLI entry point:**
```python
# BEFORE (main, line 1724):
parser.add_argument("--opencode-port", type=int, default=4096)
bridge = AgentBridge(..., opencode_port=args.opencode_port)

# AFTER:
agent_name = os.environ.get("AGENT_ADAPTER", "opencode")
adapter = load_adapter(agent_name)
port = int(os.environ.get("AGENT_PORT", "4096"))
bridge = AgentBridge(..., adapter=adapter)
# bridge passes http_client to adapter after creating it:
adapter.configure(bridge.http_client, port)
```

**Delete from bridge.py:**
- `OpenCodeIdentifier` class (line 43)
- `OPENCODE_REQUEST_TIMEOUT` (line 137)
- `self.opencode_port`, `self.opencode_base_url`, `self.opencode_session_id` (lines 164-188)
- `_create_opencode_session()` (line 664)
- `_transform_part_to_event()` (line 697)
- `ANTHROPIC_THINKING_BUDGETS` + constants (lines 755-764)
- `_build_prompt_request_body()` (line 766)
- `_parse_sse_stream()` (line 828)
- `_stream_opencode_response_sse()` (line 868)
- `_fetch_final_message_state()` (line 1283)
- `_load_session_id()` (line 1622)
- `_save_session_id()` (line 1652)
- `_request_opencode_stop()` (line 1659)

- **Risk:** Medium. The sandwich refactor + stop/snapshot/restore fixes.
- **Test:** same tests, same results.

---

### Step 4: Rewire entrypoint.py to load adapter

**Boot sequence:**
```python
# BEFORE (line 1235):
# Phase 4: Start OpenCode server (in repo directory)
await self.start_opencode()
opencode_ready = True

# Phase 5: Start bridge (after OpenCode is ready)
await self.start_bridge()

# AFTER:
# Phase 4: Start agent via adapter
agent_name = os.environ.get("AGENT_ADAPTER", "opencode")
self.adapter = load_adapter(agent_name)
await self.adapter.install(workdir)
await self.adapter.start(self.session_config)
agent_ready = True

# Phase 5: Start bridge
await self.start_bridge()
```

**Bridge subprocess launch:**
```python
# BEFORE (start_bridge, line 772):
self.bridge_process = await asyncio.create_subprocess_exec(
    "python", "-m", "sandbox_runtime.bridge",
    "--sandbox-id", self.sandbox_id,
    "--opencode-port", str(self.OPENCODE_PORT),
    ...
)

# AFTER:
# Remove --opencode-port arg. Bridge reads AGENT_ADAPTER and AGENT_PORT from env.
self.bridge_process = await asyncio.create_subprocess_exec(
    "python", "-m", "sandbox_runtime.bridge",
    "--sandbox-id", self.sandbox_id,
    ...
    env={**os.environ, "AGENT_PORT": str(self.adapter.PORT)},
)
```

**Crash recovery:**
```python
# BEFORE (monitor_processes, line 831-863):
if self.opencode_process and self.opencode_process.returncode is not None:
    # ... logging, backoff ...
    self.opencode_ready.clear()
    await self.start_opencode()

# AFTER:
agent_process = self.adapter.get_process()
if agent_process and agent_process.returncode is not None:
    # ... logging, backoff ...
    await self.adapter.start(self.session_config)
```

**Shutdown:**
```python
# BEFORE (shutdown, line 1315):
if self.opencode_process and self.opencode_process.returncode is None:
    self.opencode_process.terminate()
    await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)

# AFTER:
await self.adapter.shutdown()
```

**Log forwarding:**
```python
# BEFORE: asyncio.create_task(self._forward_opencode_logs())
# AFTER:  asyncio.create_task(self.adapter.forward_logs())
```

**Delete from entrypoint.py:**
- `OPENCODE_PORT` (line 43)
- `self.opencode_process` (line 57)
- `self.opencode_ready` (line 64)
- `self.session_id_file` (line 86)
- `_install_tools()` (line 295)
- `_install_skills()` (line 353)
- `_setup_openai_oauth()` (line 375)
- `_build_mcp_config()` (line 532)
- `start_opencode()` (line 646)
- `_forward_opencode_logs()` (line 720)
- `_wait_for_health()` (line 731)

- **Risk:** Low. Boot sequence + crash recovery rewire.
- **Test:** sandbox boots, agent starts, prompt works end-to-end.

---

### Step 5: Fix TypeScript types + document the contract

**Add `snapshot_ready` to the SandboxEvent union** in `packages/shared/src/types/index.ts`:
```typescript
// Add to SandboxEvent union (after push_error):
  | {
      type: "snapshot_ready";
      agentSessionId?: string;
      sandboxId?: string;
      timestamp: number;
    }
```

**Create `docs/AGENT_ADAPTER.md`** — event contract table + interface spec. One doc a stranger reads to add an agent.

---

## What Stays Untouched

| Component | Why |
|-----------|-----|
| `sandbox-events.ts` | Handles events by `type` field, no agent references |
| Slack/GitHub/Linear bots | Talk to SessionDO, never to sandbox |
| D1 database | Session index, no agent info |
| WebSocket manager | Generic transport |
| SessionDO | Sees generic events only (`opencode_session_id` is a pass-through) |
| Web UI | Renders generic events (`tool-formatters.ts` has camelCase assumption but has fallbacks) |

---

## After The Refactor

OpenCode works exactly as before. Nothing changed from the user's perspective. The only difference is where the code lives:

```
Before: bridge.py has OpenCode code + SessionDO code tangled together
After:  bridge.py has SessionDO code, adapters/opencode.py has OpenCode code
```

Then when we're ready to swap agents:
1. Create `adapters/my_agent.py` — implement the interface methods
2. Set `AGENT_ADAPTER=my_agent`
3. Done
