"""OpenCode agent adapter.

Implements the AgentAdapter interface for the OpenCode coding agent.
All OpenCode-specific logic lives here — extracted from bridge.py and supervisor.py.
"""

import asyncio
import json
import os
import secrets
import shutil
import tempfile
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, ClassVar

import httpx

from ..log_config import get_logger
from .base import AgentAdapter


class OpenCodeIdentifier:
    """
    Generate OpenCode-compatible ascending IDs.

    Port of OpenCode's TypeScript implementation:
    https://github.com/anomalyco/opencode/blob/8f0d08fae07c97a090fcd31d0d4c4a6fa7eeaa1d/packages/opencode/src/id/id.ts

    Format: {prefix}_{timestamp_hex}{random_base62}
    - prefix: type identifier (e.g., "msg" for messages)
    - timestamp_hex: 12 hex chars encoding (timestamp_ms * 0x1000 + counter)
    - random_base62: 14 random base62 characters

    IDs are monotonically increasing, ensuring new user messages always have
    IDs greater than previous assistant messages (required for OpenCode's
    prompt loop).

    Note: Uses class-level state for monotonic generation. Safe for async code
    but NOT thread-safe.
    """

    PREFIXES: ClassVar[dict[str, str]] = {
        "session": "ses",
        "message": "msg",
        "part": "prt",
    }
    BASE62_CHARS: ClassVar[str] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    RANDOM_LENGTH: ClassVar[int] = 14

    _last_timestamp: ClassVar[int] = 0
    _counter: ClassVar[int] = 0

    @classmethod
    def ascending(cls, prefix: str) -> str:
        """Generate an ascending ID with the given prefix."""
        if prefix not in cls.PREFIXES:
            raise ValueError(f"Unknown prefix: {prefix}")

        prefix_str = cls.PREFIXES[prefix]
        current_timestamp = int(time.time() * 1000)

        if current_timestamp != cls._last_timestamp:
            cls._last_timestamp = current_timestamp
            cls._counter = 0
        cls._counter += 1

        encoded = current_timestamp * 0x1000 + cls._counter
        encoded_48bit = encoded & 0xFFFFFFFFFFFF
        timestamp_bytes = encoded_48bit.to_bytes(6, byteorder="big")
        timestamp_hex = timestamp_bytes.hex()
        random_suffix = cls._random_base62(cls.RANDOM_LENGTH)

        return f"{prefix_str}_{timestamp_hex}{random_suffix}"

    @classmethod
    def _random_base62(cls, length: int) -> str:
        """Generate random base62 string."""
        return "".join(cls.BASE62_CHARS[secrets.randbelow(62)] for _ in range(length))


class SSEConnectionError(Exception):
    """Raised when SSE connection fails."""

    pass


