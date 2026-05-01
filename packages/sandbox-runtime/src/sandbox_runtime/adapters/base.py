"""Base adapter interface for pluggable coding agents.

Any coding agent that wants to work inside the Open-Inspect sandbox must
implement this ABC. The adapter is instantiated in TWO separate processes:

- **Entrypoint process** — calls install(), start(), get_process(), forward_logs(), shutdown()
- **Bridge subprocess** — calls configure(), create_session(), send_prompt(), stop(),
  health_check(), load_session_id(), save_session_id(), get_session_id_for_snapshot()

See the spec for details on the two-process architecture.
"""

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx


class AgentAdapter(ABC):
    """Implement this to plug any coding agent into Open-Inspect.

    This class gets instantiated in TWO separate processes:
    - Entrypoint process: calls install() and start()
    - Bridge subprocess: calls create_session(), send_prompt(), stop()
    """

    # --- Entrypoint process methods (agent lifecycle) ---

    @abstractmethod
    async def install(self, workdir: Path, session_config: dict) -> None:
        """One-time setup: tools, plugins, config files.

        Called after git clone, before the agent process starts.

        Args:
            workdir: The working directory (repo root).
            session_config: Session configuration dict (provider, model, mcp_servers, etc.)
        """

    @abstractmethod
    async def start(self, workdir: Path, session_config: dict) -> None:
        """Launch the agent process. Block until healthy.

        Args:
            workdir: The working directory (repo root).
            session_config: Contains provider, model, mcp_servers, etc.
        """

    @abstractmethod
    def get_process(self) -> "asyncio.subprocess.Process | None":
        """Return the agent's subprocess handle (for crash detection in monitor_processes)."""

    @abstractmethod
    async def forward_logs(self) -> None:
        """Forward agent stdout/stderr to supervisor stdout. Runs as a long-lived task."""

    # --- Bridge subprocess methods (agent communication) ---

    @abstractmethod
    def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
        """Called by bridge on boot. Gives adapter the shared http_client
        and the port the agent is listening on.

        Args:
            http_client: Shared httpx client for localhost communication.
            port: The port the agent is listening on.
        """

    @abstractmethod
    async def create_session(self, repo_path: str) -> str:
        """Create a working session. Return a session ID.

        Args:
            repo_path: Path to the repository.

        Returns:
            A session ID string.
        """

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

        MUST yield events matching the event contract:
        - {"type": "token", "content": "...", "messageId": "..."}
        - {"type": "tool_call", "tool": "...", "args": {...}, ...}
        - {"type": "step_start", "messageId": "..."}
        - {"type": "step_finish", ...}
        - {"type": "error", "error": "...", "messageId": "..."}

        MUST NOT yield execution_complete — the bridge handles that.

        Args:
            session_id: The agent session ID.
            content: The prompt text.
            message_id: Control plane message ID (used in events sent back).
            model: Optional model override.
            reasoning_effort: Optional reasoning effort level.

        Yields:
            Event dicts in the standard format.
        """

    @abstractmethod
    async def stop(self, session_id: str) -> None:
        """Cancel current execution.

        Args:
            session_id: The agent session ID to stop.
        """

    @abstractmethod
    async def health_check(self) -> bool:
        """Is the agent process alive and healthy?

        Returns:
            True if the agent is responsive.
        """

    @abstractmethod
    async def load_session_id(self) -> str | None:
        """Load persisted session ID (for snapshot restore).

        Returns:
            The session ID string, or None if no session persisted.
        """

    @abstractmethod
    async def save_session_id(self, session_id: str) -> None:
        """Persist session ID to disk (survives bridge restart).

        Args:
            session_id: The session ID to persist.
        """

    @abstractmethod
    def get_session_id_for_snapshot(self) -> str | None:
        """Return the current session ID for snapshot metadata.

        Sent to control plane in the snapshot_ready event.
        """

    async def shutdown(self) -> None:
        """Clean up before sandbox exits. Optional override."""
        process = self.get_process()
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=10.0)
            except TimeoutError:
                process.kill()
