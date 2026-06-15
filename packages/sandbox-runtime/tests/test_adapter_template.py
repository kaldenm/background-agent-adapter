"""Test template — copy this file to test your custom adapter.

Usage:
    1. cp test_adapter_template.py test_my_agent_adapter.py
    2. Replace TODO markers with your adapter's details
    3. Run: pytest test_my_agent_adapter.py -v

This template covers:
    - Supervisor lifecycle: install(), prepare(), get_process(), forward_logs()
    - Bridge communication: configure(), create_session(), send_prompt(), stop(), health_check()
    - Session persistence: load/save/get_session_id
    - Event contract validation: required fields, common mistakes
"""

import asyncio
import contextlib
from unittest.mock import MagicMock

import httpx
import pytest

# TODO: Import your adapter class and the registry loader.
# from sandbox_runtime.adapters.my_agent import MyAgentAdapter
# from sandbox_runtime.adapters import load_adapter
# For now, use the template adapter so this file parses.
# Delete these two lines once you've imported your own adapter.
from sandbox_runtime.adapters.template import TemplateAdapter as MyAgentAdapter

# [ADAPTER CHANGE] Import the event contract from bridge.py — single source of truth.
# Don't duplicate these; if the bridge adds a new required field, your tests will catch it.
from sandbox_runtime.bridge import REQUIRED_EVENT_FIELDS

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def validate_event(event: dict) -> list[str]:
    """Validate a single adapter event against the bridge's event contract.

    Returns a list of problems (empty = valid).
    """
    problems = []
    event_type = event.get("type")

    if event_type is None:
        problems.append("Event missing 'type' field")
        return problems

    # execution_complete must never come from adapters — bridge adds it.
    if event_type == "execution_complete":
        problems.append("Adapter must NOT yield execution_complete — the bridge adds it")

    required = REQUIRED_EVENT_FIELDS.get(event_type)
    if required:
        missing = [f for f in required if f not in event]
        if missing:
            problems.append(f"{event_type} missing required fields: {missing}")

    # Common mistakes — not strictly contract violations, but will break the UI.
    if event_type == "tool_call":
        status = event.get("status")
        if status not in ("running", "completed", "error", None):
            problems.append(f"tool_call has unexpected status '{status}'")

    return problems


def validate_all_events(events: list[dict]) -> list[str]:
    """Validate a sequence of events from send_prompt(). Returns all problems."""
    all_problems = []
    for i, event in enumerate(events):
        for problem in validate_event(event):
            all_problems.append(f"Event {i} ({event.get('type', '?')}): {problem}")
    return all_problems


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def adapter():
    """Create a fresh adapter instance.

    TODO: Replace with your adapter class and any constructor args.
    """
    return MyAgentAdapter()


@pytest.fixture
def session_config():
    """Example session_config dict passed to install() and prepare().

    TODO: Adjust to match what your adapter expects. Common fields:
    - provider: "anthropic" | "openai"
    - model: "claude-sonnet-4-20250514" | "gpt-4o"
    - repo_owner: "my-org"
    - repo_name: "my-repo"
    - mcp_servers: []
    """
    return {
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514",
        "repo_owner": "test-org",
        "repo_name": "test-repo",
        "mcp_servers": [],
    }


# ─────────────────────────────────────────────────────────────────────
# Registry
# ─────────────────────────────────────────────────────────────────────


# TODO: Uncomment once your adapter is registered in __init__.py.
# def test_load_adapter():
#     adapter = load_adapter("my_agent")
#     assert isinstance(adapter, MyAgentAdapter)


# ─────────────────────────────────────────────────────────────────────
# Supervisor lifecycle: install() → prepare() → get_process()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_install_creates_config(adapter, session_config, tmp_path):
    """install() should write whatever config files your agent needs.

    TODO: Implement install() first, then assert the files it creates exist.
    For example:
        await adapter.install(tmp_path, session_config)
        assert (tmp_path / ".my-agent" / "config.json").exists()
    """
    pytest.skip("TODO: implement install() and add assertions")


@pytest.mark.asyncio
async def test_install_handles_empty_config(adapter, tmp_path):
    """install() should handle missing/empty session_config gracefully."""
    pytest.skip("TODO: test install() with minimal config")


@pytest.mark.asyncio
async def test_prepare_validates_binary(adapter, session_config, tmp_path):
    """prepare() should verify the agent binary exists or server starts.

    TODO: Mock subprocess creation and verify prepare() calls your agent's
    binary (e.g., `my-agent --version` or starts a server).
    """
    pytest.skip("TODO: implement prepare() and add assertions")


