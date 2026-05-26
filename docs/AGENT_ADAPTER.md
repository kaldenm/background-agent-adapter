# Agent Adapter Interface

This document describes how to add a new coding agent to Open-Inspect.

## Quick Start

1. Create `packages/sandbox-runtime/src/sandbox_runtime/adapters/my_agent.py`
2. Implement the `AgentAdapter` ABC
3. Register it in `adapters/__init__.py`
4. Set `AGENT_ADAPTER=my_agent` environment variable
5. Done — the bridge and supervisor will use your adapter

## Architecture

The adapter is instantiated in **two separate processes** that communicate with the agent
differently:

```
┌─────────────────────────────────────────────────────────┐
│  Supervisor Process (PID 1)                             │
│                                                         │
│  adapter.install()     ← set up tools, config, plugins  │
│  adapter.prepare()     ← prepare the agent (validate    │
│                          or launch, depends on agent)  │
│  adapter.get_process() ← for crash detection            │
│  adapter.shutdown()    ← terminate on exit              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Bridge Subprocess                                      │
│                                                         │
│  adapter.configure()              ← receive http_client │
│  adapter.load_session_id()        ← restore session     │
│  adapter.create_session()         ← start new session   │
│  adapter.send_prompt()            ← stream events       │
│  adapter.stop()                   ← cancel execution    │
│  adapter.get_session_id_for_snapshot() ← snapshot meta  │
└─────────────────────────────────────────────────────────┘
```

Both processes read `AGENT_ADAPTER` from the environment and instantiate the adapter independently.

> ⚠️ **The two instances share NO state.** Each process creates its own `TemplateAdapter()` object.
> If you set `self._model` in `install()` (supervisor process), the bridge instance's `self._model`
> is `None`. To pass data between processes, use the **filesystem** — write to a file in
> `install()`, read it in `configure()`. Both the Pi and OpenCode adapters use this pattern (e.g.,
> writing config files during install that the bridge reads later).

## Event Contract

Your adapter's `send_prompt()` method must yield events in this format:

| Event Type     | Required Fields               | Description                                                                                                                                                                                                   |
| -------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`        | `content`, `messageId`        | Streaming text. `content` must be **cumulative** (full text so far, not just the latest delta). Both built-in adapters follow this pattern.                                                                   |
| `tool_call`    | `tool`, `status`, `messageId` | Tool invocation                                                                                                                                                                                               |
| `tool_result`  | `messageId`                   | Tool completed. **Note:** Neither built-in adapter uses this — both use `tool_call` with `status: "completed"` instead. You can safely skip this event type.                                                  |
| `step_start`   | `messageId`                   | Reasoning step boundary                                                                                                                                                                                       |
| `step_finish`  | `messageId`                   | Step complete (optional: `cost`, `tokens`, `reason`)                                                                                                                                                          |
| `error`        | (not validated)               | Non-fatal error — bridge passes through without validation. Include `messageId` and `error` (string) for consistency with the other event types.                                                              |
| `agent_status` | `status`, `message`           | Optional lifecycle event. Not validated by the bridge — passes straight through to the web UI. Use it to show progress like "spawning", "ready", "prompting". Include `adapter` field to identify the source. |

**Important:** Do NOT emit `execution_complete` — the bridge handles that automatically after
`send_prompt()` returns.

### Error Handling

The error contract differs between lifecycle methods and `send_prompt()`:

**In `send_prompt()`** — catch errors, yield an error event, and return normally. Never let
`send_prompt()` raise an exception. The bridge wraps the call but relies on your adapter to produce
a clean error event for the web UI:

```python
async def send_prompt(self, session_id, content, message_id, **kwargs):
    try:
        async for event in self._stream_agent(content):
            yield translate(event)
    except (BrokenPipeError, OSError, ConnectionResetError) as e:
        yield {"type": "error", "error": f"Agent process died: {e}", "messageId": message_id}
    except TimeoutError:
        yield {"type": "error", "error": "Agent did not respond in time", "messageId": message_id}
