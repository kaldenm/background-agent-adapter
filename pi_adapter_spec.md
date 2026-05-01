# Spec: Pi Adapter for Open-Inspect

## Context

The pluggable adapter refactoring is complete. OpenCode is extracted into `adapters/opencode.py`.
The bridge and entrypoint call generic `self.adapter.*` methods. To swap in Pi, we create
`adapters/pi.py` and set `AGENT_ADAPTER=pi`.

This spec covers the architectural decisions specific to Pi that differ from OpenCode.

---

## Architecture Decision 1: Bridge Owns Pi Process

### Why

OpenCode is an HTTP server — any process can connect to it. The entrypoint spawns it, the bridge
connects to it. They're independent.

Pi in RPC mode uses stdin/stdout pipes. Only the process that spawns Pi can talk to it. Therefore
the **bridge must spawn Pi**, because the bridge is the process that communicates with it.

### How the adapter interface maps for Pi vs OpenCode

| Method           | OpenCode (entrypoint)                         | Pi (entrypoint)                                                                           |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `install()`      | Copy tools, skills, plugins into `.opencode/` | Write `.pi/settings.json`, validate `pi` binary exists                                    |
| `start()`        | Spawn `opencode serve`, wait for health       | Lightweight setup only — validate install, store config. Pi gets spawned later by bridge. |
| `get_process()`  | Returns OpenCode subprocess handle            | Returns `None` (no process in entrypoint)                                                 |
| `forward_logs()` | Pipes OpenCode stdout to supervisor           | No-op. Bridge handles Pi's stderr.                                                        |

| Method              | OpenCode (bridge)                                 | Pi (bridge)                                                                                                            |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `configure()`       | Store http_client and port, set base_url          | **Spawn Pi subprocess** (`pi --mode rpc`). Ignore http_client/port params.                                             |
| `create_session()`  | `POST /session` to OpenCode API                   | Send `{"type": "get_state"}` to stdin. If no session, send `{"type": "new_session"}`. Return session ID from response. |
| `send_prompt()`     | Connect SSE, POST prompt, parse events            | Write `{"type": "prompt", "message": ...}` to stdin. Read stdout line by line. Translate Pi events → bridge events.    |
| `stop()`            | `POST /session/{id}/abort`                        | Write `{"type": "abort"}` to stdin.                                                                                    |
| `health_check()`    | `GET /global/health`                              | Check `self._process.returncode is None` (process alive).                                                              |
| `load_session_id()` | Read `/tmp/opencode-session-id`, validate via API | Read stored session file path. If file exists, return path as session ID.                                              |
| `save_session_id()` | Write session ID to file                          | Store session file path to a known location.                                                                           |
| `shutdown()`        | Terminate OpenCode process                        | Terminate Pi subprocess (from bridge context).                                                                         |

### Crash Recovery

| Scenario       | What Happens                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi crashes     | Bridge detects (stdout EOF / `_process.returncode` set). Bridge respawns Pi. Sends `{"type": "switch_session", "sessionPath": "..."}` to restore. WebSocket to control plane stays alive. |
| Bridge crashes | Pi dies (child process, pipes break). Entrypoint detects bridge death, restarts bridge. New bridge spawns new Pi in `configure()`. Pi reloads session from JSONL file on disk.            |

### What the entrypoint monitors

With OpenCode, the entrypoint monitors both processes:

```
monitor_processes():
    if opencode_process.returncode is not None → restart
    if bridge_process.returncode is not None → restart
```

With Pi, the entrypoint only monitors the bridge:

```
monitor_processes():
    if adapter.get_process() → None, skip (no agent process to monitor)
    if bridge_process.returncode is not None → restart bridge
        → new bridge spawns new Pi automatically
```

---

## Architecture Decision 2: Extension UI — Auto-Approve (MVP)

### The problem

Pi extensions can ask questions mid-execution ("Allow this command?", "Pick an option"). In RPC mode
these come out as `extension_ui_request` on stdout. If nothing responds, Pi freezes.

### Decision: Auto-approve everything

The sandbox is already isolated. Trust the agent. Auto-approve all dialog requests immediately so Pi
never blocks.

Future: pipe requests through WebSocket to the web client, show a modal to the user, pipe the answer
back. Full interactivity. But that's not MVP.

### Policy (MVP)

