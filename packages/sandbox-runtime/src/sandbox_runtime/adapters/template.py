"""Adapter template — copy this file to create a new agent adapter.

Rename to `my_agent.py`, implement each method, then register it in
`__init__.py` by adding an `if name == "my_agent"` branch to `load_adapter()`.

Full guide: docs/AGENT_ADAPTER.md

Quick start:
    1. cp template.py my_agent.py
    2. Implement the methods below (search for TODO)
    3. Register in __init__.py
    4. Set AGENT_ADAPTER=my_agent
    5. Redeploy the sandbox image
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from .base import AgentAdapter

if TYPE_CHECKING:
    import asyncio
    from collections.abc import AsyncIterator

    import httpx


class TemplateAdapter(AgentAdapter):
    """Adapter for [your agent name here].

    Decide your communication model:
    - **Server agent** (like OpenCode): your agent runs an HTTP server, the
      bridge talks to it via HTTP requests and reads SSE streams.
    - **Subprocess agent** (like Pi): the bridge spawns your agent as a child
      process and communicates via stdin/stdout pipes.

    This choice affects how you implement configure() and send_prompt().
    """

    # TODO: Set a port if your agent runs an HTTP server, or 0 for subprocess agents.
    PORT = 0

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._workdir: Path | None = None
        # TODO: Add any state your adapter needs (session IDs, queues, etc.)

    # ─────────────────────────────────────────────────────────────────────
    # Supervisor process methods
    #
    # These run in the supervisor (PID 1 inside the sandbox). They handle
    # agent installation and lifecycle. The supervisor calls them in order:
    #   install() → prepare() → [agent runs] → shutdown()
    # ─────────────────────────────────────────────────────────────────────

    async def install(self, workdir: Path, session_config: dict[str, Any]) -> None:
        """One-time setup after git clone, before the agent starts.

        Typical work:
        - Write config files your agent needs (e.g., .my-agent/config.json)
        - Install plugins or extensions
        - Set up API keys from session_config

        Args:
            workdir: Repo root inside the sandbox.
            session_config: Dict with keys like "provider", "model", "mcp_servers".
        """
        # TODO: Write any config files your agent needs.
        raise NotImplementedError

    async def prepare(self, workdir: Path, session_config: dict[str, Any]) -> None:
        """Start the agent or verify it's ready for the bridge to connect.

        Server agents: Spawn the server process here, wait until it's healthy.
        Subprocess agents: Just validate the binary exists (spawning happens
        in configure() where the bridge sets up pipes).

        Args:
            workdir: Repo root inside the sandbox.
            session_config: Dict with keys like "provider", "model", "mcp_servers".
        """
        # TODO: Start your agent or validate its binary.
        raise NotImplementedError

    def get_process(self) -> asyncio.subprocess.Process | None:
        """Return the subprocess handle for crash detection.

        The supervisor's monitor_processes() loop checks this to detect crashes.
        Return None if your agent isn't a subprocess (e.g., external service).
        """
        # TODO: Return self._process or whatever holds your agent's process.
        return self._process

    async def forward_logs(self) -> None:
        """Forward agent stdout/stderr to the supervisor's stdout.

        This runs as a long-lived asyncio task. For subprocess agents, read
        from the process's stderr and print each line. For server agents,
        tail the agent's log file.
        """
        # TODO: Pipe your agent's logs to stdout.
        # Example for subprocess agents:
        #   async for line in self._process.stderr:
        #       print(f"[my-agent] {line.decode().rstrip()}")
        raise NotImplementedError

    # ─────────────────────────────────────────────────────────────────────
    # Bridge subprocess methods
    #
    # These run in the bridge (a SEPARATE process from the supervisor).
    # The bridge handles WebSocket streaming back to the session server.
    # It calls these methods to talk to your agent:
    #   configure() → create_session() → send_prompt() (repeated) → stop()
    #
    # ⚠️  STATE IS NOT SHARED between supervisor and bridge methods.
    #    This is a different process — a fresh TemplateAdapter() instance.
    #    Anything you set on `self` in install()/prepare() is invisible here.
    #    To pass data across, use the filesystem (write a file in install(),
    #    read it in configure()).
    # ─────────────────────────────────────────────────────────────────────

    async def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
        """Establish communication with the agent.

        Server agents: Store the http_client, pointed at localhost:{port}.
        Subprocess agents: Spawn the process here, set up stdin/stdout pipes.

        After this returns, the bridge will call create_session().

        Args:
            http_client: Shared httpx client (pre-configured for localhost).
            port: Port the agent listens on (0 for subprocess agents).
        """
        # TODO: Set up your communication channel.
        raise NotImplementedError

    async def create_session(self, repo_path: str) -> str:
        """Create a new agent session and return its ID.

        Only called when there's no session to resume (load_session_id()
        returned None). The bridge handles resume-vs-create logic.

        Args:
            repo_path: Path to the cloned repository.

        Returns:
            A session ID string (your agent's concept of a session/conversation).
        """
        # TODO: Create a session with your agent, return the ID.
        raise NotImplementedError

    async def send_prompt(
        self,
        session_id: str,
        content: str,
        message_id: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Send a prompt to the agent, yield events in the standard format.

        This is the core method. Your agent emits its own event types — your
        job is to translate them into the standard event types the bridge expects:

            {"type": "token",       "content": "...",  "messageId": message_id}
            {"type": "tool_call",   "tool": "...",     "args": {...},
             "callId": "...",       "status": "running|completed|error",
             "output": "...",       "messageId": message_id}
            {"type": "step_start",  "messageId": message_id}
            {"type": "step_finish", "messageId": message_id,
             "tokens": {"input": 0, "output": 0}, "cost": 0.0}
            {"type": "error",       "error": "...",    "messageId": message_id}

        IMPORTANT:
        - Do NOT yield {"type": "execution_complete"} — the bridge adds that.
        - token content should be CUMULATIVE (the full text so far), not deltas,
          because the web UI deduplicates by messageId and keeps the latest.

        Args:
            session_id: The agent session ID from create_session().
            content: The user's prompt text.
            message_id: Control plane message ID (pass through in all events).
            model: Optional model override (e.g., "anthropic/claude-sonnet-4-20250514").
            reasoning_effort: Optional reasoning effort level.

        Yields:
            Event dicts in the standard format.
        """
        # TODO: Send the prompt to your agent, translate its events, and yield them.
        #
        # Example skeleton:
        #
        #   yield {"type": "step_start", "messageId": message_id}
        #
        #   cumulative_text = ""
        #   async for agent_event in self._read_my_agent_events():
        #       if agent_event["type"] == "text":
        #           cumulative_text += agent_event["delta"]
        #           yield {"type": "token", "content": cumulative_text, "messageId": message_id}
        #       elif agent_event["type"] == "tool_use":
        #           yield {
        #               "type": "tool_call",
        #               "tool": agent_event["name"],
        #               "args": agent_event["input"],
        #               "callId": agent_event["id"],
        #               "status": "running",
        #               "output": "",
        #               "messageId": message_id,
        #           }
        #       elif agent_event["type"] == "done":
        #           yield {"type": "step_finish", "messageId": message_id,
        #                  "tokens": {"input": 0, "output": 0}, "cost": 0.0}
        #           return
        #       elif agent_event["type"] == "error":
        #           yield {"type": "error", "error": str(agent_event["detail"]),
        #                  "messageId": message_id}
        #           return
        #
        raise NotImplementedError
        # Make this an async generator:
        yield  # Ensures Python treats this as AsyncIterator.

    async def stop(self, session_id: str) -> None:
        """Cancel current execution.

        Tell your agent to abort whatever it's doing. For HTTP agents, send
        a cancel request. For subprocess agents, send a signal or write a
        cancel command to stdin.

        Args:
            session_id: The agent session ID.
        """
        # TODO: Cancel the current prompt execution.
        raise NotImplementedError

    async def health_check(self) -> bool:
        """Check if the agent is alive and responsive.

        The bridge calls this periodically. Return True if healthy.
        """
        # TODO: Ping your agent (HTTP health endpoint, process.returncode, etc.)
        raise NotImplementedError

    # ─────────────────────────────────────────────────────────────────────
    # Session persistence (for snapshot save/restore)
    #
    # When a sandbox is snapshotted and later restored, the bridge needs
    # to resume the agent session instead of creating a new one.
    # ─────────────────────────────────────────────────────────────────────

    SESSION_ID_FILE = Path("/tmp/my-agent-session-id")

    async def load_session_id(self) -> str | None:
        """Load session ID from disk (called on bridge startup for snapshot restore)."""
        # TODO: Read your persisted session ID, or return None.
        try:
            return self.SESSION_ID_FILE.read_text().strip() or None
        except FileNotFoundError:
            return None

    async def save_session_id(self, session_id: str) -> None:
        """Persist session ID to disk (survives bridge restarts and snapshots)."""
        # TODO: Write the session ID to a known path.
        self.SESSION_ID_FILE.write_text(session_id)

    def get_session_id_for_snapshot(self) -> str | None:
        """Return current session ID for snapshot metadata."""
        # TODO: Return whatever session ID your agent is currently using.
        try:
            return self.SESSION_ID_FILE.read_text().strip() or None
        except FileNotFoundError:
            return None