class OpenCodeAdapter(AgentAdapter):
    """OpenCode agent adapter.

    Handles both lifecycle (supervisor) and communication (bridge) for OpenCode.
    """

    PORT = 4096
    HEALTH_CHECK_TIMEOUT = 30.0
    REQUEST_TIMEOUT = 30.0
    HTTP_CONNECT_TIMEOUT = 30.0
    SSE_INACTIVITY_TIMEOUT = 120.0
    SSE_INACTIVITY_TIMEOUT_MIN = 5.0
    SSE_INACTIVITY_TIMEOUT_MAX = 3600.0
    PROMPT_MAX_DURATION = 5400.0
    MAX_PENDING_PART_EVENTS = 2000
    MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS = 180

    # Anthropic extended thinking budget tokens by reasoning effort level.
    ANTHROPIC_THINKING_BUDGETS: ClassVar[dict[str, int]] = {
        "high": 16_000,
        "max": 31_999,
    }
    ANTHROPIC_ADAPTIVE_THINKING_MODELS: ClassVar[set[str]] = {
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
    }
    ANTHROPIC_ADAPTIVE_EFFORTS: ClassVar[set[str]] = {"low", "medium", "high", "max"}

    # Custom model definitions for models not yet in models.dev registry.
    # OpenCode validates models against its cached registry; models listed here
    # are injected into the provider config so OpenCode accepts them.
    CUSTOM_ANTHROPIC_MODELS: ClassVar[dict[str, dict[str, Any]]] = {
        "claude-sonnet-4-6": {
            "name": "Claude Sonnet 4.6",
            "attachment": True,
            "reasoning": True,
            "temperature": True,
            "tool_call": True,
            "cost": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75},
            "limit": {"context": 200000, "output": 16384},
        },
        "claude-opus-4-5": {
            "name": "Claude Opus 4.5",
            "attachment": True,
            "reasoning": True,
            "temperature": True,
            "tool_call": True,
            "cost": {"input": 15, "output": 75, "cache_read": 1.5, "cache_write": 18.75},
            "limit": {"context": 200000, "output": 32768},
        },
        "claude-opus-4-6": {
            "name": "Claude Opus 4.6",
            "attachment": True,
            "reasoning": True,
            "temperature": True,
            "tool_call": True,
            "cost": {"input": 15, "output": 75, "cache_read": 1.5, "cache_write": 18.75},
            "limit": {"context": 200000, "output": 32768},
        },
        "claude-opus-4-7": {
            "name": "Claude Opus 4.7",
            "attachment": True,
            "reasoning": True,
            "temperature": True,
            "tool_call": True,
            "cost": {"input": 15, "output": 75, "cache_read": 1.5, "cache_write": 18.75},
            "limit": {"context": 200000, "output": 32768},
        },
    }

    # Validates npm package names before passing to `npm install -g`.
    _NPM_PKG_RE = __import__("re").compile(r"^(@[\w.-]+/)?[\w][\w.-]*(@[\w.-]+)?$")

    def __init__(self) -> None:
        self.log = get_logger("opencode_adapter", service="sandbox")
        self.process: asyncio.subprocess.Process | None = None
        self.http_client: httpx.AsyncClient | None = None
        self.base_url: str = f"http://localhost:{self.PORT}"
        self._session_id: str | None = None
        self._session_id_file = Path(tempfile.gettempdir()) / "opencode-session-id"
        self._sse_inactivity_timeout: float = self.SSE_INACTIVITY_TIMEOUT

    # ─────────────────────────────────────────────────────────────────────
    # Supervisor process methods (agent lifecycle)
    # ─────────────────────────────────────────────────────────────────────

    async def install(self, workdir: Path, session_config: dict) -> None:
        """Install tools, skills, plugins, and MCP packages."""
        self._install_tools(workdir)
        self._install_skills(workdir)
        self._install_bin_scripts()

        # Deploy codex auth proxy plugin if OpenAI OAuth is configured
        opencode_dir = workdir / ".opencode"
        plugin_source = Path("/app/sandbox_runtime/plugins/codex-auth-plugin.js")
        if plugin_source.exists() and os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN"):
            plugin_dir = opencode_dir / "plugins"
            plugin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(plugin_source, plugin_dir / "codex-auth-plugin.js")
            self.log.info("openai_oauth.plugin_deployed")

        # Pre-install MCP npm packages
        mcp_servers = session_config.get("mcp_servers") or []
        if mcp_servers:
            await self._install_mcp_packages(mcp_servers)

    async def prepare(self, workdir: Path, session_config: dict) -> None:
        """Launch OpenCode server with configuration. Blocks until healthy."""
        self._setup_openai_oauth()
        self.log.info("opencode.start")

        # Build OpenCode config
        provider = session_config.get("provider", "anthropic")
        model = session_config.get("model", "claude-sonnet-4-6")
        opencode_config: dict = {
            "model": f"{provider}/{model}",
            "permission": {"*": {"*": "allow"}},
        }

        # Register custom model definitions so OpenCode accepts model IDs
        # that aren't yet in the models.dev registry.
        if self.CUSTOM_ANTHROPIC_MODELS:
            opencode_config["provider"] = {
                "anthropic": {
                    "models": self.CUSTOM_ANTHROPIC_MODELS,
                },
            }

        # Inject MCP servers
        mcp_servers = session_config.get("mcp_servers") or []
        if mcp_servers:
            mcp_config = self._build_mcp_config(mcp_servers)
            if mcp_config:
                opencode_config["mcp"] = mcp_config
                self.log.info("mcp.configured", count=len(mcp_config))

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            "OPENCODE_CLIENT": "serve",
        }

        self.process = await asyncio.create_subprocess_exec(
            "opencode",
            "serve",
            "--port",
            str(self.PORT),
            "--hostname",
            "0.0.0.0",
            "--print-logs",
            cwd=workdir,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Start log forwarder
        asyncio.create_task(self.forward_logs())

        # Wait for health check
        await self._wait_for_health()
        self.log.info("opencode.ready")

    def get_process(self) -> "asyncio.subprocess.Process | None":
        """Return the OpenCode subprocess handle."""
        return self.process

    async def forward_logs(self) -> None:
        """Forward OpenCode stdout to supervisor stdout."""
        if not self.process or not self.process.stdout:
            return

        try:
            async for line in self.process.stdout:
                print(f"[opencode] {line.decode().rstrip()}")
        except Exception as e:
            print(f"[opencode_adapter] Log forwarding error: {e}")

    # ─────────────────────────────────────────────────────────────────────
    # Bridge subprocess methods (agent communication)
    # ─────────────────────────────────────────────────────────────────────

    async def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
        """Configure for bridge communication."""
        self.http_client = http_client
        self.base_url = f"http://localhost:{port}"

        # Resolve SSE inactivity timeout from env
        raw = os.environ.get("BRIDGE_SSE_INACTIVITY_TIMEOUT")
        if raw:
            try:
                value = float(raw)
                value = max(self.SSE_INACTIVITY_TIMEOUT_MIN, min(value, self.SSE_INACTIVITY_TIMEOUT_MAX))
                self._sse_inactivity_timeout = value
            except ValueError:
                pass

    async def create_session(self, repo_path: str) -> str:
        """Create a new OpenCode session (OpenCode always creates fresh)."""
        if not self.http_client:
            raise RuntimeError("HTTP client not initialized")

        resp = await self.http_client.post(
            f"{self.base_url}/session",
            json={},
            timeout=self.REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()

        session_id = data.get("id")
        self._session_id = session_id
        self.log.info(
            "opencode.session.ensure",
            opencode_session_id=session_id,
            action="created",
        )

        await self.save_session_id(session_id)
        return session_id

    async def send_prompt(
        self,
        session_id: str,
        content: str,
        message_id: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream response from OpenCode using Server-Sent Events.

        Uses messageID-based correlation for reliable event attribution.
        """
        if not self.http_client:
            raise RuntimeError("HTTP client not initialized")

        self._session_id = session_id

        opencode_message_id = OpenCodeIdentifier.ascending("message")
        request_body = self._build_prompt_request_body(
            content, model, opencode_message_id, reasoning_effort
        )

        sse_url = f"{self.base_url}/event"
        async_url = f"{self.base_url}/session/{session_id}/prompt_async"

        cumulative_text: dict[str, str] = {}
        emitted_tool_states: set[str] = set()
        allowed_assistant_msg_ids: set[str] = set()
        pending_parts: dict[str, list[tuple[dict[str, Any], Any]]] = {}
        pending_parts_total = 0
        pending_drop_logged = False

        # Child session tracking (sub-tasks)
        tracked_child_session_ids: set[str] = set()

        # Compaction tracking
        compaction_occurred = False

        start_time = time.time()
        loop = asyncio.get_running_loop()

        def buffer_part(oc_msg_id: str, part: dict[str, Any], delta: Any) -> None:
            nonlocal pending_parts_total
            nonlocal pending_drop_logged
            if pending_parts_total >= self.MAX_PENDING_PART_EVENTS:
                if not pending_drop_logged:
                    self.log.warn(
                        "bridge.pending_parts_dropped",
                        message_id=message_id,
                        limit=self.MAX_PENDING_PART_EVENTS,
                    )
                    pending_drop_logged = True
                return
            pending_parts.setdefault(oc_msg_id, []).append((part, delta))
            pending_parts_total += 1

        def handle_part(
            part: dict[str, Any],
            delta: Any,
            *,
            is_subtask: bool = False,
        ) -> list[dict[str, Any]]:
            part_type = part.get("type", "")
            part_id = part.get("id", "")
            events: list[dict[str, Any]] = []

            if part_type == "text":
                if is_subtask:
                    return events
                text = part.get("text", "")
                if delta:
                    cumulative_text[part_id] = cumulative_text.get(part_id, "") + delta
                else:
                    cumulative_text[part_id] = text

                if cumulative_text.get(part_id):
                    events.append(
                        {
                            "type": "token",
                            "content": cumulative_text[part_id],
                            "messageId": message_id,
                        }
                    )

            elif part_type == "tool":
                tool_event = self._transform_part_to_event(part, message_id)
                if tool_event:
                    state = part.get("state", {})
                    status = state.get("status", "")
                    call_id = part.get("callID", "")
                    part_sid = part.get("sessionID", "")
                    tool_key = f"tool:{part_sid}:{call_id}:{status}"

                    if tool_key not in emitted_tool_states:
                        emitted_tool_states.add(tool_key)
                        events.append(tool_event)

            elif part_type == "step-start":
                events.append(
                    {
                        "type": "step_start",
                        "messageId": message_id,
                    }
                )

            elif part_type == "step-finish":
                events.append(
                    {
                        "type": "step_finish",
                        "cost": part.get("cost"),
                        "tokens": part.get("tokens"),
                        "reason": part.get("reason"),
                        "messageId": message_id,
                    }
                )

            if is_subtask:
                for ev in events:
                    ev["isSubtask"] = True
            return events

        try:
            deadline = loop.time() + self._sse_inactivity_timeout
            async with asyncio.timeout_at(deadline) as timeout_ctx:
                async with self.http_client.stream(
                    "GET",
                    sse_url,
                    timeout=httpx.Timeout(None, connect=self.HTTP_CONNECT_TIMEOUT, read=None),
                ) as sse_response:
                    if sse_response.status_code != 200:
                        raise SSEConnectionError(
                            f"SSE connection failed: {sse_response.status_code}"
                        )

                    prompt_start = loop.time()
                    prompt_response = await self.http_client.post(
                        async_url,
                        json=request_body,
                        timeout=self.REQUEST_TIMEOUT,
                    )
                    if prompt_response.status_code not in [200, 204]:
                        error_body = prompt_response.text
                        self.log.error(
                            "bridge.prompt_request_error",
                            status_code=prompt_response.status_code,
                            error_body=error_body,
                        )
                        raise RuntimeError(
                            f"Async prompt failed: {prompt_response.status_code} - {error_body}"
                        )

                    async for event in self._parse_sse_stream(sse_response, timeout_ctx):
                        event_type = event.get("type")
                        props = event.get("properties", {})

                        if event_type == "server.connected":
                            pass
                        elif event_type != "server.heartbeat":
                            # Track direct child sessions before filtering
                            if event_type == "session.created":
                                info = props.get("info", {})
                                child_id = info.get("id")
                                child_parent = info.get("parentID")
                                if child_id and child_parent == session_id:
                                    tracked_child_session_ids.add(child_id)
                                    self.log.info(
                                        "bridge.child_session_detected",
                                        child_session_id=child_id,
                                        source="session.created",
                                    )
                                continue

                            event_session_id = props.get("sessionID") or props.get(
                                "part", {}
                            ).get("sessionID")
                            is_child = event_session_id in tracked_child_session_ids
                            if (
                                not event_session_id
                                or event_session_id == session_id
                                or is_child
                            ):
                                if event_type == "message.updated":
                                    info = props.get("info", {})
                                    msg_session_id = info.get("sessionID")
                                    if msg_session_id == session_id:
                                        oc_msg_id = info.get("id", "")
                                        parent_id = info.get("parentID", "")
                                        role = info.get("role", "")
                                        finish = info.get("finish", "")

                                        parent_matches = parent_id == opencode_message_id
                                        is_compaction_summary = info.get("summary") is True

                                        self.log.debug(
                                            "bridge.message_updated",
                                            role=role,
                                            oc_msg_id=oc_msg_id,
                                            parent_match=parent_matches,
                                            compaction_occurred=compaction_occurred,
                                            is_compaction_summary=is_compaction_summary,
                                        )

                                        if role == "assistant" and oc_msg_id:
                                            if parent_matches or (
                                                compaction_occurred
                                                and not is_compaction_summary
                                            ):
                                                allowed_assistant_msg_ids.add(oc_msg_id)
                                                pending = pending_parts.pop(oc_msg_id, [])
                                                if pending:
                                                    pending_parts_total -= len(pending)
                                                    for part, delta in pending:
                                                        for part_event in handle_part(
                                                            part, delta
                                                        ):
                                                            yield part_event

                                        if finish and finish not in ("tool-calls", ""):
                                            self.log.debug(
                                                "bridge.message_finished",
                                                finish=finish,
                                            )

                                    elif msg_session_id in tracked_child_session_ids:
                                        oc_msg_id = info.get("id", "")
                                        role = info.get("role", "")
                                        if role == "assistant" and oc_msg_id:
                                            allowed_assistant_msg_ids.add(oc_msg_id)
                                            pending = pending_parts.pop(oc_msg_id, [])
                                            if pending:
                                                pending_parts_total -= len(pending)
                                                for part, delta in pending:
                                                    for ev in handle_part(
                                                        part, delta, is_subtask=True
                                                    ):
                                                        yield ev

                                elif event_type == "message.part.updated":
                                    part = props.get("part", {})
                                    delta = props.get("delta")
                                    oc_msg_id = part.get("messageID", "")
                                    part_session_id = part.get("sessionID", "")

                                    # Discover child sessions from task tool metadata
                                    if (
                                        part.get("tool") == "task"
                                        and part_session_id == session_id
                                    ):
                                        metadata = part.get("metadata")
                                        child_sid = (
                                            metadata.get("sessionId")
                                            if isinstance(metadata, dict)
                                            else None
                                        )
                                        if (
                                            child_sid
                                            and child_sid not in tracked_child_session_ids
                                        ):
                                            tracked_child_session_ids.add(child_sid)
                                            self.log.info(
                                                "bridge.child_session_detected",
                                                child_session_id=child_sid,
                                                source="task_metadata",
                                            )

                                    if oc_msg_id in allowed_assistant_msg_ids:
                                        if part_session_id in tracked_child_session_ids:
                                            for ev in handle_part(
                                                part, delta, is_subtask=True
                                            ):
                                                yield ev
                                        else:
                                            for part_event in handle_part(part, delta):
                                                yield part_event
                                    elif oc_msg_id:
                                        buffer_part(oc_msg_id, part, delta)

                                elif event_type == "session.idle":
                                    idle_session_id = props.get("sessionID")
                                    if idle_session_id == session_id:
                                        elapsed = time.time() - start_time
                                        self.log.debug(
                                            "bridge.session_idle",
                                            elapsed_s=round(elapsed, 1),
                                            tracked_msgs=len(allowed_assistant_msg_ids),
                                        )
                                        async for final_event in self._fetch_final_message_state(
                                            message_id,
                                            opencode_message_id,
                                            cumulative_text,
                                            allowed_assistant_msg_ids,
                                            compaction_occurred=compaction_occurred,
                                        ):
                                            yield final_event
                                        return

                                elif event_type == "session.status":
                                    status_session_id = props.get("sessionID")
                                    status = props.get("status", {})
                                    if (
                                        status_session_id == session_id
                                        and status.get("type") == "idle"
                                    ):
                                        elapsed = time.time() - start_time
                                        self.log.debug(
                                            "bridge.session_status_idle",
                                            elapsed_s=round(elapsed, 1),
                                            tracked_msgs=len(allowed_assistant_msg_ids),
                                        )
                                        async for final_event in self._fetch_final_message_state(
                                            message_id,
                                            opencode_message_id,
                                            cumulative_text,
                                            allowed_assistant_msg_ids,
                                            compaction_occurred=compaction_occurred,
                                        ):
                                            yield final_event
                                        return

                                elif event_type == "session.error":
                                    error_session_id = props.get("sessionID")
                                    if error_session_id == session_id:
                                        error_msg = self._extract_error_message(
                                            props.get("error", {})
                                        )
                                        self.log.error(
                                            "bridge.session_error", error_msg=error_msg
                                        )
                                        yield {
                                            "type": "error",
                                            "error": error_msg or "Unknown error",
                                            "messageId": message_id,
                                        }
                                        return
                                    elif error_session_id in tracked_child_session_ids:
                                        error_msg = self._extract_error_message(
                                            props.get("error", {})
                                        )
                                        self.log.error(
                                            "bridge.child_session_error",
                                            error_msg=error_msg,
                                            child_session_id=error_session_id,
                                        )
                                        yield {
                                            "type": "error",
                                            "error": error_msg or "Sub-task error",
                                            "messageId": message_id,
                                            "isSubtask": True,
                                        }

                                elif event_type == "session.compacted":
                                    compacted_session_id = props.get("sessionID")
                                    if compacted_session_id == session_id:
                                        compaction_occurred = True
                                        self.log.info(
                                            "bridge.session_compacted",
                                            message_id=message_id,
                                        )

                        if loop.time() > prompt_start + self.PROMPT_MAX_DURATION:
                            elapsed = time.time() - start_time
                            self.log.error(
                                "bridge.prompt_max_duration_timeout",
                                timeout_ms=int(self.PROMPT_MAX_DURATION * 1000),
                                elapsed_ms=int(elapsed * 1000),
                                message_id=message_id,
                            )
                            await self._request_stop(session_id, reason="prompt_max_duration_timeout")
                            async for final_event in self._fetch_final_message_state(
                                message_id,
                                opencode_message_id,
                                cumulative_text,
                                allowed_assistant_msg_ids,
                                compaction_occurred=compaction_occurred,
                            ):
                                yield final_event
                            raise RuntimeError(
                                f"Prompt exceeded max duration of {self.PROMPT_MAX_DURATION:.0f}s."
                            )

        except TimeoutError:
            elapsed = time.time() - start_time
            self.log.error(
                "bridge.sse_inactivity_timeout",
                timeout_name="sse_inactivity",
                timeout_ms=int(self._sse_inactivity_timeout * 1000),
                elapsed_ms=int(elapsed * 1000),
                operation="bridge.sse",
                message_id=message_id,
            )
            await self._request_stop(session_id, reason="inactivity_timeout")
            async for final_event in self._fetch_final_message_state(
                message_id,
                opencode_message_id,
                cumulative_text,
                allowed_assistant_msg_ids,
                compaction_occurred=compaction_occurred,
            ):
                yield final_event
            raise RuntimeError(
                f"SSE stream inactive for {self._sse_inactivity_timeout:.0f}s "
                f"(no data received). Total elapsed: {elapsed:.0f}s"
            )

        except httpx.ReadError as e:
            self.log.error("bridge.sse_read_error", exc=e)
            raise SSEConnectionError(f"SSE read error: {e}")

    async def stop(self, session_id: str) -> None:
        """Cancel current execution via OpenCode abort endpoint."""
        await self._request_stop(session_id, reason="command")

    async def health_check(self) -> bool:
        """Check if OpenCode is healthy."""
        if not self.http_client:
            return False
        try:
            resp = await self.http_client.get(
                f"{self.base_url}/global/health",
                timeout=2.0,
            )
            return resp.status_code == 200
        except Exception:
            return False

    async def load_session_id(self) -> str | None:
        """Load OpenCode session ID from file if it exists."""
        if not self._session_id_file.exists():
            return None

        try:
            session_id = self._session_id_file.read_text().strip()
            self.log.info(
                "opencode.session.ensure",
                opencode_session_id=session_id,
                action="loaded",
            )

            # Validate session still exists
            if self.http_client:
                try:
                    resp = await self.http_client.get(
                        f"{self.base_url}/session/{session_id}",
                        timeout=self.REQUEST_TIMEOUT,
                    )
                    if resp.status_code != 200:
                        self.log.info(
                            "opencode.session.invalid",
                            opencode_session_id=session_id,
                        )
                        return None
                except Exception:
                    return None

            self._session_id = session_id
            return session_id
        except Exception as e:
            self.log.error("opencode.session.load_error", exc=e)
            return None

    async def save_session_id(self, session_id: str) -> None:
        """Save OpenCode session ID to file for persistence."""
        self._session_id = session_id
        try:
            self._session_id_file.write_text(session_id)
        except Exception as e:
            self.log.error("opencode.session.save_error", exc=e)

    def get_session_id_for_snapshot(self) -> str | None:
        """Return the current session ID for snapshot metadata."""
        return self._session_id

    async def shutdown(self) -> None:
        """Terminate OpenCode process."""
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=10.0)
            except TimeoutError:
                self.process.kill()

    # ─────────────────────────────────────────────────────────────────────
    # Private helper methods
    # ─────────────────────────────────────────────────────────────────────

    async def _wait_for_health(self) -> None:
        """Poll health endpoint until server is ready."""
        health_url = f"http://localhost:{self.PORT}/global/health"
        start_time = time.time()

        async with httpx.AsyncClient() as client:
            while time.time() - start_time < self.HEALTH_CHECK_TIMEOUT:
                try:
                    resp = await client.get(health_url, timeout=2.0)
                    if resp.status_code == 200:
                        return
                except httpx.ConnectError:
                    pass
                except Exception as e:
                    self.log.debug("opencode.health_check_error", exc=e)

                await asyncio.sleep(0.5)

        raise RuntimeError("OpenCode server failed to become healthy")

    async def _request_stop(self, session_id: str, reason: str) -> bool:
        """Request OpenCode to abort the current session."""
        if not self.http_client or not session_id:
            return False

        try:
            await self.http_client.post(
                f"{self.base_url}/session/{session_id}/abort",
                timeout=self.REQUEST_TIMEOUT,
            )
            self.log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:
            self.log.warn("bridge.stop_request_error", exc=e, reason=reason)
            return False

    def _setup_openai_oauth(self) -> None:
        """Write OpenCode auth.json for ChatGPT OAuth if refresh token is configured."""
        refresh_token = os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN")
        if not refresh_token:
            return

        try:
            auth_dir = Path.home() / ".local" / "share" / "opencode"
            auth_dir.mkdir(parents=True, exist_ok=True)

            openai_entry: dict[str, Any] = {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }

            account_id = os.environ.get("OPENAI_OAUTH_ACCOUNT_ID")
            if account_id:
                openai_entry["accountId"] = account_id

            auth_file = auth_dir / "auth.json"
            tmp_file = auth_dir / ".auth.json.tmp"

            fd = os.open(str(tmp_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, json.dumps({"openai": openai_entry}).encode())
            finally:
                os.close(fd)
            tmp_file.replace(auth_file)

            self.log.info("openai_oauth.setup")
        except Exception as e:
            self.log.warn("openai_oauth.setup_error", exc=e)

    def _install_tools(self, workdir: Path) -> None:
        """Copy custom tools into the .opencode/tool directory for OpenCode to discover."""
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"

        legacy_tool = Path("/app/sandbox_runtime/plugins/inspect-plugin.js")
        tools_dir = Path("/app/sandbox_runtime/tools")

        has_tools = legacy_tool.exists() or tools_dir.exists()
        if not has_tools:
            return

        tool_dest.mkdir(parents=True, exist_ok=True)

        if legacy_tool.exists():
            shutil.copy(legacy_tool, tool_dest / "create-pull-request.js")

        if tools_dir.exists():
            for tool_file in tools_dir.iterdir():
                if tool_file.is_file() and tool_file.suffix == ".js":
                    shutil.copy(tool_file, tool_dest / tool_file.name)

        # Copy pre-built deps
        deps_cache = Path("/app/opencode-deps")
        for name in ("package.json", "package-lock.json"):
            src = deps_cache / name
            dest = opencode_dir / name
            if src.exists() and not dest.exists():
                shutil.copy2(src, dest)
        cached_modules = deps_cache / "node_modules"
        local_modules = opencode_dir / "node_modules"
        if cached_modules.is_dir() and not local_modules.exists():
            shutil.copytree(cached_modules, local_modules, symlinks=True)

    def _install_bin_scripts(self) -> None:
        """Install standalone CLI scripts into /usr/local/bin."""
        bin_dir = Path("/app/sandbox_runtime/bin")
        if not bin_dir.is_dir():
            return

        for script in bin_dir.iterdir():
            if script.is_file() and script.suffix == ".js":
                dest = Path("/usr/local/bin") / script.stem
                shutil.copy(script, dest)
                dest.chmod(0o755)
                self.log.info("bin.installed", script=script.stem)

    def _install_skills(self, workdir: Path) -> None:
        """Copy bundled Skills into the .opencode/skills directory."""
        skills_dir = Path("/app/sandbox_runtime/skills")
        if not skills_dir.is_dir():
            return

        skills_dest = workdir / ".opencode" / "skills"
        installed_any = False

        for skill_dir in skills_dir.iterdir():
            skill_file = skill_dir / "SKILL.md"
            if not skill_dir.is_dir() or not skill_file.exists():
                continue

            dest_dir = skills_dest / skill_dir.name
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(skill_file, dest_dir / "SKILL.md")
            installed_any = True

        if installed_any:
            self.log.info("opencode.skills_installed", skills_path=str(skills_dest))

    async def _install_mcp_packages(self, servers: list[dict]) -> None:
        """Pre-install npm packages for local MCP servers that use npx."""
        packages: list[str] = []
        for server in servers:
            if server.get("type") == "remote":
                continue
            cmd = server.get("command", [])
            if not cmd:
                continue
            parts = [c for c in cmd if isinstance(c, str)]
            if not parts or parts[0] != "npx":
                continue
            pkg: str | None = None
            for i, part in enumerate(parts):
                if part in ("-p", "--package") and i + 1 < len(parts):
                    pkg = parts[i + 1]
                    break
            if pkg is None:
                non_flags = [p for p in parts[1:] if not p.startswith("-")]
                pkg = non_flags[0] if non_flags else None

            if pkg:
                if self._NPM_PKG_RE.match(pkg):
                    packages.append(pkg)
                else:
                    self.log.warn(
                        "mcp.invalid_package_name",
                        package=pkg,
                        note="package skipped",
                    )

        packages = list(dict.fromkeys(packages))
        if not packages:
            return

        self.log.info("mcp.install_packages", packages=packages)
        try:
            proc = await asyncio.create_subprocess_exec(
                "npm",
                "install",
                "-g",
                *packages,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS
            )
            if proc.returncode == 0:
                self.log.info("mcp.packages_installed", packages=packages)
            else:
                self.log.warn(
                    "mcp.packages_install_failed",
                    packages=packages,
                    stderr=(stderr or b"").decode()[:500],
                )
        except TimeoutError:
            self.log.warn(
                "mcp.packages_install_timeout",
                packages=packages,
                timeout_seconds=self.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS,
            )
            proc.kill()
            await proc.wait()
        except Exception as e:
            self.log.warn("mcp.packages_install_error", packages=packages, exc=str(e))

    def _build_mcp_config(self, servers: list[dict]) -> dict[str, dict]:
        """Convert MCP server list to OpenCode mcp config format."""
        config: dict[str, dict] = {}
        for server in servers:
            name = server.get("name", "")
            if not name:
                continue
            if server.get("type") == "remote":
                entry: dict = {"type": "remote", "url": server.get("url", "")}
                auth_headers = server.get("headers") or server.get("env") or {}
                if auth_headers:
                    entry["headers"] = auth_headers
                config[name] = entry
            else:
                entry = {
                    "type": "local",
                    "command": server.get("command", []),
                }
                if server.get("env"):
                    entry["environment"] = server["env"]
                config[name] = entry
        return config

    def _build_prompt_request_body(
        self,
        content: str,
        model: str | None,
        opencode_message_id: str | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        """Build request body for OpenCode prompt requests."""
        request_body: dict[str, Any] = {"parts": [{"type": "text", "text": content}]}

        if opencode_message_id:
            request_body["messageID"] = opencode_message_id

        if model:
            if "/" in model:
                provider_id, model_id = model.split("/", 1)
            else:
                provider_id, model_id = "anthropic", model
            model_spec: dict[str, Any] = {
                "providerID": provider_id,
                "modelID": model_id,
            }

            if reasoning_effort:
                if provider_id == "anthropic":
                    if model_id in self.ANTHROPIC_ADAPTIVE_THINKING_MODELS:
                        anthropic_options: dict[str, Any] = {
                            "thinking": {"type": "adaptive"},
                        }
                        if reasoning_effort in self.ANTHROPIC_ADAPTIVE_EFFORTS:
                            anthropic_options["outputConfig"] = {"effort": reasoning_effort}
                        model_spec["options"] = anthropic_options
                    else:
                        budget = self.ANTHROPIC_THINKING_BUDGETS.get(reasoning_effort)
                        if budget is not None:
                            model_spec["options"] = {
                                "thinking": {"type": "enabled", "budgetTokens": budget}
                            }
                elif provider_id == "openai":
                    model_spec["options"] = {
                        "reasoningEffort": reasoning_effort,
                        "reasoningSummary": "auto",
                    }

            request_body["model"] = model_spec

        return request_body

    def _transform_part_to_event(
        self,
        part: dict[str, Any],
        message_id: str,
    ) -> dict[str, Any] | None:
        """Transform a single OpenCode part to a bridge event."""
        part_type = part.get("type")

        if part_type == "text":
            text = part.get("text", "")
            if text:
                return {
                    "type": "token",
                    "content": text,
                    "messageId": message_id,
                }
        elif part_type == "tool":
            state = part.get("state", {})
            status = state.get("status", "")
            tool_input = state.get("input", {})

            self.log.debug(
                "bridge.tool_part",
                tool=part.get("tool"),
                status=status,
            )

            if status in ("pending", "") and not tool_input:
                return None

            return {
                "type": "tool_call",
                "tool": part.get("tool", ""),
                "args": tool_input,
                "callId": part.get("callID", ""),
                "status": status,
                "output": state.get("output", ""),
                "messageId": message_id,
            }
        elif part_type == "step-finish":
            return {
                "type": "step_finish",
                "cost": part.get("cost"),
                "tokens": part.get("tokens"),
                "reason": part.get("reason"),
                "messageId": message_id,
            }
        elif part_type == "step-start":
            return {
                "type": "step_start",
                "messageId": message_id,
            }

        return None

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
        timeout_ctx: asyncio.Timeout | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse Server-Sent Events stream from OpenCode."""
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            if timeout_ctx is not None:
                timeout_ctx.reschedule(
                    asyncio.get_running_loop().time() + self._sse_inactivity_timeout
                )

            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)

                data_lines: list[str] = []
                for line in event_str.split("\n"):
                    if line.startswith("data:"):
                        data_content = line[5:].lstrip()
                        if data_content:
                            data_lines.append(data_content)

                if data_lines:
                    try:
                        raw_data = "\n".join(data_lines)
                        event = json.loads(raw_data)
                        yield event
                    except json.JSONDecodeError as e:
                        self.log.debug("bridge.sse_parse_error", exc=e)

    async def _fetch_final_message_state(
        self,
        message_id: str,
        opencode_message_id: str,
        cumulative_text: dict[str, str],
        tracked_msg_ids: set[str] | None = None,
        compaction_occurred: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        """Fetch final message state from API to ensure complete text."""
        if not self.http_client or not self._session_id:
            return

        messages_url = f"{self.base_url}/session/{self._session_id}/message"

        try:
            response = await self.http_client.get(
                messages_url,
                timeout=self.REQUEST_TIMEOUT,
            )
            if response.status_code != 200:
                self.log.warn(
                    "bridge.final_state_fetch_error",
                    status_code=response.status_code,
                )
                return

            messages = response.json()

            for msg in messages:
                info = msg.get("info", {})
                role = info.get("role", "")
                msg_id = info.get("id", "")
                parent_id = info.get("parentID", "")

                if role != "assistant":
                    continue

                parent_matches = parent_id == opencode_message_id
                in_tracked_set = tracked_msg_ids and msg_id in tracked_msg_ids
                is_compaction_summary = info.get("summary") is True

                should_accept = (
                    parent_matches
                    or in_tracked_set
                    or (compaction_occurred and not is_compaction_summary)
                )
                if not should_accept:
                    continue

                parts = msg.get("parts", [])
                for part in parts:
                    part_type = part.get("type", "")
                    part_id = part.get("id", "")

                    if part_type == "text":
                        text = part.get("text", "")
                        previously_sent = cumulative_text.get(part_id, "")
                        if len(text) > len(previously_sent):
                            self.log.debug(
                                "bridge.final_text_update",
                                prev_len=len(previously_sent),
                                new_len=len(text),
                            )
                            cumulative_text[part_id] = text
                            yield {
                                "type": "token",
                                "content": text,
                                "messageId": message_id,
                            }

        except Exception as e:
            self.log.error("bridge.final_state_error", exc=e)

    @staticmethod
    def _extract_error_message(error: object) -> str | None:
        """Extract message from OpenCode NamedError."""
        if isinstance(error, dict):
            data = error.get("data")
            if isinstance(data, dict) and "message" in data:
                return str(data["message"])
            message = error.get("message") or error.get("name")
            return str(message) if message else None
        return str(error) if error else None
