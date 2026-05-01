"""Tests for the Pi adapter."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.adapters import load_adapter
from sandbox_runtime.adapters.pi import PiAdapter


# ─────────────────────────────────────────────────────────────────────
# Registry
# ─────────────────────────────────────────────────────────────────���───


def test_load_pi_adapter():
    adapter = load_adapter("pi")
    assert isinstance(adapter, PiAdapter)


def test_load_adapter_unknown():
    with pytest.raises(ValueError, match="Unknown agent adapter"):
        load_adapter("nonexistent")


# ─────────────────────────────────────────────────────────────────────
# install()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_install_writes_settings(tmp_path):
    adapter = PiAdapter()
    await adapter.install(tmp_path, {"provider": "anthropic", "model": "claude-sonnet-4-20250514"})

    settings_file = tmp_path / ".pi" / "settings.json"
    assert settings_file.exists()
    config = json.loads(settings_file.read_text())
    assert config["autoCompaction"] is True
    assert config["thinkingLevel"] == "medium"


@pytest.mark.asyncio
async def test_install_creates_pi_directory(tmp_path):
    adapter = PiAdapter()
    await adapter.install(tmp_path, {})
    assert (tmp_path / ".pi").is_dir()


# ─────────────────────────────────────────────────────────────────────
# start()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_validates_binary(tmp_path):
    """start() should call pi --version to validate."""
    mock_process = AsyncMock()
    mock_process.communicate = AsyncMock(return_value=(b"1.0.0\n", b""))
    mock_process.returncode = 0

    with patch("asyncio.create_subprocess_exec", return_value=mock_process) as mock_exec:
        adapter = PiAdapter()
        await adapter.start(tmp_path, {"provider": "anthropic"})

        mock_exec.assert_called_once()
        args = mock_exec.call_args[0]
        assert args[0] == "pi"
        assert args[1] == "--version"


@pytest.mark.asyncio
async def test_start_raises_on_missing_binary(tmp_path):
    mock_process = AsyncMock()
    mock_process.communicate = AsyncMock(return_value=(b"", b"not found"))
    mock_process.returncode = 127

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        adapter = PiAdapter()
        with pytest.raises(RuntimeError, match="Pi binary not found"):
            await adapter.start(tmp_path, {})


@pytest.mark.asyncio
async def test_get_process_returns_none_before_spawn():
    adapter = PiAdapter()
    assert adapter.get_process() is None


# ─────────────────────────────────────────────────────────────────────
# Event translation
# ─────────────────────────────────────────────────────────────────────


class TestTranslateEvent:
    def setup_method(self):
        self.adapter = PiAdapter()
        self.msg_id = "msg_123"

    def test_turn_start(self):
        result = self.adapter._translate_event({"type": "turn_start"}, self.msg_id)
        assert result == {"type": "step_start", "messageId": "msg_123"}

    def test_turn_end_with_usage(self):
        event = {
            "type": "turn_end",
            "message": {
                "usage": {
                    "input": 100,
                    "output": 50,
                    "cacheRead": 40,
                    "cacheWrite": 5,
                    "cost": {"total": 0.003},
                }
            },
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["type"] == "step_finish"
        assert result["messageId"] == "msg_123"
        assert result["cost"] == 0.003
        assert result["tokens"]["input"] == 100
        assert result["tokens"]["output"] == 50

    def test_text_delta(self):
        event = {
            "type": "message_update",
            "message": {},
            "assistantMessageEvent": {"type": "text_delta", "delta": "Hello", "contentIndex": 0},
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result == {"type": "token", "content": "Hello", "messageId": "msg_123"}

    def test_thinking_delta_dropped(self):
        event = {
            "type": "message_update",
            "message": {},
            "assistantMessageEvent": {"type": "thinking_delta", "delta": "Let me think..."},
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result is None

    def test_tool_execution_start(self):
        event = {
            "type": "tool_execution_start",
            "toolCallId": "call_1",
            "toolName": "bash",
            "args": {"command": "ls"},
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["type"] == "tool_call"
        assert result["tool"] == "bash"
        assert result["status"] == "running"
        assert result["callId"] == "call_1"
        assert result["args"] == {"command": "ls"}

    def test_tool_execution_update(self):
        event = {
            "type": "tool_execution_update",
            "toolCallId": "call_1",
            "toolName": "bash",
            "args": {"command": "ls"},
            "partialResult": {"content": [{"type": "text", "text": "file1.py\n"}]},
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["type"] == "tool_call"
        assert result["status"] == "running"
        assert result["output"] == "file1.py\n"

    def test_tool_execution_end_success(self):
        event = {
            "type": "tool_execution_end",
            "toolCallId": "call_1",
            "toolName": "bash",
            "result": {"content": [{"type": "text", "text": "file1.py\nfile2.py"}]},
            "isError": False,
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["type"] == "tool_call"
        assert result["status"] == "completed"
        assert result["output"] == "file1.py\nfile2.py"

    def test_tool_execution_end_error(self):
        event = {
            "type": "tool_execution_end",
            "toolCallId": "call_1",
            "toolName": "bash",
            "result": {"content": [{"type": "text", "text": "command not found"}]},
            "isError": True,
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["status"] == "error"
        assert result["output"] == "command not found"

    def test_agent_start_dropped(self):
        result = self.adapter._translate_event({"type": "agent_start"}, self.msg_id)
        assert result is None

    def test_compaction_dropped(self):
        result = self.adapter._translate_event({"type": "compaction_start"}, self.msg_id)
        assert result is None

    def test_auto_retry_end_failure(self):
        event = {
            "type": "auto_retry_end",
            "success": False,
            "attempt": 3,
            "finalError": "529 overloaded",
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["type"] == "error"
        assert "529 overloaded" in result["error"]

    def test_auto_retry_end_success_dropped(self):
        event = {"type": "auto_retry_end", "success": True, "attempt": 2}
        result = self.adapter._translate_event(event, self.msg_id)
        assert result is None

    def test_message_update_error(self):
        event = {
            "type": "message_update",
            "message": {},
            "assistantMessageEvent": {"type": "error", "reason": "aborted"},
        }
        result = self.adapter._translate_event(event, self.msg_id)
        assert result["type"] == "error"
        assert "aborted" in result["error"]


# ─────────────────────────────────────────────────────────────────────
# Extension UI auto-approve
# ─────────────────────────────────────────────────────────────────────


class TestExtensionUI:
    def setup_method(self):
        self.adapter = PiAdapter()
        self.adapter._stdin_lock = asyncio.Lock()
        self.written: list[dict] = []

        async def mock_write(cmd):
            self.written.append(cmd)

        self.adapter._write_stdin = mock_write  # type: ignore

    @pytest.mark.asyncio
    async def test_confirm_auto_approves(self):
        await self.adapter._handle_extension_ui(
            {"type": "extension_ui_request", "id": "uuid-1", "method": "confirm", "title": "Delete?"}
        )
        assert len(self.written) == 1
        assert self.written[0]["confirmed"] is True
        assert self.written[0]["id"] == "uuid-1"

    @pytest.mark.asyncio
    async def test_select_picks_first(self):
        await self.adapter._handle_extension_ui(
            {
                "type": "extension_ui_request",
                "id": "uuid-2",
                "method": "select",
                "title": "Pick",
                "options": ["Allow", "Block", "Skip"],
            }
        )
        assert self.written[0]["value"] == "Allow"

    @pytest.mark.asyncio
    async def test_input_cancels(self):
        await self.adapter._handle_extension_ui(
            {"type": "extension_ui_request", "id": "uuid-3", "method": "input", "title": "Enter"}
        )
        assert self.written[0]["cancelled"] is True

    @pytest.mark.asyncio
    async def test_editor_cancels(self):
        await self.adapter._handle_extension_ui(
            {"type": "extension_ui_request", "id": "uuid-4", "method": "editor", "title": "Edit"}
        )
        assert self.written[0]["cancelled"] is True

    @pytest.mark.asyncio
    async def test_notify_ignored(self):
        await self.adapter._handle_extension_ui(
            {"type": "extension_ui_request", "id": "uuid-5", "method": "notify", "message": "hi"}
        )
        assert len(self.written) == 0

    @pytest.mark.asyncio
    async def test_set_status_ignored(self):
        await self.adapter._handle_extension_ui(
            {
                "type": "extension_ui_request",
                "id": "uuid-6",
                "method": "setStatus",
                "statusKey": "k",
                "statusText": "v",
            }
        )
        assert len(self.written) == 0


# ─────────────────────────────────────────────────────────────────────
# Session persistence
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_session_persistence(tmp_path, monkeypatch):
    adapter = PiAdapter()
    session_file = tmp_path / "pi-session-path"
    monkeypatch.setattr(PiAdapter, "SESSION_PATH_FILE", session_file)

    # Nothing persisted yet
    assert await adapter.load_session_id() is None

    # Save a session path (must point to an existing file)
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text("{}")
    await adapter.save_session_id(str(session_jsonl))

    # Load it back
    loaded = await adapter.load_session_id()
    assert loaded == str(session_jsonl)

    # If session file doesn't exist on disk → returns None
    session_jsonl.unlink()
    assert await adapter.load_session_id() is None


@pytest.mark.asyncio
async def test_get_session_id_for_snapshot():
    adapter = PiAdapter()
    assert adapter.get_session_id_for_snapshot() is None

    adapter._session_id = "/path/to/session.jsonl"
    assert adapter.get_session_id_for_snapshot() == "/path/to/session.jsonl"


# ─────────────────────────────────────────────────────────────────────
# Reasoning effort mapping
# ─────────────────────────────────────────────────────────────────────


def test_map_reasoning_effort():
    assert PiAdapter._map_reasoning_effort("low") == "low"
    assert PiAdapter._map_reasoning_effort("medium") == "medium"
    assert PiAdapter._map_reasoning_effort("high") == "high"
    assert PiAdapter._map_reasoning_effort("max") == "xhigh"
    assert PiAdapter._map_reasoning_effort("unknown") == "medium"


# ─────────────────────────────────────────────────────────────────────
# Text extraction
# ─────────────────────────────────────────────────────────────────────


def test_extract_text_content():
    content = [
        {"type": "text", "text": "line 1"},
        {"type": "image", "data": "..."},
        {"type": "text", "text": "line 2"},
    ]
    assert PiAdapter._extract_text_content(content) == "line 1\nline 2"


def test_extract_text_content_empty():
    assert PiAdapter._extract_text_content([]) == ""


# ─────────────────────────────────────────────────────────────────────
# shutdown()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shutdown_no_process():
    adapter = PiAdapter()
    adapter._process = None
    await adapter.shutdown()  # should not raise


@pytest.mark.asyncio
async def test_shutdown_already_dead():
    adapter = PiAdapter()
    mock_proc = MagicMock()
    mock_proc.returncode = 1
    adapter._process = mock_proc
    await adapter.shutdown()
    assert adapter._process is None


@pytest.mark.asyncio
async def test_shutdown_graceful():
    adapter = PiAdapter()

    mock_proc = MagicMock()
    mock_proc.returncode = None
    mock_proc.stdin = MagicMock()
    mock_proc.stdin.is_closing = MagicMock(return_value=False)
    mock_proc.stdin.close = MagicMock()

    wait_future = asyncio.get_event_loop().create_future()
    wait_future.set_result(None)
    mock_proc.wait = MagicMock(return_value=wait_future)

    adapter._process = mock_proc
    adapter._stdout_task = None
    adapter._stderr_task = None

    await adapter.shutdown()

    mock_proc.stdin.close.assert_called_once()
    assert adapter._process is None


# ─────────────────────────────────────────────────────────────────────
# stop()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_sends_abort():
    adapter = PiAdapter()
    adapter._stdin_lock = asyncio.Lock()
    written = []

    async def mock_write(cmd):
        written.append(cmd)

    adapter._write_stdin = mock_write  # type: ignore

    await adapter.stop("session_123")
    assert len(written) == 1
    assert written[0]["type"] == "abort"


@pytest.mark.asyncio
async def test_stop_ignores_broken_pipe():
    adapter = PiAdapter()
    adapter._stdin_lock = asyncio.Lock()

    async def mock_write(cmd):
        raise BrokenPipeError("dead")

    adapter._write_stdin = mock_write  # type: ignore

    # Should not raise
    await adapter.stop("session_123")


# ─────────────────────────────────────────────────────────────────────
# health_check()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_health_check_no_process():
    adapter = PiAdapter()
    assert await adapter.health_check() is False


@pytest.mark.asyncio
async def test_health_check_dead_process():
    adapter = PiAdapter()
    mock_proc = MagicMock()
    mock_proc.returncode = 1
    adapter._process = mock_proc
    assert await adapter.health_check() is False


@pytest.mark.asyncio
async def test_health_check_alive():
    adapter = PiAdapter()
    mock_proc = MagicMock()
    mock_proc.returncode = None
    adapter._process = mock_proc
    assert await adapter.health_check() is True


# ─────────────────────────────────────────────────────────────────────
# _read_agent_events integration
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_agent_events_until_agent_end():
    adapter = PiAdapter()
    adapter._event_queue = asyncio.Queue()

    # Simulate Pi sending events
    events = [
        {"type": "turn_start"},
        {"type": "message_update", "message": {}, "assistantMessageEvent": {"type": "text_delta", "delta": "Hi"}},
        {"type": "turn_end", "message": {"usage": {"input": 10, "output": 5, "cost": {"total": 0.001}}}},
        {"type": "agent_end", "messages": []},
    ]
    for e in events:
        await adapter._event_queue.put(e)

    collected = []
    async for bridge_event in adapter._read_agent_events("msg_1"):
        collected.append(bridge_event)

    assert len(collected) == 3
    assert collected[0] == {"type": "step_start", "messageId": "msg_1"}
    assert collected[1] == {"type": "token", "content": "Hi", "messageId": "msg_1"}
    assert collected[2]["type"] == "step_finish"


@pytest.mark.asyncio
async def test_send_prompt_emits_lifecycle_status_events():
    """Verify agent_status events flow to the web UI via send_prompt."""
    adapter = PiAdapter()
    adapter._stdin_lock = asyncio.Lock()
    adapter._event_queue = asyncio.Queue()
    adapter._response_queue = asyncio.Queue()
    adapter._process = MagicMock()
    adapter._process.returncode = None
    adapter._process.stdin = MagicMock()
    adapter._process.stdin.write = MagicMock()
    adapter._process.stdin.drain = AsyncMock()
    adapter._process.stdin.is_closing = MagicMock(return_value=False)

    # Queue lifecycle status events (normally queued during create_session)
    adapter._pending_status = [
        {"type": "agent_status", "status": "spawning", "message": "Starting Pi", "adapter": "pi"},
        {"type": "agent_status", "status": "ready", "message": "Pi ready", "adapter": "pi"},
    ]

    # Simulate Pi accepting the prompt then finishing
    await adapter._response_queue.put({"type": "response", "command": "prompt", "success": True})
    await adapter._event_queue.put({"type": "agent_end", "messages": []})

    collected = []
    async for event in adapter.send_prompt("ses_1", "hello", "msg_1"):
        collected.append(event)

    # Should see: spawning, ready, prompting status events before agent_end
    status_events = [e for e in collected if e.get("type") == "agent_status"]
    assert len(status_events) == 3
    assert status_events[0]["status"] == "spawning"
    assert status_events[1]["status"] == "ready"
    assert status_events[2]["status"] == "prompting"


@pytest.mark.asyncio
async def test_read_agent_events_eof():
    adapter = PiAdapter()
    adapter._event_queue = asyncio.Queue()

    await adapter._event_queue.put({"type": "_pi_eof"})

    collected = []
    async for bridge_event in adapter._read_agent_events("msg_1"):
        collected.append(bridge_event)

    assert len(collected) == 2
    # First: status event about crash
    assert collected[0]["type"] == "agent_status"
    assert collected[0]["status"] == "crashed"
    # Second: error event for the bridge
    assert collected[1]["type"] == "error"
    assert "exited unexpectedly" in collected[1]["error"]