```

**In lifecycle methods** (`install()`, `prepare()`, `configure()`) — raise exceptions. The
supervisor and bridge catch these at a higher level and handle restarts/retries:

```python
async def prepare(self, workdir, session_config):
    # ...
    if not self._process_healthy():
        raise RuntimeError("Agent failed to start within timeout")
```

In short: `send_prompt()` → yield error events. Everything else → raise.

### Example Events (from the Pi adapter)

```python
# Text streaming (content is CUMULATIVE, not just the delta)
yield {"type": "token", "content": "Hello", "messageId": message_id}
yield {"type": "token", "content": "Hello world", "messageId": message_id}
yield {"type": "token", "content": "Hello world!", "messageId": message_id}

# Tool invocation (status changes as tool progresses)
yield {"type": "tool_call", "tool": "edit", "args": {}, "callId": "call_1", "status": "running", "output": "", "messageId": message_id}
yield {"type": "tool_call", "tool": "edit", "args": {}, "callId": "call_1", "status": "completed", "output": "file written", "messageId": message_id}

# Step boundaries
yield {"type": "step_start", "messageId": message_id}
yield {
    "type": "step_finish",
    "messageId": message_id,
    "tokens": {"input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0},
    "cost": 0.003,
}

# Error (non-fatal)
yield {"type": "error", "error": "Pi process died: ...", "messageId": message_id}

# Lifecycle status (optional — helps the web UI show what's happening)
yield {"type": "agent_status", "status": "prompting", "message": "Sending prompt", "adapter": "my_agent"}
```

## Interface

```python
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
import asyncio
import httpx


class AgentAdapter(ABC):
    # --- Supervisor process methods ---

    @abstractmethod
    async def install(self, workdir: Path, session_config: dict) -> None:
        """One-time setup: tools, plugins, config files."""

    @abstractmethod
    async def prepare(self, workdir: Path, session_config: dict) -> None:
        """Prepare the agent. For HTTP agents: spawn the server.
        For subprocess agents: just validate the binary exists."""

    @abstractmethod
    def get_process(self) -> asyncio.subprocess.Process | None:
        """Return subprocess handle for crash detection."""

    @abstractmethod
    async def forward_logs(self) -> None:
        """Forward agent stdout to supervisor."""

    # --- Bridge subprocess methods ---

    @abstractmethod
    async def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
        """Receive shared http_client and agent port."""

    @abstractmethod
    async def create_session(self, repo_path: str) -> str:
        """Create a session. Return session ID."""

    @abstractmethod
    async def send_prompt(
        self, session_id: str, content: str, message_id: str,
        model: str | None = None, reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Send prompt, yield events. Do NOT yield execution_complete."""

    @abstractmethod
    async def stop(self, session_id: str) -> None:
        """Cancel current execution."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Is the agent responsive?"""

    @abstractmethod
    async def load_session_id(self) -> str | None:
        """Load persisted session ID for snapshot restore."""

    @abstractmethod
    async def save_session_id(self, session_id: str) -> None:
        """Persist session ID to disk."""

    @abstractmethod
    def get_session_id_for_snapshot(self) -> str | None:
        """Return session ID for snapshot metadata."""

    async def shutdown(self) -> None:
        """Clean up. Default implementation terminates the process."""
        process = self.get_process()
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=10.0)
            except TimeoutError:
                process.kill()
```

## Environment Variables

| Variable        | Default    | Description                                  |
| --------------- | ---------- | -------------------------------------------- |
| `AGENT_ADAPTER` | `opencode` | Which adapter to load                        |
| `AGENT_PORT`    | `4096`     | Port the agent listens on (passed to bridge) |

### Setting `AGENT_ADAPTER` in Production

The `AGENT_ADAPTER` env var is read by the supervisor inside the sandbox. How you set it depends on
your sandbox provider:

- **Daytona**: Set in the sandbox provider config
  (`packages/server/src/sandbox/providers/daytona-provider.ts`). The server injects it as an env var
  when creating the sandbox. Currently hardcoded to `"pi"` — change it to your adapter name.

- **Modal**: The Modal sandbox manager (`packages/modal-infra/src/sandbox/manager.py`) builds the
  sandbox env vars from the server config. `AGENT_ADAPTER` is not set explicitly, so it defaults to
  `"opencode"`. To change it, either:
  1. Add `"AGENT_ADAPTER": "my_agent"` to the `env_vars` dict in `manager.py`, or
  2. Set it as a [Modal Secret](https://modal.com/docs/guide/secrets) that gets injected into the
     sandbox environment.

The supervisor reads it at startup:

```python
# supervisor.py
agent_name = os.environ.get("AGENT_ADAPTER", "opencode")
adapter = load_adapter(agent_name)
```

The supervisor also forwards `AGENT_ADAPTER` to the bridge subprocess, so both processes get the
same value automatically.

## Registration

Add your adapter to `adapters/__init__.py`:

```python
def load_adapter(name: str) -> AgentAdapter:
    if name == "opencode":
        from .opencode import OpenCodeAdapter
        return OpenCodeAdapter()
    if name == "my_agent":
        from .my_agent import MyAgentAdapter
        return MyAgentAdapter()
    raise ValueError(f"Unknown agent adapter: {name}")
```

## Testing Your Adapter

The sandbox-runtime uses **pytest** with **pytest-asyncio**. Tests live in
`packages/sandbox-runtime/tests/`.

### Running tests

```bash
cd packages/sandbox-runtime

# Install dev dependencies
pip install -e '.[dev]'

# Run all tests
pytest

# Run just your adapter's tests
pytest tests/test_my_agent.py -v
```

### Start from the test template

Copy the test template and rename it for your adapter:

```bash
cp tests/test_adapter_template.py tests/test_my_agent.py
```

The template gives you 22 tests covering all 13 adapter methods plus event contract validation.
Tests for unimplemented methods are marked `pytest.skip("TODO: ...")` — they'll show up as skipped
until you fill them in. The event contract tests pass immediately, catching common mistakes like
missing `messageId`, emitting deltas instead of cumulative text, or accidentally yielding
`execution_complete`.

### What to test

See `tests/test_pi_adapter.py` for a thorough example (~550 lines). The key areas:

1. **Registry** — `load_adapter("my_agent")` returns your adapter class
2. **install() / prepare()** — mock the subprocess calls, verify config files are written
3. **Event translation** — unit-test your `_convert_*` methods with raw agent events → expected
   bridge events
4. **send_prompt() integration** — mock the agent's I/O, push events through a queue, verify the
   full event stream including `agent_status` lifecycle events
5. **Session persistence** — `save_session_id()` → `load_session_id()` round-trip
6. **shutdown()** — graceful termination, already-dead process, no process

### Testing tips

- `conftest.py` provides a `MockResponse` class for HTTP mocking
- Use `asyncio.Queue` to simulate agent event streams (see `test_read_agent_events_until_agent_end`)
- Use `MagicMock` for subprocess handles — set `returncode = None` for alive, `returncode = 1` for
  dead
- The bridge validates events against `REQUIRED_EVENT_FIELDS` in `bridge.py` — your tests should
  verify your events pass that validation

There's no way to run the full bridge→agent loop locally without a WebSocket server. For end-to-end
testing, deploy to a sandbox and send a prompt through the web UI.

## Reference Implementations

| Adapter      | Communication Model             | Lines | How it works                                                                |
| ------------ | ------------------------------- | ----- | --------------------------------------------------------------------------- |
| **OpenCode** | HTTP server on localhost        | 1,243 | Bridge makes HTTP requests, reads SSE streams. Agent runs independently.    |
| **Pi**       | Subprocess (stdin/stdout pipes) | 846   | Bridge spawns the agent in `configure()`, writes JSONL in, reads JSONL out. |

For Pi-specific details beyond the adapter interface, see [PI_ADAPTER.md](./PI_ADAPTER.md).

## session_config

The `session_config` dict passed to `install()` and `prepare()` contains:

```python
{
    "session_id": "ses_abc123",
    "provider": "anthropic",           # LLM provider
    "model": "claude-sonnet-4-6",      # Model ID
    "branch": "main",                  # Git branch
    "mcp_servers": [                   # MCP server configs
        {"name": "...", "type": "local", "command": [...]},
        {"name": "...", "type": "remote", "url": "..."},
    ],
}
```
