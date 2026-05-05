"""Pi coding agent adapter.

Implements the AgentAdapter interface for Pi (@mariozechner/pi-coding-agent).

Pi runs in RPC mode as a subprocess communicating via JSONL over stdin/stdout.
Unlike OpenCode (HTTP server + SSE), the bridge owns the Pi process directly.

Architecture:
- Entrypoint: install() writes .pi/ config, start() validates binary only
- Bridge: configure() spawns Pi subprocess, send_prompt() reads JSONL events
"""

import asyncio
import json
import os
import shutil
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx

from ..log_config import get_logger
from .base import AgentAdapter


class PiAdapter(AgentAdapter):
    """Pi agent adapter using stdin/stdout JSONL RPC protocol."""

    # No HTTP port — Pi uses pipes
    PORT = 0

    # Timeouts (seconds)
    STARTUP_TIMEOUT = 30.0
    COMMAND_RESPONSE_TIMEOUT = 10.0
    INACTIVITY_TIMEOUT = 120.0
    HEALTH_CHECK_TIMEOUT = 2.0
    GRACEFUL_SHUTDOWN_TIMEOUT = 5.0
    FORCE_KILL_TIMEOUT = 5.0

    # Session persistence
    SESSION_PATH_FILE = Path("/tmp/pi-session-path")

    def __init__(self) -> None:
        self.log = get_logger("pi_adapter", service="sandbox")
        self._process: asyncio.subprocess.Process | None = None
        self._workdir: Path | None = None
        self._provider: str = "anthropic"
        self._model: str = "claude-sonnet-4-20250514"
        self._session_id: str | None = None
        self._session_config: dict = {}

        # Concurrency controls (initialized in configure)
        # Pi sends both streaming events AND command responses on the same stdout pipe.
        # Two queues separate them so commands don't get stuck behind streaming events.
        self._stdin_lock: asyncio.Lock | None = None
        self._event_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._response_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._stdout_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None

        # Lifecycle status events queued for next send_prompt() to emit
        self._pending_status: list[dict[str, Any]] = []

    # ─────────────────────────────────────────────────────────────────────
    # Entrypoint process methods (agent lifecycle)
    # ─────────────────────────────────────────────────────────────────────

    async def install(self, workdir: Path, session_config: dict) -> None:
        """Write Pi configuration files and install skills."""
        self._workdir = workdir
        self._session_config = session_config
        self._provider = session_config.get("provider", "anthropic")
        self._model = session_config.get("model", "claude-sonnet-4-20250514")

        pi_dir = workdir / ".pi"
        pi_dir.mkdir(parents=True, exist_ok=True)

        # Write settings
        settings: dict[str, Any] = {
            "thinkingLevel": "medium",
            "autoCompaction": True,
            "steeringMode": "one-at-a-time",
            "followUpMode": "one-at-a-time",
        }
        (pi_dir / "settings.json").write_text(json.dumps(settings, indent=2))

        # Install skills (same SKILL.md format as OpenCode)
        self._install_skills(workdir)

        # Install bin scripts (agent-agnostic CLI tools)
        self._install_bin_scripts()

        self.log.info("pi.install_complete", workdir=str(workdir))

    async def start(self, workdir: Path, session_config: dict) -> None:
        """Validate Pi binary exists. Does NOT actually start Pi.

        Pi is spawned later in ensure_session() because it needs to know
        whether to resume or start fresh (which depends on load_session_id
        running first). This method just confirms the binary is installed.
        """
        self._workdir = workdir
        self._session_config = session_config
        self._provider = session_config.get("provider", "anthropic")
        self._model = session_config.get("model", "claude-sonnet-4-20250514")

        # Validate binary exists
        result = await asyncio.create_subprocess_exec(
            "pi", "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await result.communicate()
        if result.returncode != 0:
            raise RuntimeError(
                f"Pi binary not found or not working (exit {result.returncode}): "
                f"{stderr.decode().strip()}"
            )

        self.log.info("pi.validated", version=stdout.decode().strip())

    def get_process(self) -> "asyncio.subprocess.Process | None":
        """Return None in entrypoint — bridge owns the Pi process."""
        return self._process

    async def forward_logs(self) -> None:
        """No-op in entrypoint. Bridge handles Pi's stderr directly."""
        pass

    # ─────────────────────────────────────────────────────────────────────
    # Bridge subprocess methods (agent communication)
    # The bridge never sees Pi's raw stdout — only clean standard events
    # (token, tool_call, etc.) that come out of send_prompt(). All the dirty
    # work of reading pipes, matching command IDs, sorting queues happens here
    # in the adapter, invisible to the bridge.
    # ─────────────────────────────────────────────────────────────────────

    def configure(self, http_client: httpx.AsyncClient, port: int) -> None:
        """Initialize for bridge communication. Pi ignores http_client and port.

        Pi subprocess is spawned lazily on first ensure_session() call,
        because we need to know if there's a session to restore first
        (load_session_id runs after configure in the bridge).
        """
        # Read config from environment (bridge is a separate process)
        self._provider = os.environ.get("PI_PROVIDER", os.environ.get("AGENT_PROVIDER", "anthropic"))
        self._model = os.environ.get("PI_MODEL", os.environ.get("AGENT_MODEL", "claude-sonnet-4-20250514"))

        # Workspace path
        workspace = os.environ.get("WORKSPACE_PATH", "/workspace")
        repo_dirs = list(Path(workspace).glob("*/.git"))
        if repo_dirs:
            self._workdir = repo_dirs[0].parent
        else:
            self._workdir = Path(workspace)

        # Initialize concurrency primitives
        self._stdin_lock = asyncio.Lock()
        self._event_queue = asyncio.Queue()
        self._response_queue = asyncio.Queue()

    async def ensure_session(self, repo_path: str) -> str:
        """Spawn Pi if needed, return session ID.

        May resume an existing session (if load_session_id found one on disk)
        or create a fresh one. The bridge doesn't care which — it just wants
        a session ID back.
        """
        if not self._process or self._process.returncode is not None:
            self.log.info("pi.creating_session", repo_path=repo_path)
            self._pending_status.append(
                self._make_status_event("spawning", f"Starting Pi ({self._provider}/{self._model})")
            )
            await self._spawn_pi(session_path=self._session_id)
            self._pending_status.append(
                self._make_status_event("ready", "Pi process ready")
            )

        # Query Pi for state to get session file path
        state = await self._send_command({"type": "get_state"})
        session_file = state.get("data", {}).get("sessionFile")

        if not session_file:
            # No session — explicitly not passing --no-session should create one,
            # but if it didn't, create one
            await self._send_command({"type": "new_session"})
            state = await self._send_command({"type": "get_state"})
            session_file = state.get("data", {}).get("sessionFile")

        self._session_id = session_file or str(uuid.uuid4())
        await self.save_session_id(self._session_id)
        self._pending_status.append(
            self._make_status_event("session_active", f"Session: {self._session_id}")
        )
        self.log.info("pi.session_created", session_id=self._session_id)
        return self._session_id

    async def send_prompt(
        self,
        session_id: str,
        content: str,
        message_id: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Send prompt to Pi, yield translated events.

        MUST NOT yield execution_complete — the bridge handles that.
        """
        # Drain any lifecycle status events queued during ensure_session/spawn.
        # These happened BEFORE the prompt, but ensure_session() returns a string
        # (not a stream), so this is the first chance to emit them. The user sees
        # them in order (spawning → ready → prompting) so it looks correct in the UI.
        while self._pending_status:
            yield self._pending_status.pop(0)

        # Emit agent_status so web UI can show Pi is working.
        # Status events are NOT one of the 5 core event types (token, tool_call, etc.)
        # — they're a bonus type the bridge passes through without validating.
        # No translation needed; they're created directly in the standard format.
        yield self._make_status_event("prompting", f"Sending prompt to Pi ({self._model})")
        # Switch model if requested
        if model:
            provider, _, model_id = model.partition("/")
            if not model_id:
                model_id = provider
                provider = self._provider
            try:
                await self._send_command(
                    {"type": "set_model", "provider": provider, "modelId": model_id}
                )
                yield self._make_status_event("model_switched", f"Model: {provider}/{model_id}")
            except Exception as e:
                self.log.warn("pi.set_model_failed", model=model, exc=e)

        # Set thinking level if requested
        if reasoning_effort:
            level = self._map_reasoning_effort(reasoning_effort)
            try:
                await self._send_command({"type": "set_thinking_level", "level": level})
                yield self._make_status_event("thinking_set", f"Thinking: {level}")
            except Exception as e:
                self.log.warn("pi.set_thinking_failed", level=level, exc=e)

        # Send the prompt
        try:
            await self._write_stdin({"type": "prompt", "message": content})
        except (BrokenPipeError, OSError, ConnectionResetError) as e:
            yield {"type": "error", "error": f"Pi process died: {e}", "messageId": message_id}
            return

        # Wait for prompt acceptance response
        try:
            response = await asyncio.wait_for(
                self._response_queue.get(), timeout=self.COMMAND_RESPONSE_TIMEOUT
            )
            if not response.get("success"):
                error = response.get("error", "Prompt rejected")
                yield {"type": "error", "error": error, "messageId": message_id}
                return
        except TimeoutError:
            yield {"type": "error", "error": "Pi did not acknowledge prompt", "messageId": message_id}
            return

        # Stream events until agent_end
        async for event in self._read_agent_events(message_id):
            yield event

    async def stop(self, session_id: str) -> None:
        """Send abort command to Pi."""
        try:
            await self._write_stdin({"type": "abort"})
        except (BrokenPipeError, OSError):
            pass  # Pi already dead

    async def health_check(self) -> bool:
        """Check if Pi process is alive."""
        if not self._process or self._process.returncode is not None:
            return False
        return True

    async def load_session_id(self) -> str | None:
        """Load persisted session file path."""
        if not self.SESSION_PATH_FILE.exists():
            return None
        path = self.SESSION_PATH_FILE.read_text().strip()
        if not path:
            return None
        # Session file must exist on disk for restore to work
        if Path(path).exists():
            self._session_id = path
            return path
        return None

    async def save_session_id(self, session_id: str) -> None:
        """Persist session file path to disk."""
        self._session_id = session_id
        try:
            self.SESSION_PATH_FILE.write_text(session_id)
        except (OSError, PermissionError) as e:
            self.log.error("pi.save_session_error", exc=e)

    def get_session_id_for_snapshot(self) -> str | None:
        """Return session file path for snapshot metadata."""
        return self._session_id

    async def shutdown(self) -> None:
        """Gracefully shut down Pi process."""
        proc = self._process
        if not proc or proc.returncode is not None:
            self._process = None
            return

        # Close stdin — signals Pi to exit cleanly
        if proc.stdin and not proc.stdin.is_closing():
            proc.stdin.close()

        try:
            await asyncio.wait_for(proc.wait(), timeout=self.GRACEFUL_SHUTDOWN_TIMEOUT)
        except TimeoutError:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=self.FORCE_KILL_TIMEOUT)
            except TimeoutError:
                proc.kill()
                await proc.wait()

        # Cancel reader tasks
        if self._stdout_task and not self._stdout_task.done():
            self._stdout_task.cancel()
        if self._stderr_task and not self._stderr_task.done():
            self._stderr_task.cancel()

        self._process = None
        self.log.info("pi.shutdown_complete")

    # ─────────────────────────────────────────────────────────────────────
    # Internal: Process management
    # ─────────────────────────────────────────────────────────────────────

    async def _spawn_pi(self, session_path: str | None = None) -> None:
        """Spawn Pi subprocess in RPC mode."""
        cmd = ["pi", "--mode", "rpc", "--provider", self._provider, "--model", self._model]

        if session_path and Path(session_path).exists():
            cmd.extend(["--session", session_path, "-c"])
            self.log.info("pi.spawn_with_session", session_path=session_path)
        else:
            cmd.append("--no-session")
            self.log.info("pi.spawn_fresh")

        env = self._build_env()

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._workdir,
            env=env,
        )

        # Reset queues
        self._event_queue = asyncio.Queue()
        self._response_queue = asyncio.Queue()

        # Start reader tasks
        self._stdout_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._forward_stderr())

        # Wait for Pi to be ready — send get_state and expect a response
        try:
            state = await asyncio.wait_for(
                self._send_command({"type": "get_state"}),
                timeout=self.STARTUP_TIMEOUT,
            )
            if not state.get("success"):
                raise RuntimeError(f"Pi failed to start: {state.get('error')}")
            self.log.info("pi.ready")
        except TimeoutError:
            raise RuntimeError(f"Pi did not become ready within {self.STARTUP_TIMEOUT}s")

    def _build_env(self) -> dict[str, str]:
        """Build environment variables for Pi process."""
        env = {**os.environ}
        # Pi reads API keys from standard env vars
        # ANTHROPIC_API_KEY, OPENAI_API_KEY, etc. are already in os.environ
        return env

    # ─────────────────────────────────────────────────────────────────────
    # Internal: stdin/stdout protocol
    # ─────────────────────────────────────────────────────────────────────

    async def _write_stdin(self, cmd: dict[str, Any]) -> None:
        """Write a JSON command to Pi's stdin.

        Lock prevents interleaved writes — without it, two concurrent writes
        (e.g. a prompt and an abort) could garble each other's JSON lines.
        """
        if not self._process or not self._process.stdin:
            raise BrokenPipeError("Pi process not running")

        async with self._stdin_lock:
            line = json.dumps(cmd) + "\n"
            self._process.stdin.write(line.encode())
            await self._process.stdin.drain()

    async def _send_command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        """Send an internal control command to Pi and wait for its response.

        Commands are NOT prompts. They're short admin messages the adapter sends
        to configure Pi before/during work: "change model", "get state",
        "set thinking level", "new session". The user never sees these.

        Why the adapter handles model changes: because the bridge doesn't know
        HOW to tell Pi to change models (it's Pi-specific protocol). The bridge
        just passes model/reasoning_effort to send_prompt(), and the adapter
        translates that into the right commands for this specific agent.

        Pi's RPC protocol: each command gets a unique ID. Responses come back
        with the same ID. We wait on _response_queue and keep checking: is this
        response's ID my ID? If not, put it back for someone else. When we find
        our match, return it.
        """
        req_id = f"req-{uuid.uuid4().hex[:8]}"
        cmd_with_id = {**cmd, "id": req_id}
        await self._write_stdin(cmd_with_id)

        # Wait for response with matching ID
        deadline = asyncio.get_event_loop().time() + self.COMMAND_RESPONSE_TIMEOUT
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"No response for command {cmd.get('type')} (id={req_id})")

            response = await asyncio.wait_for(
                self._response_queue.get(), timeout=remaining
            )

            if response.get("id") == req_id:
                return response

            # Not our response — put it back for someone else
            await self._response_queue.put(response)
            # Brief yield to avoid tight loop
            await asyncio.sleep(0.001)

    async def _read_stdout(self) -> None:
        """Read JSONL from Pi's stdout, route to appropriate queue.

        Runs as a background task. Every line Pi writes to stdout gets parsed
        and sorted: 'response' type → _response_queue (for _send_command),
        'extension_ui_request' → auto-approve, everything else → _event_queue
        (for send_prompt to yield as translated events).
        """
        if not self._process or not self._process.stdout:
            return

        buffer = ""
        try:
            while True:
                chunk = await self._process.stdout.read(8192)
                if not chunk:
                    break  # EOF — process exited

                buffer += chunk.decode()
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        self.log.warn("pi.stdout_parse_error", line=line[:200])
                        continue

                    event_type = event.get("type")

                    if event_type == "response":
                        await self._response_queue.put(event)
                    elif event_type == "extension_ui_request":
                        # Auto-approve in background — don't block the reader
                        asyncio.create_task(self._auto_respond_to_dialog(event))
                    else:
                        await self._event_queue.put(event)

        except Exception as e:
            self.log.warn("pi.stdout_reader_error", exc=e)

        # Signal crash to any waiting consumer
        await self._event_queue.put({"type": "_pi_eof"})

    async def _forward_stderr(self) -> None:
        """Forward Pi's stderr to supervisor stdout (logs)."""
        if not self._process or not self._process.stderr:
            return

        try:
            async for line in self._process.stderr:
                print(f"[pi] {line.decode().rstrip()}")
        except Exception:
            pass

    # ─────────────────────────────────────────────────────────────────────
    # Internal: Event translation
    # ─────────────────────────────────────────────────────────────────────

    async def _read_agent_events(self, message_id: str) -> AsyncIterator[dict[str, Any]]:
        """Read events from queue until agent_end, translating to bridge format."""
        while True:
            try:
                event = await asyncio.wait_for(
                    self._event_queue.get(), timeout=self.INACTIVITY_TIMEOUT
                )
            except TimeoutError:
                yield {
                    "type": "error",
                    "error": f"Pi unresponsive for {self.INACTIVITY_TIMEOUT}s",
                    "messageId": message_id,
                }
                return

            event_type = event.get("type")

            # EOF — process died
            if event_type == "_pi_eof":
                yield self._make_status_event("crashed", "Pi process exited unexpectedly")
                yield {
                    "type": "error",
                    "error": "Pi process exited unexpectedly",
                    "messageId": message_id,
                }
                return

            # Agent done
            if event_type == "agent_end":
                return

            # Translate and yield
            bridge_event = self._convert_pi_event_to_standard(event, message_id)
            if bridge_event:
                yield bridge_event

    def _convert_pi_event_to_standard(self, event: dict[str, Any], message_id: str) -> dict[str, Any] | None:
        """Convert a Pi-native event to a standard bridge event (or None to drop).

        Pi emits ~15 event types. The control plane only understands 5.
        If the event carries info the user/control plane needs, convert it.
        If not, return None and it gets silently dropped.
        """
        event_type = event.get("type")

        if event_type == "turn_start":
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
                    "cacheRead": usage.get("cacheRead", 0),
                    "cacheWrite": usage.get("cacheWrite", 0),
                },
                "cost": cost_info.get("total", 0) if isinstance(cost_info, dict) else 0,
            }

        elif event_type == "message_update":
            return self._translate_message_update(event, message_id)

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

        elif event_type == "tool_execution_update":
            partial = event.get("partialResult", {})
            output = self._extract_text_content(partial.get("content", []))
            return {
                "type": "tool_call",
                "tool": event.get("toolName", ""),
                "args": event.get("args", {}),
                "callId": event.get("toolCallId", ""),
                "status": "running",
                "output": output,
                "messageId": message_id,
            }

        elif event_type == "tool_execution_end":
            result = event.get("result", {})
            output = self._extract_text_content(result.get("content", []))
            status = "error" if event.get("isError") else "completed"
            return {
                "type": "tool_call",
                "tool": event.get("toolName", ""),
                "args": event.get("args", {}),
                "callId": event.get("toolCallId", ""),
                "status": status,
                "output": output,
                "messageId": message_id,
            }

        elif event_type == "auto_retry_end":
            if not event.get("success"):
                return {
                    "type": "error",
                    "error": event.get("finalError", "Auto-retry failed"),
                    "messageId": message_id,
                }

        # Events we intentionally drop:
        # agent_start, message_start, message_end, queue_update,
        # compaction_start, compaction_end, auto_retry_start, extension_error
        return None

    def _translate_message_update(self, event: dict[str, Any], message_id: str) -> dict[str, Any] | None:
        """Translate message_update events (streaming text/thinking/tool deltas)."""
        ame = event.get("assistantMessageEvent", {})
        delta_type = ame.get("type")

        if delta_type == "text_delta":
            delta = ame.get("delta", "")
            return {"type": "token", "content": delta, "messageId": message_id}

        elif delta_type == "error":
            reason = ame.get("reason", "unknown")
            return {"type": "error", "error": f"Pi error: {reason}", "messageId": message_id}

        # thinking_delta, toolcall_delta, start, text_start, text_end, etc. — drop
        return None

    # ─────────────────────────────────────────────────────────────────────
    # Internal: Extension UI auto-approve
    # ─────────────────────────────────────────────────────────────────────

    async def _auto_respond_to_dialog(self, request: dict[str, Any]) -> None:
        """Auto-respond to Pi's dialog popups so it doesn't hang.

        Pi extensions can ask questions (confirm, select, input). In a normal
        terminal, a human answers. In a sandbox there's no human — if nobody
        responds, Pi hangs forever. So we auto-respond:
        - confirm → yes
        - select → pick first option
        - input/editor → cancel (can't fake meaningful text)
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
            value = options[0] if options else ""
            response = {"type": "extension_ui_response", "id": req_id, "value": value}
        elif method in ("input", "editor"):
            # Can't auto-generate meaningful text — cancel
            response = {"type": "extension_ui_response", "id": req_id, "cancelled": True}
        else:
            # Unknown method — cancel to unblock
            response = {"type": "extension_ui_response", "id": req_id, "cancelled": True}

        try:
            await self._write_stdin(response)
        except (BrokenPipeError, OSError):
            pass  # Pi already dead

    # ─────────────────────────────────────────────────────────────────────
    # Internal: Helpers
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _make_status_event(status: str, message: str) -> dict[str, Any]:
        """Create an agent_status event for lifecycle visibility."""
        return {
            "type": "agent_status",
            "status": status,
            "message": message,
            "adapter": "pi",
        }

    @staticmethod
    def _extract_text_content(content: list[dict[str, Any]]) -> str:
        """Extract text from Pi's content array format."""
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)

    @staticmethod
    def _map_reasoning_effort(effort: str) -> str:
        """Map Open-Inspect reasoning effort to Pi thinking level."""
        mapping = {
            "low": "low",
            "medium": "medium",
            "high": "high",
            "max": "xhigh",
        }
        return mapping.get(effort, "medium")

    def _install_skills(self, workdir: Path) -> None:
        """Copy bundled skills into .pi/agent/skills/ directory."""
        skills_dir = Path("/app/sandbox_runtime/skills")
        if not skills_dir.is_dir():
            return

        # Pi looks for skills in .pi/agent/skills/ at project level
        skills_dest = workdir / ".pi" / "agent" / "skills"
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
            self.log.info("pi.skills_installed", skills_path=str(skills_dest))

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
