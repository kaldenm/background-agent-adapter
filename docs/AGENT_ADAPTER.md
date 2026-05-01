# Agent Adapter Interface

This document describes how to add a new coding agent to Open-Inspect.

## Quick Start

1. Create `packages/sandbox-runtime/src/sandbox_runtime/adapters/my_agent.py`
2. Implement the `AgentAdapter` ABC
3. Register it in `adapters/__init__.py`
4. Set `AGENT_ADAPTER=my_agent` environment variable
5. Done — the bridge and entrypoint will use your adapter

## Architecture

The adapter is instantiated in **two separate processes** that communicate with the agent differently:

```
┌─────────────────────────────────────────────────────────┐
│  Entrypoint Process (PID 1)                             │
│                                                         │
│  adapter.install()     ← set up tools, config, plugins  │
│  adapter.start()       ← launch the agent process       │
│  adapter.get_process() ← for crash detection            │
│  adapter.forward_logs()← pipe stdout to supervisor      │
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
│  adapter.save_session_id()        ← persist for restore │
│  adapter.get_session_id_for_snapshot() ← snapshot meta  │
└─────────────────────────────────────────────────────────┘
```

Both processes read `AGENT_ADAPTER` from the environment and instantiate the adapter independently.

## Event Contract

Your adapter's `send_prompt()` method must yield events in this format:

| Event Type | Required Fields | Description |
|-----------|----------------|-------------|
| `token` | `content`, `messageId` | Streaming text chunk |
| `tool_call` | `tool`, `args`, `callId`, `status`, `output`, `messageId` | Tool invocation |
| `tool_result` | `messageId` | Tool completed |
| `step_start` | `messageId` | Reasoning step boundary |
| `step_finish` | `messageId` | Step complete (optional: `cost`, `tokens`, `reason`) |
| `error` | `error`, `messageId` | Non-fatal error |

**Important:** Do NOT emit `execution_complete` — the bridge handles that automatically after `send_prompt()` returns.

### Example Events

```python
# Text streaming
yield {"type": "token", "content": "Hello, ", "messageId": msg_id}
yield {"type": "token", "content": "Hello, world!", "messageId": msg_id}

# Tool usage
yield {
    "type": "tool_call",
    "tool": "edit",
    "args": {"file": "main.py", "content": "..."},
    "callId": "call_1",
    "status": "running",
    "output": "",
    "messageId": msg_id,
}

# Step boundaries
yield {"type": "step_start", "messageId": msg_id}
yield {"type": "step_finish", "cost": 0.003, "tokens": {"input": 100, "output": 50}, "reason": "end_turn", "messageId": msg_id}

# Error (non-fatal, adapter can continue or return)
yield {"type": "error", "error": "Rate limited, retrying...", "messageId": msg_id}
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
    # --- Entrypoint process methods ---

    @abstractmethod
    async def install(self, workdir: Path, session_config: dict) -> None:
        """One-time setup: tools, plugins, config files."""

    @abstractmethod
    async def start(self, workdir: Path, session_config: dict) -> None:
        """Launch the agent process. Block until healthy."""

    @abstractmethod
    def get_process(self) -> asyncio.subprocess.Process | None:
        """Return subprocess handle for crash detection."""

    @abstractmethod
    async def forward_logs(self) -> None:
        """Forward agent stdout to supervisor."""

    # --- Bridge subprocess methods ---

    @abstractmethod
    def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
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

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ADAPTER` | `opencode` | Which adapter to load |
| `AGENT_PORT` | `4096` | Port the agent listens on (passed to bridge) |

## Registration

Add your adapter to `adapters/__init__.py`:

```python
def load_adapter(name: str) -> AgentAdapter:
    if name == "opencode":
        from .opencode import OpenCodeAdapter
        return OpenCodeAdapter()
    elif name == "my_agent":
        from .my_agent import MyAgentAdapter
        return MyAgentAdapter()
    raise ValueError(f"Unknown agent adapter: {name}")
```

## session_config

The `session_config` dict passed to `install()` and `start()` contains:

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
