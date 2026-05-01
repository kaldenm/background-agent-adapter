"""
Agent bridge - bidirectional communication between sandbox and control plane.

This module handles:
- WebSocket connection to control plane Durable Object
- Heartbeat loop for connection health
- Event forwarding from agent adapter to control plane
- Command handling from control plane (prompt, stop, snapshot)
- Git identity configuration per prompt author
"""

import argparse
import asyncio
import contextlib
import json
import os
import re
import secrets
import subprocess
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, ClassVar

import httpx
import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .adapters import AgentAdapter, load_adapter
from .adapters.opencode import OpenCodeAdapter, OpenCodeIdentifier  # noqa: F401 — backward compat
from .log_config import configure_logging, get_logger
from .types import GitUser

configure_logging()

# Fallback git identity when prompt author has no SCM name/email configured.
# Matches the co-author trailer used in generateCommitMessage (shared/git.ts).
FALLBACK_GIT_USER = GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")


class SessionTerminatedError(Exception):
    """Raised when the control plane has terminated the session (HTTP 410).

    This is a non-recoverable error - the bridge should exit gracefully
    rather than retry. The session can be restored via user action (sending
    a new prompt), which will trigger snapshot restoration on the control plane.
    """

    pass


# Event validation: ensure adapter events have required fields
REQUIRED_EVENT_FIELDS: dict[str, list[str]] = {
    "token": ["content", "messageId"],
    "tool_call": ["tool", "status", "messageId"],
    "tool_result": ["messageId"],
    "step_start": ["messageId"],
    "step_finish": ["messageId"],
}