@pytest.mark.asyncio
async def test_prepare_raises_on_missing_binary(adapter, session_config, tmp_path):
    """prepare() should raise RuntimeError if the agent binary is missing."""
    pytest.skip("TODO: test prepare() failure path")


def test_get_process_before_start(adapter):
    """get_process() should return None before prepare() is called."""
    assert adapter.get_process() is None


# ─────────────────────────────────────────────────────────────────────
# Bridge communication: configure() → create_session() → send_prompt()
#
# ⚠️  Remember: these methods run in a SEPARATE PROCESS from the
#     supervisor methods above. A fresh adapter instance is created.
#     State set in install()/prepare() is NOT available here.
#     To pass data between processes, use the filesystem.
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_configure_sets_up_communication(adapter):
    """configure() should establish the communication channel.

    TODO: Verify your adapter stores the http_client (server agents)
    or spawns a subprocess (subprocess agents).
    """
    http_client = httpx.AsyncClient()
    try:
        pytest.skip("TODO: implement configure() and add assertions")
        # await adapter.configure(http_client, port=8080)
    finally:
        await http_client.aclose()


@pytest.mark.asyncio
async def test_create_session_returns_id(adapter):
    """create_session() should return a non-empty session ID string.

    TODO: Mock your agent's session creation and verify the return value.
    """
    pytest.skip("TODO: implement create_session() and add assertions")
    # session_id = await adapter.create_session("/path/to/repo")
    # assert isinstance(session_id, str)
    # assert len(session_id) > 0


@pytest.mark.asyncio
async def test_stop_does_not_raise(adapter):
    """stop() should not raise even if agent is not running.

    TODO: Set up adapter state, then verify stop() handles gracefully.
    """
    pytest.skip("TODO: implement stop() and add assertions")


@pytest.mark.asyncio
async def test_health_check_no_process(adapter):
    """health_check() should return False when agent isn't running.

    TODO: Unskip this once you've implemented health_check().
    """
    try:
        result = await adapter.health_check()
    except NotImplementedError:
        pytest.skip("TODO: implement health_check()")
    assert result is False


# ─────────────────────────────────────────────────────────────────────
# Event contract validation
#
# These tests verify that send_prompt() emits events the bridge accepts.
# They validate against REQUIRED_EVENT_FIELDS imported from bridge.py —
# the same validation the bridge runs in production.
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_send_prompt_events_are_valid(adapter):
    """Every event from send_prompt() must pass the bridge's event contract.

    TODO: Set up your adapter (configure + create_session), then run
    send_prompt() and validate every event it yields.
    """
    pytest.skip("TODO: implement send_prompt() first")

    # Example pattern once your adapter works:
    #
    # events = []
    # async for event in adapter.send_prompt("ses_1", "say hello", "msg_1"):
    #     events.append(event)
    #
    # # Validate all events against the bridge contract
    # problems = validate_all_events(events)
    # assert problems == [], f"Event contract violations:\n" + "\n".join(problems)
    #
    # # Should have at least a step_start and step_finish
    # types = [e["type"] for e in events]
    # assert "step_start" in types, "send_prompt() should yield at least one step_start"


@pytest.mark.asyncio
async def test_no_execution_complete():
    """Adapters must NEVER yield execution_complete — the bridge adds it.

    This test validates the contract using the helper. If your send_prompt()
    accidentally yields execution_complete, it will be caught here.
    """
    bad_event = {"type": "execution_complete", "messageId": "msg_1"}
    problems = validate_event(bad_event)
    assert any("execution_complete" in p for p in problems)


def test_token_requires_content_and_message_id():
    """Token events must have 'content' and 'messageId'."""
    # Valid
    assert validate_event({"type": "token", "content": "hello", "messageId": "msg_1"}) == []
    # Missing content
    assert validate_event({"type": "token", "messageId": "msg_1"}) != []
    # Missing messageId
    assert validate_event({"type": "token", "content": "hello"}) != []


def test_tool_call_requires_tool_status_message_id():
    """tool_call events must have 'tool', 'status', and 'messageId'."""
    valid = {
        "type": "tool_call",
        "tool": "bash",
        "args": {"command": "ls"},
        "callId": "call_1",
        "status": "running",
        "output": "",
        "messageId": "msg_1",
    }
    assert validate_event(valid) == []

    # Missing tool
    bad = {**valid}
    del bad["tool"]
    assert validate_event(bad) != []

    # Missing status
    bad = {**valid}
    del bad["status"]
    assert validate_event(bad) != []

    # Invalid status
    bad = {**valid, "status": "in_progress"}
    problems = validate_event(bad)
    assert any("unexpected status" in p for p in problems)