- `confirm` → `true` (auto-approve — sandbox is the guardrail)
- `select` → first option
- `input` / `editor` → cancel (can't auto-generate meaningful text)
- Fire-and-forget methods (`notify`, `setStatus`, etc.) → ignore, no response needed

---

## Implementation Steps (with testing)

### Step 1: Skeleton + Registry

Create `adapters/pi.py` with the class skeleton. Register in `adapters/__init__.py`.

```python
# adapters/pi.py
class PiAdapter(AgentAdapter):
    # Timeouts (seconds)
    HEALTH_CHECK_TIMEOUT = 2.0        # Fast failure detection for crash recovery
    INACTIVITY_TIMEOUT = 120.0        # No events for 2 min = hung process
    GRACEFUL_SHUTDOWN_TIMEOUT = 5.0   # Time to wait for clean exit before SIGTERM
    FORCE_KILL_TIMEOUT = 5.0          # Time to wait after SIGTERM before SIGKILL
    STARTUP_TIMEOUT = 30.0            # Max time for Pi to become ready after spawn
    COMMAND_RESPONSE_TIMEOUT = 10.0   # Max wait for a response to get_state, new_session, etc.

    # Process limits
    MAX_RESPAWN_ATTEMPTS = 3          # Prevent infinite restart loops

    # Session persistence
    SESSION_PATH_FILE = Path("/tmp/pi-session-path")

    def __init__(self):
        self._process = None
        self._workdir = None
        self._provider = "anthropic"
        self._model = "claude-sonnet-4-6"
        self._session_id = None
        self._session_config = None
        self._stdin_lock = None       # asyncio.Lock — prevents concurrent stdin writes
        self._event_queue = None      # asyncio.Queue — stdout reader pushes here
        self._respawn_count = 0       # Track respawn attempts

    # All abstract methods stubbed with NotImplementedError
```

```python
# adapters/__init__.py — add to load_adapter()
if name == "pi":
    from .pi import PiAdapter
    return PiAdapter()
```

**Test:**

```python
def test_load_pi_adapter():
    from sandbox_runtime.adapters import load_adapter
    adapter = load_adapter("pi")
    assert adapter is not None
    assert isinstance(adapter, PiAdapter)
```

---

### Step 2: install() and start()

`install()` writes Pi config files. `start()` validates the binary and stores config.

```python
async def install(self, workdir: Path, session_config: dict) -> None:
    """Write Pi configuration files."""
    pi_dir = workdir / ".pi"
    pi_dir.mkdir(parents=True, exist_ok=True)

    self._workdir = workdir
    self._provider = session_config.get("provider", "anthropic")
    self._model = session_config.get("model", "claude-sonnet-4-6")

    settings = {
        "provider": self._provider,
        "model": self._model,
    }
    (pi_dir / "settings.json").write_text(json.dumps(settings))

async def start(self, workdir: Path, session_config: dict) -> None:
    """Validate Pi is installed. Actual spawn happens in configure() (bridge)."""
    self._workdir = workdir
    self._session_config = session_config

    # Validate binary exists
    result = await asyncio.create_subprocess_exec(
        "pi", "--version",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await result.communicate()
    if result.returncode != 0:
        raise RuntimeError("Pi binary not found or not working")

def get_process(self):
    return self._process  # None in entrypoint, set in bridge

async def forward_logs(self):
    pass  # Bridge handles Pi's stderr
```

**Test:**

```python
async def test_install_writes_config(tmp_path):
    adapter = PiAdapter()
    await adapter.install(tmp_path, {"provider": "anthropic", "model": "claude-sonnet-4-6"})

    config_file = tmp_path / ".pi" / "settings.json"
    assert config_file.exists()
    config = json.loads(config_file.read_text())
    assert config["provider"] == "anthropic"
    assert config["model"] == "claude-sonnet-4-6"

async def test_start_validates_binary(tmp_path):
    adapter = PiAdapter()
    # Should not raise if pi is installed
    await adapter.start(tmp_path, {"provider": "anthropic"})
    # get_process() returns None (no process spawned in entrypoint)
    assert adapter.get_process() is None
```

---

### Step 3: configure() — Spawn Pi

This runs in the bridge. Spawns Pi as a subprocess, sets up stdout/stderr readers.

```python
async def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
    """Spawn Pi subprocess. http_client and port are ignored (Pi uses pipes)."""

    cmd = ["pi", "--mode", "rpc", "--provider", self._provider, "--model", self._model]

    # Use existing session if restoring
    if self._session_file and self._session_file.exists():
        cmd.extend(["--session-dir", str(self._session_dir)])
    else:
        cmd.append("--no-session")

    self._process = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=self._workdir,
    )

    # Stdin lock — prevents concurrent writes from corrupting the JSONL stream
    # (e.g., send_prompt() and stop() called at the same time)
    self._stdin_lock = asyncio.Lock()

    # Event queue — stdout reader pushes here, send_prompt() reads from here
    self._event_queue: asyncio.Queue = asyncio.Queue()

    asyncio.create_task(self._read_stdout())
    asyncio.create_task(self._forward_stderr())

async def _read_stdout(self):
    """Read JSONL from Pi's stdout, push to event queue."""
    reader = self._process.stdout
    buffer = ""
    async for chunk in reader:
        buffer += chunk.decode()
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if line:
                event = json.loads(line)
                await self._event_queue.put(event)

async def _forward_stderr(self):
    """Forward Pi's stderr to supervisor stdout (logs)."""
    async for line in self._process.stderr:
        print(f"[pi] {line.decode().rstrip()}")
```

**Test:**

```python
async def test_configure_spawns_pi(tmp_path):
    adapter = PiAdapter()
    adapter._workdir = tmp_path
    adapter._provider = "anthropic"
    adapter._model = "claude-sonnet-4-6"

    await adapter.configure(http_client=None, port=0)

    assert adapter._process is not None
    assert adapter._process.returncode is None  # still running
    assert adapter.get_process() is not None

    # Cleanup
    adapter._process.terminate()
    await adapter._process.wait()

async def test_health_check_when_running(tmp_path):
    adapter = PiAdapter()
    adapter._workdir = tmp_path
    await adapter.configure(http_client=None, port=0)

    assert await adapter.health_check() is True

    adapter._process.terminate()
    await adapter._process.wait()

    assert await adapter.health_check() is False
```

---

### Step 3b: create_session() — Get Real Session File Path

After Pi spawns, query it for the actual session file path. This is what gets saved for snapshot
restore.

```python
async def create_session(self, repo_path: str) -> str:
    """Create or discover Pi session. Returns the session file path as the ID."""

    # If Pi isn't spawned yet (first call), configure() should have handled it.
    # Query Pi for current state to get session file path.
    request_id = f"req-{uuid.uuid4().hex[:8]}"
    await self._write_stdin({"type": "get_state", "id": request_id})

    # Wait for response with matching ID
    state = await self._wait_for_response(request_id)
    session_file = state.get("data", {}).get("sessionFile")

    if not session_file:
        # No session yet — create one
        request_id = f"req-{uuid.uuid4().hex[:8]}"
        await self._write_stdin({"type": "new_session", "id": request_id})
        await self._wait_for_response(request_id)

        # Query state again to get the file path
        request_id = f"req-{uuid.uuid4().hex[:8]}"
        await self._write_stdin({"type": "get_state", "id": request_id})
        state = await self._wait_for_response(request_id)
        session_file = state.get("data", {}).get("sessionFile")

    self._session_id = session_file or str(uuid.uuid4())
    await self.save_session_id(self._session_id)
    return self._session_id

async def _wait_for_response(self, request_id: str, timeout: float = None) -> dict:
    timeout = timeout or self.COMMAND_RESPONSE_TIMEOUT
    """Read from event queue until we get a response matching our request ID."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"No response for request {request_id}")

        event = await asyncio.wait_for(self._event_queue.get(), timeout=remaining)

        # Match response by ID
        if event.get("type") == "response" and event.get("id") == request_id:
            return event

        # Non-response events go back in the queue (or buffer them)
        # In practice, responses come back immediately before any streaming events
```

**Test:**

```python
async def test_create_session_gets_file_path(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process
    adapter._stdin_lock = asyncio.Lock()
    adapter._event_queue = asyncio.Queue()

    # Simulate Pi responding with session state
    await adapter._event_queue.put({
        "type": "response",
        "id": "req-abc",  # will need to match
        "command": "get_state",
        "success": True,
        "data": {"sessionFile": "/home/user/.pi/sessions/project/abc123.jsonl"}
    })

    session_id = await adapter.create_session("/workspace/repo")
    assert session_id == "/home/user/.pi/sessions/project/abc123.jsonl"
```

---

### Step 4: send_prompt() — Event Translation

The core: write prompt to stdin, read Pi events from queue, translate to bridge format.

```python
async def send_prompt(self, session_id, content, message_id, model=None, reasoning_effort=None):
    """Write prompt to stdin, yield translated events from stdout.

    Handles errors gracefully — if Pi crashes or pipes break mid-stream,
    yields an error event so the bridge can send execution_complete with
    success=False to the control plane.
    """
    try:
        # Optionally switch model
        if model:
            provider, model_id = (model.split("/", 1) + [model])[:2]
            await self._write_stdin({"type": "set_model", "provider": provider, "modelId": model_id})

        # Optionally set thinking level
        if reasoning_effort:
            level_map = {"low": "low", "medium": "medium", "high": "high", "max": "xhigh"}
            level = level_map.get(reasoning_effort, "medium")
            await self._write_stdin({"type": "set_thinking_level", "level": level})

        # Send the prompt
        await self._write_stdin({"type": "prompt", "message": content})

    except (BrokenPipeError, OSError, ConnectionResetError) as e:
        # Pi process died before we could send the prompt
        yield {"type": "error", "error": f"Pi process died: {e}", "messageId": message_id}
        return

    # Read events until agent_end
    try:
        while True:
            event = await asyncio.wait_for(
                self._event_queue.get(),
                timeout=self.INACTIVITY_TIMEOUT,
            )
            event_type = event.get("type")

            # Pi crashed (internal signal from _read_stdout)
            if event_type == "_pi_crashed":
                yield {"type": "error", "error": "Pi process crashed mid-execution", "messageId": message_id}
                return

            # Extension UI — auto-approve
            if event_type == "extension_ui_request":
                await self._handle_extension_ui(event)
                continue

            # Response confirmations — internal, skip
            if event_type == "response":
                continue

            # Agent done — stop reading
            if event_type == "agent_end":
                return

            # Translate and yield
            bridge_event = self._translate_event(event, message_id)
            if bridge_event:
                yield bridge_event

    except TimeoutError:
        yield {"type": "error", "error": f"Pi unresponsive for {self.INACTIVITY_TIMEOUT}s", "messageId": message_id}
    except (BrokenPipeError, OSError, ConnectionResetError) as e:
        yield {"type": "error", "error": f"Pi connection lost: {e}", "messageId": message_id}

def _translate_event(self, event: dict, message_id: str) -> dict | None:
    """Translate a Pi event to a bridge event."""
    event_type = event.get("type")

    if event_type == "message_update":
        delta = event.get("assistantMessageEvent", {})
        delta_type = delta.get("type")

        if delta_type == "text_delta":
            return {"type": "token", "content": delta.get("delta", ""), "messageId": message_id}
        elif delta_type == "error":
            return {"type": "error", "error": delta.get("reason", "Unknown error"), "messageId": message_id}
        # thinking_delta — drop
        return None

    elif event_type == "tool_execution_start":
        return {
            "type": "tool_call",
            "tool": event.get("toolName", ""),
            "args": event.get("args", {}),
            "callId": event.get("toolCallId", ""),
            "status": "running",
            "output": "",
            "messageId": message_id,
        }

    elif event_type == "tool_execution_end":
        result = event.get("result", {})
        content_parts = result.get("content", [])
        output = "\n".join(p.get("text", "") for p in content_parts if p.get("type") == "text")
        return {
            "type": "tool_call",
            "tool": event.get("toolName", ""),
            "args": {},
            "callId": event.get("toolCallId", ""),
            "status": "completed",
            "output": output,
            "messageId": message_id,
        }

    elif event_type == "turn_start":
        return {"type": "step_start", "messageId": message_id}

    elif event_type == "turn_end":
        msg = event.get("message", {})
        usage = msg.get("usage", {})
        cost_info = usage.get("cost", {})
        return {
            "type": "step_finish",
            "messageId": message_id,
            "tokens": {
                "input": usage.get("input", 0),
                "output": usage.get("output", 0),
            },
            "cost": cost_info.get("total", 0),
        }

    return None

async def _write_stdin(self, cmd: dict) -> None:
    """Write a JSON command to Pi's stdin. Lock prevents interleaved writes."""
    async with self._stdin_lock:
        line = json.dumps(cmd) + "\n"
        self._process.stdin.write(line.encode())
        await self._process.stdin.drain()
```

**Test:**

```python
async def test_translate_text_delta():
    adapter = PiAdapter()
    pi_event = {
        "type": "message_update",
        "message": {},
        "assistantMessageEvent": {"type": "text_delta", "delta": "Hello", "contentIndex": 0}
    }
    result = adapter._translate_event(pi_event, "msg_123")
    assert result == {"type": "token", "content": "Hello", "messageId": "msg_123"}

async def test_translate_tool_start():
    adapter = PiAdapter()
    pi_event = {
        "type": "tool_execution_start",
        "toolCallId": "call_1",
        "toolName": "bash",
        "args": {"command": "ls"}
    }
    result = adapter._translate_event(pi_event, "msg_123")
    assert result["type"] == "tool_call"
    assert result["tool"] == "bash"
    assert result["status"] == "running"
    assert result["callId"] == "call_1"

async def test_translate_tool_end():
    adapter = PiAdapter()
    pi_event = {
        "type": "tool_execution_end",
        "toolCallId": "call_1",
        "toolName": "bash",
        "result": {"content": [{"type": "text", "text": "file1.py\nfile2.py"}]},
        "isError": False
    }
    result = adapter._translate_event(pi_event, "msg_123")
    assert result["type"] == "tool_call"
    assert result["status"] == "completed"
    assert result["output"] == "file1.py\nfile2.py"

async def test_translate_thinking_dropped():
    adapter = PiAdapter()
    pi_event = {
        "type": "message_update",
        "message": {},
        "assistantMessageEvent": {"type": "thinking_delta", "delta": "Let me think..."}
    }
    result = adapter._translate_event(pi_event, "msg_123")
    assert result is None

async def test_translate_turn_boundaries():
    adapter = PiAdapter()

    start = adapter._translate_event({"type": "turn_start"}, "msg_123")
    assert start == {"type": "step_start", "messageId": "msg_123"}

    end_event = {
        "type": "turn_end",
        "message": {"usage": {"input": 100, "output": 50, "cost": {"total": 0.003}}}
    }
    end = adapter._translate_event(end_event, "msg_123")
    assert end["type"] == "step_finish"
    assert end["cost"] == 0.003
```

---

### Step 5: stop(), health_check(), session persistence

```python
async def stop(self, session_id: str) -> None:
    """Send abort command to Pi. Silently ignores if Pi is already dead."""
    try:
        await self._write_stdin({"type": "abort"})
    except (BrokenPipeError, OSError):
        pass  # Pi already dead — nothing to abort

async def health_check(self) -> bool:
    """Check if Pi is alive AND responsive (not just process alive)."""
    if not self._process or self._process.returncode is not None:
        return False

    try:
        # Actually ask Pi if it can respond — catches hung processes
        request_id = f"health-{uuid.uuid4().hex[:8]}"
        await self._write_stdin({"type": "get_state", "id": request_id})
        response = await asyncio.wait_for(
            self._wait_for_response(request_id),
            timeout=self.HEALTH_CHECK_TIMEOUT,
        )
        return response.get("success", False)
    except (TimeoutError, Exception):
        return False

SESSION_PATH_FILE = Path("/tmp/pi-session-path")

async def load_session_id(self) -> str | None:
    if not self.SESSION_PATH_FILE.exists():
        return None
    path = self.SESSION_PATH_FILE.read_text().strip()
    if Path(path).exists():
        return path
    return None

async def save_session_id(self, session_id: str) -> None:
    """session_id is the path to Pi's JSONL session file."""
    try:
        self.SESSION_PATH_FILE.write_text(session_id)
    except (OSError, PermissionError) as e:
        self.log.error("pi.save_session_error", exc=e)
        # Non-fatal — session still works, just won't survive snapshot restore

def get_session_id_for_snapshot(self) -> str | None:
    """Return session file path for snapshot metadata."""
    return self._session_id

async def shutdown(self) -> None:
    """Gracefully shut down Pi process. Close all pipes explicitly."""
    proc = self._process
    if not proc or proc.returncode is not None:
        return

    # Close stdin first — signals Pi that no more input is coming
    if proc.stdin and not proc.stdin.is_closing():
        proc.stdin.close()

    # Wait for Pi to exit gracefully
    try:
        await asyncio.wait_for(proc.wait(), timeout=self.GRACEFUL_SHUTDOWN_TIMEOUT)
    except TimeoutError:
        # Didn't exit cleanly — send SIGTERM
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=self.FORCE_KILL_TIMEOUT)
        except TimeoutError:
            # Still alive — force kill
            proc.kill()
            await proc.wait()

    # Close remaining pipes to prevent file descriptor leaks
    if proc.stdout and not proc.stdout.at_eof():
        proc.stdout.feed_eof()
    if proc.stderr and not proc.stderr.at_eof():
        proc.stderr.feed_eof()

    self._process = None
```

**Test:**

```python
async def test_shutdown_closes_pipes(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process

    await adapter.shutdown()

    assert adapter._process is None
    assert mock_pi_process.stdin.is_closing()

async def test_shutdown_force_kills_hung_process():
    adapter = PiAdapter()
    # Mock a process that ignores SIGTERM
    adapter._process = MagicMock(returncode=None)
    adapter._process.wait = AsyncMock(side_effect=TimeoutError)
    adapter._process.kill = MagicMock()

    await adapter.shutdown()

    adapter._process.kill.assert_called_once()
```

**Test:**

```python
async def test_stop_sends_abort(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process
    await adapter.stop("session_123")

    written = mock_pi_process.stdin.getvalue()
    cmd = json.loads(written.strip())
    assert cmd["type"] == "abort"

async def test_health_check_no_process():
    adapter = PiAdapter()
    adapter._process = None
    assert await adapter.health_check() is False

async def test_health_check_dead_process():
    adapter = PiAdapter()
    adapter._process = MagicMock(returncode=1)
    assert await adapter.health_check() is False

async def test_health_check_responsive(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process  # returncode=None (alive)
    adapter._stdin_lock = asyncio.Lock()
    adapter._event_queue = asyncio.Queue()

    # Simulate Pi responding to get_state
    await adapter._event_queue.put({
        "type": "response", "id": "health-abc",
        "command": "get_state", "success": True
    })

    assert await adapter.health_check() is True

async def test_health_check_hung_process(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process  # alive but won't respond
    adapter._stdin_lock = asyncio.Lock()
    adapter._event_queue = asyncio.Queue()  # empty — no response comes

    # Times out after 2s → returns False
    assert await adapter.health_check() is False

async def test_session_persistence(tmp_path, monkeypatch):
    adapter = PiAdapter()
    monkeypatch.setattr(adapter, "SESSION_PATH_FILE", tmp_path / "session-path")

    # Nothing persisted yet
    assert await adapter.load_session_id() is None

    # Save a session path
    session_file = tmp_path / "session.jsonl"
    session_file.write_text("{}")  # fake session file
    await adapter.save_session_id(str(session_file))

    # Load it back
    loaded = await adapter.load_session_id()
    assert loaded == str(session_file)

    # File doesn't exist → returns None
    session_file.unlink()
    assert await adapter.load_session_id() is None
```

---

### Step 6: Extension UI auto-approve

```python
async def _handle_extension_ui(self, request: dict) -> None:
    """Auto-approve all extension UI requests.

    Sandbox is isolated — trust the agent, never block.
    Future: pipe to user via WebSocket for full interactivity.
    """
    method = request.get("method")
    req_id = request.get("id")

    # Fire-and-forget methods — no response needed
    if method in ("notify", "setStatus", "setWidget", "setTitle", "set_editor_text"):
        return

    # Dialog methods — must respond or Pi hangs
    if method == "confirm":
        response = {"type": "extension_ui_response", "id": req_id, "confirmed": True}
    elif method == "select":
        options = request.get("options", [])
        value = options[0] if options else None
        response = {"type": "extension_ui_response", "id": req_id, "value": value}
    else:  # input, editor — can't auto-generate meaningful text
        response = {"type": "extension_ui_response", "id": req_id, "cancelled": True}

    await self._write_stdin(response)
```

**Test:**

```python
async def test_extension_ui_confirm_auto_approves(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process

    adapter._handle_extension_ui({
        "type": "extension_ui_request",
        "id": "uuid-1",
        "method": "confirm",
        "title": "Delete all files?"
    })

    written = mock_pi_process.stdin.getvalue()
    response = json.loads(written.strip())
    assert response["confirmed"] is True
    assert response["id"] == "uuid-1"

async def test_extension_ui_select_picks_first(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process

    adapter._handle_extension_ui({
        "type": "extension_ui_request",
        "id": "uuid-2",
        "method": "select",
        "options": ["Allow", "Block", "Skip"]
    })

    written = mock_pi_process.stdin.getvalue()
    response = json.loads(written.strip())
    assert response["value"] == "Allow"

async def test_extension_ui_input_cancels(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process

    adapter._handle_extension_ui({
        "type": "extension_ui_request",
        "id": "uuid-3",
        "method": "input",
        "title": "Enter a value"
    })

    written = mock_pi_process.stdin.getvalue()
    response = json.loads(written.strip())
    assert response["cancelled"] is True

async def test_extension_ui_notify_ignored(mock_pi_process):
    adapter = PiAdapter()
    adapter._process = mock_pi_process

    adapter._handle_extension_ui({
        "type": "extension_ui_request",
        "id": "uuid-4",
        "method": "notify",
        "message": "Something happened"
    })

    # Nothing written to stdin — fire-and-forget
    assert mock_pi_process.stdin.getvalue() == b""
```

---

### Step 7: Crash recovery

```python
async def _respawn_pi(self) -> None:
    """Respawn Pi after a crash. Reload session from disk."""
    self.log.warn("pi.crash_detected, respawning")

    # Re-run configure to spawn fresh Pi
    await self.configure(http_client=None, port=0)

    # Restore session if we have one
    session_path = await self.load_session_id()
    if session_path:
        self._write_stdin({"type": "switch_session", "sessionPath": session_path})
        # Wait for response confirming session loaded
        response = await asyncio.wait_for(self._event_queue.get(), timeout=10.0)
        if response.get("success"):
            self.log.info("pi.session_restored", session_path=session_path)
```

Detection happens in `_read_stdout()`:

```python
async def _read_stdout(self):
    """Read JSONL from Pi's stdout, push to event queue."""
    try:
        async for chunk in self._process.stdout:
            # ... parse and queue events ...
            pass
    except Exception:
        pass

    # If we get here, stdout closed = Pi died
    if self._process.returncode is not None:
        await self._event_queue.put({"type": "_pi_crashed", "returncode": self._process.returncode})
```

And in `send_prompt()`:

```python
# Inside the event loop
event = await asyncio.wait_for(self._event_queue.get(), timeout=120.0)

if event.get("type") == "_pi_crashed":
    await self._respawn_pi()
    # Re-send the prompt
    self._write_stdin({"type": "prompt", "message": content})
    continue
```

**Test:**

```python
async def test_crash_detection_and_respawn(tmp_path):
    adapter = PiAdapter()
    adapter._workdir = tmp_path
    await adapter.configure(http_client=None, port=0)

    # Kill Pi
    adapter._process.kill()
    await adapter._process.wait()

    # Stdout reader should push _pi_crashed event
    event = await asyncio.wait_for(adapter._event_queue.get(), timeout=5.0)
    assert event["type"] == "_pi_crashed"

    # Respawn
    await adapter._respawn_pi()
    assert adapter._process.returncode is None  # alive again
```

---

### Step 8: Register adapter

```python
# adapters/__init__.py
def load_adapter(name: str) -> AgentAdapter:
    if name == "opencode":
        from .opencode import OpenCodeAdapter
        return OpenCodeAdapter()
    if name == "pi":
        from .pi import PiAdapter
        return PiAdapter()
    raise ValueError(f"Unknown agent adapter: {name}")
```

**Test:**

```python
def test_load_adapter_pi():
    adapter = load_adapter("pi")
    assert isinstance(adapter, PiAdapter)

def test_load_adapter_unknown():
    with pytest.raises(ValueError, match="Unknown agent adapter"):
        load_adapter("nonexistent")
```

---

### Step 9: Docker image

Add Pi binary installation to `packages/modal-infra/src/images/base.py`:

```python
# Alongside or instead of OpenCode installation:
"npm install -g @anthropic-ai/pi@latest",
```

**Test:**

```bash
# In sandbox container:
pi --version  # should print version without error
```

---

### Step 10: End-to-end

Full flow: entrypoint boots → bridge starts → Pi spawns → prompt sent → events stream back →
execution_complete reaches control plane.

**Test:**

```python
async def test_full_prompt_flow(tmp_path):
    """Integration test: send prompt, get events back."""
    adapter = PiAdapter()
    await adapter.install(tmp_path, {"provider": "anthropic", "model": "claude-sonnet-4-6"})
    await adapter.start(tmp_path, {"provider": "anthropic", "model": "claude-sonnet-4-6"})
    await adapter.configure(http_client=None, port=0)

    session_id = await adapter.create_session(str(tmp_path))
    assert session_id is not None

    events = []
    async for event in adapter.send_prompt(session_id, "Say hello", "msg_001"):
        events.append(event)

    # Should have at least one token event
    token_events = [e for e in events if e["type"] == "token"]
    assert len(token_events) > 0
    assert all(e["messageId"] == "msg_001" for e in token_events)

    # Should have step boundaries
    assert any(e["type"] == "step_start" for e in events)
    assert any(e["type"] == "step_finish" for e in events)

    await adapter.shutdown()
```

---

## Environment Variables

| Variable            | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `AGENT_ADAPTER=pi`  | Tells adapter registry to load PiAdapter      |
| `ANTHROPIC_API_KEY` | Pi reads this directly for Anthropic provider |

`AGENT_PORT` is ignored by Pi adapter (no HTTP server).

---

## What Does NOT Change

- Bridge's WebSocket logic to SessionDO — unchanged
- Bridge's event validation (`_validate_event`) — unchanged
- Bridge's `_send_event()` buffering and ACK logic — unchanged
- Bridge's git push/identity handling — unchanged
- Entrypoint's git sync, hooks, code-server, ttyd — unchanged
- Control plane, web UI, bots — unchanged (they see the same event types)

---

## Deployment Steps (What It Actually Takes to Ship)

The spec above covers the adapter code. These are the additional steps required to actually get Pi
running in production sandboxes.

### 1. Rebuild the Daytona Base Snapshot

The sandbox image needs the `pi` binary. Edit `packages/daytona-infra/src/toolchain.py`:

```python
PI_VERSION = "latest"
# In run_commands:
f"npm install -g @mariozechner/pi-coding-agent@{PI_VERSION}",
```

Then rebuild:

```bash
cd packages/daytona-infra
source .venv/bin/activate  # create if needed: python3 -m venv .venv && pip install daytona-sdk
export $(grep -v '^#' .env | xargs)

# Must delete first — Daytona won't overwrite existing snapshots
python -c "
from daytona_sdk import Daytona, DaytonaConfig
client = Daytona(DaytonaConfig(api_key='$DAYTONA_API_KEY', api_url='$DAYTONA_API_URL'))
result = client.snapshot.list()
snap = next((s for s in result.items if s.name == '$DAYTONA_BASE_SNAPSHOT'), None)
if snap:
    client.snapshot.delete(snap)
    print(f'Deleted {snap.name}')
"

# Rebuild (~3-5 min)
python -m src.bootstrap
```

**Gotchas:**

- SDK package is `daytona-sdk`, imports as `from daytona_sdk import ...` (not `daytona`)
- `snapshot.delete()` takes a snapshot object, not a string name
- Snapshot name is in `.env` as `DAYTONA_BASE_SNAPSHOT` (currently `open-inspect-base-v3`)

### 2. Set AGENT_ADAPTER=pi in Sandbox Env Vars

Edit `packages/control-plane/src/sandbox/providers/daytona-provider.ts` in `buildEnvVars()`:

```typescript
Object.assign(envVars, {
  // ... existing vars ...
  AGENT_ADAPTER: "pi",
});
```

### 3. Update Entrypoint to Dispatch by Adapter Type

The entrypoint's `start_opencode()` hardcodes OpenCode. Add early return for other adapters:

```python
async def start_opencode(self) -> None:
    from .adapters.opencode import OpenCodeAdapter
    if not isinstance(self.adapter, OpenCodeAdapter):
        workdir = self.workspace_path
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            workdir = self.repo_path
        await self.adapter.install(workdir, self.session_config)
        await self.adapter.start(workdir, self.session_config)
        self.agent_ready.set()
        return
    # ... existing OpenCode code ...
```

Also update `monitor_processes()`: use `adapter.get_process()` which returns `None` for Pi (bridge
owns the process), so agent crash monitoring is skipped.

### 4. Add agent_status Event Type (Observability)

In `packages/shared/src/types/index.ts`, add to `SandboxEvent` union:

```typescript
| {
    type: "agent_status";
    status: string;
    message?: string;
    adapter?: string;
    sandboxId?: string;
    timestamp: number;
  }
```

The control plane's catch-all handler persists + broadcasts these automatically.

### 5. Build and Deploy

```bash
# Build shared types (control plane depends on them)
npm run build -w @open-inspect/shared

# Deploy control plane via Terraform
cd terraform/environments/production
terraform apply
```

New sandboxes immediately use Pi. Existing sandboxes keep OpenCode until recycled.

### 6. Verify

Create a new session in the web UI. Watch `wrangler tail` for:

```
"event_type":"agent_status"  → Pi lifecycle events
"event_type":"step_start"    → LLM turn started
"event_type":"step_finish"   → LLM turn done
"event_type":"execution_complete" → Prompt finished
```

Sandbox stderr (prefixed `[pi]`) shows Pi's own debug output.