class AgentBridge:
    """
    Bridge between sandbox agent instance and control plane.

    Handles:
    - WebSocket connection management with reconnection
    - Heartbeat for connection health
    - Event streaming from agent adapter to control plane
    - Command handling (prompt, stop, snapshot, shutdown)
    - Git identity management per prompt author
    """

    HEARTBEAT_INTERVAL = 30.0
    RECONNECT_BACKOFF_BASE = 2.0
    RECONNECT_MAX_DELAY = 60.0
    HTTP_CONNECT_TIMEOUT = 30.0
    HTTP_DEFAULT_TIMEOUT = 30.0
    GIT_PUSH_TIMEOUT_SECONDS = 300.0
    GIT_PUSH_TERMINATE_GRACE_SECONDS = 5.0
    PROMPT_MAX_DURATION = 5400.0
    GIT_CONFIG_TIMEOUT_SECONDS = 10.0
    MAX_EVENT_BUFFER_SIZE = 1000
    CRITICAL_EVENT_TYPES: ClassVar[set[str]] = {
        "execution_complete",
        "error",
        "snapshot_ready",
        "push_complete",
        "push_error",
    }

    def __init__(
        self,
        sandbox_id: str,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        adapter: AgentAdapter | None = None,
        opencode_port: int = 4096,
    ):
        self.sandbox_id = sandbox_id
        self.session_id = session_id
        self.control_plane_url = control_plane_url
        self.auth_token = auth_token

        # If no adapter provided, default to OpenCode for backward compat
        if adapter is None:
            adapter = OpenCodeAdapter()
        self.adapter = adapter

        # Backward compat: expose opencode_port
        self.opencode_port = opencode_port
        self.opencode_base_url = f"http://localhost:{opencode_port}"

        # Logger
        self.log = get_logger(
            "bridge",
            service="sandbox",
            sandbox_id=sandbox_id,
            session_id=session_id,
        )

        self.ws: ClientConnection | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()

        # Session state
        self._session_id: str | None = None
        self.repo_path = Path("/workspace")

        # Backward compat: session_id_file
        self.session_id_file = self.adapter._session_id_file if isinstance(self.adapter, OpenCodeAdapter) else None

        # HTTP client for agent API
        self.http_client: httpx.AsyncClient | None = None

        # Track the current prompt task so _handle_stop can cancel it
        self._current_prompt_task: asyncio.Task[None] | None = None

        # Event buffer: survives WS reconnection, flushed on reconnect
        self._event_buffer: list[dict[str, Any]] = []

        # Pending ACKs: events sent but not yet acknowledged by the control plane.
        # Keyed by ackId, re-sent on reconnect until the DO confirms receipt.
        self._pending_acks: dict[str, dict[str, Any]] = {}

    # ─────────────────────────────────────────────────────────────────────
    # Backward compatibility properties/methods
    # Tests and existing code may still access these directly.
    # ───────────────���───────────────────────────────────────────────────���─

    @property
    def opencode_session_id(self) -> str | None:
        """Backward compat: delegates to adapter._session_id."""
        return self._session_id

    @opencode_session_id.setter
    def opencode_session_id(self, value: str | None) -> None:
        """Backward compat: sets both bridge._session_id and adapter._session_id."""
        self._session_id = value
        if isinstance(self.adapter, OpenCodeAdapter):
            self.adapter._session_id = value

    def _sync_adapter_http_client(self) -> None:
        """Ensure adapter has access to the bridge's http_client."""
        if isinstance(self.adapter, OpenCodeAdapter) and self.http_client:
            if self.adapter.http_client is not self.http_client:
                self.adapter.http_client = self.http_client
                self.adapter.base_url = self.opencode_base_url

    @property
    def sse_inactivity_timeout(self) -> float:
        """Backward compat: delegates to adapter."""
        if isinstance(self.adapter, OpenCodeAdapter):
            return self.adapter._sse_inactivity_timeout
        return 120.0

    @sse_inactivity_timeout.setter
    def sse_inactivity_timeout(self, value: float) -> None:
        """Backward compat: sets adapter timeout."""
        if isinstance(self.adapter, OpenCodeAdapter):
            self.adapter._sse_inactivity_timeout = value

    def _transform_part_to_event(self, part: dict[str, Any], message_id: str) -> dict[str, Any] | None:
        """Backward compat: delegates to adapter."""
        if isinstance(self.adapter, OpenCodeAdapter):
            return self.adapter._transform_part_to_event(part, message_id)
        return None

    def _build_prompt_request_body(
        self,
        content: str,
        model: str | None,
        opencode_message_id: str | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        """Backward compat: delegates to adapter."""
        if isinstance(self.adapter, OpenCodeAdapter):
            return self.adapter._build_prompt_request_body(
                content, model, opencode_message_id, reasoning_effort
            )
        return {"parts": [{"type": "text", "text": content}]}

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
        timeout_ctx: asyncio.Timeout | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Backward compat: delegates to adapter."""
        if isinstance(self.adapter, OpenCodeAdapter):
            async for event in self.adapter._parse_sse_stream(response, timeout_ctx):
                yield event

    async def _stream_opencode_response_sse(
        self,
        message_id: str,
        content: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Backward compat: delegates to adapter.send_prompt()."""
        self._sync_adapter_http_client()
        if isinstance(self.adapter, OpenCodeAdapter):
            # Sync PROMPT_MAX_DURATION in case test overrides it on bridge
            if hasattr(self, 'PROMPT_MAX_DURATION'):
                self.adapter.PROMPT_MAX_DURATION = self.PROMPT_MAX_DURATION
            async for event in self.adapter.send_prompt(
                self._session_id or "", content, message_id, model, reasoning_effort
            ):
                yield event

    async def _fetch_final_message_state(
        self,
        message_id: str,
        opencode_message_id: str,
        cumulative_text: dict[str, str],
        tracked_msg_ids: set[str] | None = None,
        compaction_occurred: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        """Backward compat: delegates to adapter."""
        self._sync_adapter_http_client()
        if isinstance(self.adapter, OpenCodeAdapter):
            async for event in self.adapter._fetch_final_message_state(
                message_id, opencode_message_id, cumulative_text, tracked_msg_ids, compaction_occurred
            ):
                yield event

    @staticmethod
    def _extract_error_message(error: object) -> str | None:
        """Backward compat: delegates to OpenCodeAdapter._extract_error_message."""
        return OpenCodeAdapter._extract_error_message(error)

    async def _create_opencode_session(self) -> None:
        """Backward compat: delegates to adapter.create_session()."""
        self._sync_adapter_http_client()
        self._session_id = await self.adapter.create_session(str(self.repo_path))

    async def _request_opencode_stop(self, reason: str) -> bool:
        """Backward compat: delegates to adapter.stop()."""
        self._sync_adapter_http_client()
        if self._session_id:
            await self.adapter.stop(self._session_id)
            return True
        return False

    async def _load_session_id(self) -> None:
        """Backward compat: delegates to adapter.load_session_id()."""
        self._sync_adapter_http_client()
        self._session_id = await self.adapter.load_session_id()

    async def _save_session_id(self) -> None:
        """Backward compat: delegates to adapter.save_session_id()."""
        if self._session_id:
            await self.adapter.save_session_id(self._session_id)

    # ─────────────────────────────────────────────────────────────────────

    @property
    def ws_url(self) -> str:
        """WebSocket URL for control plane connection."""
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

    @staticmethod
    def _redact_git_stderr(stderr_text: str, push_url: str, redacted_push_url: str) -> str:
        """Redact credential-bearing URLs from git stderr."""
        redacted_stderr = stderr_text
        if push_url and redacted_push_url:
            redacted_stderr = redacted_stderr.replace(push_url, redacted_push_url)

        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", redacted_stderr)

    async def run(self) -> None:
        """Main bridge loop with reconnection handling.

        Handles reconnection for transient errors (network issues, etc.) but
        exits gracefully for terminal errors like HTTP 410 (session terminated).
        """
        self.log.info("bridge.run_start")

        self.http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                self.HTTP_DEFAULT_TIMEOUT,
                connect=self.HTTP_CONNECT_TIMEOUT,
            )
        )

        # Configure adapter with http_client and port
        port = int(os.environ.get("AGENT_PORT", "4096"))
        self.adapter.configure(self.http_client, port)

        # Load persisted session ID
        self._session_id = await self.adapter.load_session_id()

        reconnect_attempts = 0

        try:
            while not self.shutdown_event.is_set():
                try:
                    await self._connect_and_run()
                    reconnect_attempts = 0
                except SessionTerminatedError as e:
                    # Non-recoverable: session has been terminated by control plane
                    self.log.info(
                        "bridge.disconnect",
                        reason="session_terminated",
                        detail=str(e),
                    )
                    self.shutdown_event.set()
                    break
                except websockets.ConnectionClosed as e:
                    self.log.warn(
                        "bridge.disconnect",
                        reason="connection_closed",
                        ws_close_code=e.code,
                    )
                except Exception as e:
                    error_str = str(e)
                    # Check for fatal HTTP errors that shouldn't trigger retry
                    if self._is_fatal_connection_error(error_str):
                        self.log.error(
                            "bridge.disconnect",
                            reason="fatal_error",
                            exc=e,
                        )
                        self.shutdown_event.set()
                        break
                    self.log.warn(
                        "bridge.disconnect",
                        reason="connection_error",
                        detail=error_str,
                    )

                if self.shutdown_event.is_set():
                    break

                reconnect_attempts += 1
                delay = min(
                    self.RECONNECT_BACKOFF_BASE**reconnect_attempts,
                    self.RECONNECT_MAX_DELAY,
                )
                self.log.info(
                    "bridge.reconnect",
                    attempt=reconnect_attempts,
                    delay_s=round(delay, 1),
                )
                await asyncio.sleep(delay)

        finally:
            # Cancel any in-flight prompt task before closing resources
            if self._current_prompt_task and not self._current_prompt_task.done():
                self._current_prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._current_prompt_task
            if self.http_client:
                await self.http_client.aclose()

    def _is_fatal_connection_error(self, error_str: str) -> bool:
        """Check if a connection error is fatal and shouldn't trigger retry."""
        fatal_patterns = [
            "HTTP 401",
            "HTTP 403",
            "HTTP 404",
            "HTTP 410",
        ]
        return any(pattern in error_str for pattern in fatal_patterns)

    async def _connect_and_run(self) -> None:
        """Connect to control plane and handle messages.

        Raises:
            SessionTerminatedError: If the control plane rejects the connection
                with HTTP 410 (session stopped/stale).
        """
        additional_headers = {
            "Authorization": f"Bearer {self.auth_token}",
            "X-Sandbox-ID": self.sandbox_id,
        }

        try:
            async with websockets.connect(
                self.ws_url,
                additional_headers=additional_headers,
                ping_interval=20,
                ping_timeout=10,
            ) as ws:
                self.ws = ws
                self.log.info("bridge.connect", outcome="success")

                await self._send_event(
                    {
                        "type": "ready",
                        "sandboxId": self.sandbox_id,
                        "agentSessionId": self._session_id,
                    }
                )

                just_flushed = await self._flush_event_buffer()
                await self._flush_pending_acks(skip_ack_ids=just_flushed)

                heartbeat_task = asyncio.create_task(self._heartbeat_loop())
                background_tasks: set[asyncio.Task[None]] = set()

                try:
                    async for message in ws:
                        if self.shutdown_event.is_set():
                            break

                        try:
                            cmd = json.loads(message)
                            task = await self._handle_command(cmd)
                            if task:
                                background_tasks.add(task)
                                task.add_done_callback(background_tasks.discard)
                        except json.JSONDecodeError as e:
                            self.log.warn("bridge.invalid_message", exc=e)
                        except Exception as e:
                            self.log.error("bridge.command_error", exc=e)

                finally:
                    heartbeat_task.cancel()
                    for task in background_tasks:
                        task.cancel()
                    self.ws = None

        except InvalidStatus as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (401, 403, 404, 410):
                raise SessionTerminatedError(
                    f"Session rejected by control plane (HTTP {status})."
                ) from e
            raise

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeat events."""
        while not self.shutdown_event.is_set():
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)

            if self.ws and self.ws.state == State.OPEN:
                await self._send_event(
                    {
                        "type": "heartbeat",
                        "sandboxId": self.sandbox_id,
                        "status": "ready",
                        "timestamp": time.time(),
                    }
                )

    async def _send_event(self, event: dict[str, Any]) -> None:
        """Send event to control plane, buffering if WS is unavailable."""
        event_type = event.get("type", "unknown")
        event["sandboxId"] = self.sandbox_id
        event["timestamp"] = event.get("timestamp", time.time())

        is_critical = event_type in self.CRITICAL_EVENT_TYPES
        if is_critical and "ackId" not in event:
            event["ackId"] = self._make_ack_id(event)

        if not self.ws or self.ws.state != State.OPEN:
            self._buffer_event(event)
            return

        try:
            await self.ws.send(json.dumps(event))
            if is_critical:
                self._pending_acks[event["ackId"]] = event
        except Exception as e:
            self.log.warn("bridge.send_error", event_type=event_type, exc=e)
            self._buffer_event(event)

    async def _flush_event_buffer(self) -> set[str]:
        """Flush buffered events to the control plane after reconnect.

        Returns the set of ackIds that were added to _pending_acks during this
        flush, so the caller can skip them in _flush_pending_acks (avoiding
        double-send on the same reconnect).
        """
        if not self._event_buffer:
            return set()

        self.log.info("bridge.flush_buffer_start", buffer_size=len(self._event_buffer))
        flushed = 0
        just_added: set[str] = set()
        while self._event_buffer:
            event = self._event_buffer[0]
            if not self.ws or self.ws.state != State.OPEN:
                break
            try:
                await self.ws.send(json.dumps(event))
                self._event_buffer.pop(0)
                flushed += 1
                # Track critical events sent from buffer as pending ACKs
                if event.get("type") in self.CRITICAL_EVENT_TYPES and "ackId" in event:
                    self._pending_acks[event["ackId"]] = event
                    just_added.add(event["ackId"])
            except Exception as e:
                self.log.warn("bridge.flush_send_error", exc=e)
                break

        self.log.info(
            "bridge.flush_buffer_complete",
            flushed=flushed,
            remaining=len(self._event_buffer),
        )
        return just_added

    def _buffer_event(self, event: dict[str, Any]) -> None:
        """Buffer an event for later delivery after WS reconnect."""
        if len(self._event_buffer) >= self.MAX_EVENT_BUFFER_SIZE:
            # Evict oldest non-critical event; fall back to oldest if all critical
            evicted = False
            for i, buffered in enumerate(self._event_buffer):
                if buffered.get("type") not in self.CRITICAL_EVENT_TYPES:
                    self._event_buffer.pop(i)
                    evicted = True
                    break
            if not evicted:
                self._event_buffer.pop(0)

        self._event_buffer.append(event)
        self.log.debug(
            "bridge.event_buffered",
            event_type=event.get("type", "unknown"),
            buffer_size=len(self._event_buffer),
        )

    @staticmethod
    def _make_ack_id(event: dict[str, Any]) -> str:
        """Generate a deterministic ack ID for a critical event."""
        event_type = event.get("type", "unknown")
        message_id = event.get("messageId")
        if message_id:
            return f"{event_type}:{message_id}"
        return f"{event_type}:{secrets.token_hex(8)}"

    async def _flush_pending_acks(self, skip_ack_ids: set[str] | None = None) -> None:
        """Re-send unacknowledged critical events on a new WS connection."""
        if not self._pending_acks:
            return

        self.log.info("bridge.flush_pending_acks_start", count=len(self._pending_acks))
        resent = 0
        for ack_id, event in list(self._pending_acks.items()):
            if skip_ack_ids and ack_id in skip_ack_ids:
                continue
            if not self.ws or self.ws.state != State.OPEN:
                break
            try:
                await self.ws.send(json.dumps(event))
                resent += 1
            except Exception as e:
                self.log.warn("bridge.flush_pending_ack_error", ack_id=ack_id, exc=e)
                break

        self.log.info(
            "bridge.flush_pending_acks_complete",
            resent=resent,
            total=len(self._pending_acks),
        )

    async def _handle_command(self, cmd: dict[str, Any]) -> asyncio.Task[None] | None:
        """Handle command from control plane.

        Long-running commands (like prompt) are run as background tasks to keep
        the WebSocket listener responsive to other commands (like push).

        Returns a Task for long-running commands, None for immediate commands.
        """
        cmd_type = cmd.get("type")
        self.log.debug("bridge.command_received", cmd_type=cmd_type)

        if cmd_type == "prompt":
            message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
            task = asyncio.create_task(self._handle_prompt(cmd))
            self._current_prompt_task = task

            def handle_task_exception(t: asyncio.Task[None], mid: str = message_id) -> None:
                if self._current_prompt_task is t:
                    self._current_prompt_task = None
                if t.cancelled():
                    asyncio.create_task(
                        self._send_event(
                            {
                                "type": "execution_complete",
                                "messageId": mid,
                                "success": False,
                                "error": "Task was cancelled",
                            }
                        )
                    )
                elif exc := t.exception():
                    asyncio.create_task(
                        self._send_event(
                            {
                                "type": "execution_complete",
                                "messageId": mid,
                                "success": False,
                                "error": str(exc),
                            }
                        )
                    )

            task.add_done_callback(handle_task_exception)
            # Don't return the task — prompt tasks must survive WS disconnects.
            return None
        elif cmd_type == "stop":
            await self._handle_stop()
        elif cmd_type == "snapshot":
            await self._handle_snapshot()
        elif cmd_type == "shutdown":
            await self._handle_shutdown()
        elif cmd_type == "git_sync_complete":
            self.git_sync_complete.set()
        elif cmd_type == "push":
            await self._handle_push(cmd)
        elif cmd_type == "ack":
            ack_id = cmd.get("ackId")
            if ack_id and ack_id in self._pending_acks:
                del self._pending_acks[ack_id]
                self.log.debug("bridge.ack_received", ack_id=ack_id)
        else:
            self.log.debug("bridge.unknown_command", cmd_type=cmd_type)
        return None

    def _validate_event(self, event: dict[str, Any]) -> None:
        """Validate adapter events before sending to SessionDO."""
        event_type = event.get("type")
        required = REQUIRED_EVENT_FIELDS.get(event_type)
        if required:
            missing = [f for f in required if f not in event]
            if missing:
                self.log.error(
                    "bridge.invalid_adapter_event",
                    event_type=event_type,
                    missing_fields=missing,
                )
                raise ValueError(f"Adapter emitted {event_type} missing: {missing}")

    async def _handle_prompt(self, cmd: dict[str, Any]) -> None:
        """Handle prompt command - send to agent adapter and stream response."""
        message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
        content = cmd.get("content", "")
        model = cmd.get("model")
        reasoning_effort = cmd.get("reasoningEffort")
        author_data = cmd.get("author", {})
        start_time = time.time()
        outcome = "success"

        self.log.info(
            "prompt.start",
            message_id=message_id,
            model=model,
            reasoning_effort=reasoning_effort,
        )

        try:
            scm_name = author_data.get("scmName")
            scm_email = author_data.get("scmEmail")
            await self._configure_git_identity(
                GitUser(
                    name=scm_name or FALLBACK_GIT_USER.name,
                    email=scm_email or FALLBACK_GIT_USER.email,
                )
            )

            if not self._session_id:
                self._session_id = await self.adapter.create_session(str(self.repo_path))

            had_error = False
            error_message = None
            async for event in self.adapter.send_prompt(
                self._session_id, content, message_id, model, reasoning_effort
            ):
                self._validate_event(event)
                if event.get("type") == "error":
                    had_error = True
                    error_message = event.get("error")
                await self._send_event(event)

            if had_error:
                outcome = "error"

            await self._send_event(
                {
                    "type": "execution_complete",
                    "messageId": message_id,
                    "success": not had_error,
                    **({"error": error_message} if error_message else {}),
                }
            )

        except Exception as e:
            outcome = "error"
            self.log.error("prompt.error", exc=e, message_id=message_id)
            await self._send_event(
                {
                    "type": "execution_complete",
                    "messageId": message_id,
                    "success": False,
                    "error": str(e),
                }
            )
        finally:
            duration_ms = int((time.time() - start_time) * 1000)
            self.log.info(
                "prompt.run",
                message_id=message_id,
                model=model,
                reasoning_effort=reasoning_effort,
                outcome=outcome,
                duration_ms=duration_ms,
            )

    async def _handle_stop(self) -> None:
        """Handle stop command - cancel prompt task and request agent stop."""
        self.log.info("bridge.stop")
        task = self._current_prompt_task
        if task and not task.done():
            task.cancel()
        # Best-effort: also tell agent to stop
        self._sync_adapter_http_client()
        if self._session_id:
            await self.adapter.stop(self._session_id)

    async def _handle_snapshot(self) -> None:
        """Handle snapshot command - prepare for snapshot."""
        self.log.info("bridge.snapshot_prepare")
        await self._send_event(
            {
                "type": "snapshot_ready",
                "agentSessionId": self.adapter.get_session_id_for_snapshot(),
            }
        )

    async def _handle_shutdown(self) -> None:
        """Handle shutdown command - graceful shutdown."""
        self.log.info("bridge.shutdown_requested")
        if self._current_prompt_task and not self._current_prompt_task.done():
            self._current_prompt_task.cancel()
        self.shutdown_event.set()

    async def _handle_push(self, cmd: dict[str, Any]) -> None:
        """Handle push command using provider-generated push spec."""
        push_spec = cmd.get("pushSpec") if isinstance(cmd.get("pushSpec"), dict) else None
        branch_name = str(push_spec.get("targetBranch", "")).strip() if push_spec else ""

        self.log.info(
            "git.push_start",
            branch_name=branch_name,
            mode="push_spec",
        )

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self.log.warn("git.push_error", reason="no_repository")
            await self._send_event(
                {
                    "type": "push_error",
                    "error": "No repository found",
                    "timestamp": time.time(),
                }
            )
            return

        repo_dir = repo_dirs[0].parent

        try:
            if not push_spec:
                self.log.warn("git.push_error", reason="missing_push_spec")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - missing push specification",
                        "branchName": branch_name,
                        "timestamp": time.time(),
                    }
                )
                return

            if not branch_name:
                self.log.warn("git.push_error", reason="missing_target_branch")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - missing target branch",
                        "branchName": "",
                        "timestamp": time.time(),
                    }
                )
                return

            refspec = str(push_spec.get("refspec", "")).strip()
            push_url = str(push_spec.get("remoteUrl", "")).strip()
            redacted_push_url = str(push_spec.get("redactedRemoteUrl", "")).strip()
            force_push = bool(push_spec.get("force", False))

            if not refspec or not push_url:
                self.log.warn("git.push_error", reason="invalid_push_spec")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - invalid push specification",
                        "branchName": branch_name,
                        "timestamp": time.time(),
                    }
                )
                return

            self.log.info(
                "git.push_command",
                branch_name=branch_name,
                refspec=refspec,
                force=force_push,
                remote_url=redacted_push_url,
            )

            result = await asyncio.create_subprocess_exec(
                "git",
                "push",
                push_url,
                refspec,
                *(["-f"] if force_push else []),
                cwd=repo_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                _stdout, _stderr = await asyncio.wait_for(
                    result.communicate(),
                    timeout=self.GIT_PUSH_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                self.log.warn(
                    "git.push_timeout",
                    branch_name=branch_name,
                    timeout_ms=int(self.GIT_PUSH_TIMEOUT_SECONDS * 1000),
                )

                with contextlib.suppress(ProcessLookupError):
                    result.terminate()

                try:
                    await asyncio.wait_for(
                        result.wait(),
                        timeout=self.GIT_PUSH_TERMINATE_GRACE_SECONDS,
                    )
                except TimeoutError:
                    self.log.warn(
                        "git.push_kill",
                        branch_name=branch_name,
                        timeout_ms=int(self.GIT_PUSH_TERMINATE_GRACE_SECONDS * 1000),
                    )
                    with contextlib.suppress(ProcessLookupError):
                        result.kill()
                    await result.wait()

                await self._send_event(
                    {
                        "type": "push_error",
                        "error": (
                            "Push failed - git push timed out "
                            f"after {int(self.GIT_PUSH_TIMEOUT_SECONDS)}s"
                        ),
                        "branchName": branch_name,
                        "timestamp": time.time(),
                    }
                )
                return

            if result.returncode != 0:
                stderr_text = _stderr.decode("utf-8", errors="replace").strip() if _stderr else ""
                redacted_stderr_text = self._redact_git_stderr(
                    stderr_text,
                    push_url,
                    redacted_push_url,
                )
                self.log.warn(
                    "git.push_failed",
                    branch_name=branch_name,
                    stderr=redacted_stderr_text,
                )
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": f"Push failed: {redacted_stderr_text}"
                        if redacted_stderr_text
                        else "Push failed - unknown error",
                        "branchName": branch_name,
                        "timestamp": time.time(),
                    }
                )
            else:
                self.log.info("git.push_complete", branch_name=branch_name)
                await self._send_event(
                    {
                        "type": "push_complete",
                        "branchName": branch_name,
                        "timestamp": time.time(),
                    }
                )

        except Exception as e:
            self.log.error("git.push_error", exc=e, branch_name=branch_name)
            await self._send_event(
                {
                    "type": "push_error",
                    "error": str(e),
                    "branchName": branch_name,
                    "timestamp": time.time(),
                }
            )

    async def _configure_git_identity(self, user: GitUser) -> None:
        """Configure git identity for commit attribution."""
        self.log.debug("git.identity_configure", git_name=user.name, git_email=user.email)

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self.log.debug("git.identity_skip", reason="no_repository")
            return

        repo_dir = repo_dirs[0].parent

        async def _run_git_config(*args: str) -> None:
            cmd = ["git", "config", "--local", *args]
            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=repo_dir,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                _, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.GIT_CONFIG_TIMEOUT_SECONDS,
                )
            except TimeoutError as e:
                process.kill()
                with contextlib.suppress(ProcessLookupError):
                    await process.wait()
                raise subprocess.TimeoutExpired(
                    cmd=cmd,
                    timeout=self.GIT_CONFIG_TIMEOUT_SECONDS,
                ) from e

            if process.returncode != 0:
                if process.returncode is None:
                    raise RuntimeError("git config exited without a return code")
                raise subprocess.CalledProcessError(
                    returncode=process.returncode,
                    cmd=cmd,
                    stderr=stderr,
                )

        try:
            await _run_git_config("user.name", user.name)
            await _run_git_config("user.email", user.email)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            self.log.error("git.identity_error", exc=e)


async def main() -> None:
    """Entry point for bridge process."""
    parser = argparse.ArgumentParser(description="Open-Inspect Agent Bridge")
    parser.add_argument("--sandbox-id", required=True, help="Sandbox ID")
    parser.add_argument("--session-id", required=True, help="Session ID for WebSocket connection")
    parser.add_argument("--control-plane", required=True, help="Control plane URL")
    parser.add_argument("--token", required=True, help="Auth token")

    args = parser.parse_args()

    # Load adapter from environment
    agent_name = os.environ.get("AGENT_ADAPTER", "opencode")
    adapter = load_adapter(agent_name)

    bridge = AgentBridge(
        sandbox_id=args.sandbox_id,
        session_id=args.session_id,
        control_plane_url=args.control_plane,
        auth_token=args.token,
        adapter=adapter,
    )

    await bridge.run()


if __name__ == "__main__":
    asyncio.run(main())