def test_step_start_requires_message_id():
    """step_start events must have 'messageId'."""
    assert validate_event({"type": "step_start", "messageId": "msg_1"}) == []
    assert validate_event({"type": "step_start"}) != []


def test_step_finish_requires_message_id():
    """step_finish events must have 'messageId'."""
    valid = {
        "type": "step_finish",
        "messageId": "msg_1",
        "tokens": {"input": 10, "output": 5},
        "cost": 0.001,
    }
    assert validate_event(valid) == []
    assert validate_event({"type": "step_finish"}) != []


def test_error_requires_message_id():
    """Error events must have 'messageId'.

    Note: the bridge doesn't require 'error' in REQUIRED_EVENT_FIELDS,
    but you should always include a message. This tests the messageId requirement.
    """
    # error type is not in REQUIRED_EVENT_FIELDS — it passes through.
    # But your adapter should always include messageId for traceability.
    event = {"type": "error", "error": "something broke", "messageId": "msg_1"}
    assert validate_event(event) == []


# ─────────────────────────────────────────────────────────────────────
# Common mistakes
#
# These tests demonstrate patterns that WILL break the UI or bridge,
# even if they don't violate the strict event contract.
# ─────────────────────────────────────────────────────────────────────


def test_cumulative_not_delta_content():
    """Token content must be CUMULATIVE (full text so far), not deltas.

    The web UI deduplicates by messageId and keeps the latest content.
    If you send deltas, the UI shows only the last chunk, not the full text.

    ✅ Correct (cumulative):  "Hello" → "Hello world" → "Hello world!"
    ❌ Wrong (delta):         "Hello" → " world" → "!"
    """
    # Simulate correct cumulative behavior
    events = [
        {"type": "token", "content": "Hello", "messageId": "msg_1"},
        {"type": "token", "content": "Hello world", "messageId": "msg_1"},
        {"type": "token", "content": "Hello world!", "messageId": "msg_1"},
    ]
    # Each successive content should contain all previous content
    for i in range(1, len(events)):
        current = events[i]["content"]
        previous = events[i - 1]["content"]
        assert current.startswith(previous), (
            f"Token content appears to be deltas, not cumulative. "
            f"Event {i} content '{current}' doesn't start with previous '{previous}'. "
            f"The web UI will only show the last chunk."
        )


def test_event_must_have_type():
    """Every event dict must include a 'type' field."""
    problems = validate_event({"content": "hello", "messageId": "msg_1"})
    assert any("missing 'type'" in p for p in problems)


# ─────────────────────────────────────────────────────────────────────
# Session persistence (for snapshot save/restore)
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_session_roundtrip(adapter, tmp_path, monkeypatch):
    """save_session_id() → load_session_id() should round-trip.

    TODO: If your adapter uses a custom path, monkeypatch it to tmp_path.
    """
    session_file = tmp_path / "test-session-id"
    monkeypatch.setattr(type(adapter), "SESSION_ID_FILE", session_file)

    # Nothing persisted yet
    loaded = await adapter.load_session_id()
    assert loaded is None

    # Save and reload
    await adapter.save_session_id("ses_abc123")
    loaded = await adapter.load_session_id()
    assert loaded == "ses_abc123"


def test_get_session_id_for_snapshot_before_save(adapter):
    """get_session_id_for_snapshot() returns None before any session exists."""
    # Wipe any default file that might exist
    with contextlib.suppress(FileNotFoundError):
        adapter.SESSION_ID_FILE.unlink()
    assert adapter.get_session_id_for_snapshot() is None


# ─────────────────────────────────────────────────────────────────────
# shutdown()
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shutdown_no_process(adapter):
    """shutdown() should not raise when no process is running."""
    adapter._process = None
    await adapter.shutdown()  # should not raise


@pytest.mark.asyncio
async def test_shutdown_terminates_process(adapter):
    """shutdown() should terminate a running process."""
    mock_proc = MagicMock()
    mock_proc.returncode = None
    wait_future = asyncio.get_event_loop().create_future()
    wait_future.set_result(None)
    mock_proc.wait = MagicMock(return_value=wait_future)

    adapter._process = mock_proc
    await adapter.shutdown()
    mock_proc.terminate.assert_called_once()
