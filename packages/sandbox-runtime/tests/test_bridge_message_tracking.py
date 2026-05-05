"""
Unit tests for OpenCode adapter message handling and event transformation.

Tests _transform_part_to_event and _build_prompt_request_body on the
OpenCodeAdapter directly (not through bridge shims).
"""

import pytest

from sandbox_runtime.adapters.opencode import OpenCodeAdapter, OpenCodeIdentifier


def create_text_part(part_id: str, text: str) -> dict:
    """Create a text part."""
    return {
        "id": part_id,
        "type": "text",
        "text": text,
    }


def create_tool_part(
    call_id: str,
    tool: str,
    status: str = "pending",
    input_data: dict | None = None,
    output: str = "",
) -> dict:
    """Create a tool part."""
    return {
        "id": f"part-{call_id}",
        "type": "tool",
        "tool": tool,
        "callID": call_id,
        "state": {
            "status": status,
            "input": input_data or {},
            "output": output,
        },
    }


@pytest.fixture
def adapter() -> OpenCodeAdapter:
    """Create an OpenCodeAdapter instance for testing."""
    return OpenCodeAdapter()


class TestTransformPartToEvent:
    """Tests for _transform_part_to_event method."""

    def test_text_part_uses_provided_message_id(self, adapter: OpenCodeAdapter):
        """Text parts should use the provided message_id, not any internal ID."""
        part = create_text_part("part-1", "Hello, world!")

        event = adapter._transform_part_to_event(part, "cp-message-123")

        assert event is not None
        assert event["type"] == "token"
        assert event["content"] == "Hello, world!"
        assert event["messageId"] == "cp-message-123"

    def test_tool_part_uses_provided_message_id(self, adapter: OpenCodeAdapter):
        """Tool parts should use the provided message_id."""
        part = create_tool_part(
            call_id="call-1",
            tool="Bash",
            status="running",
            input_data={"command": "ls -la"},
        )

        event = adapter._transform_part_to_event(part, "cp-message-456")

        assert event is not None
        assert event["type"] == "tool_call"
        assert event["tool"] == "Bash"
        assert event["messageId"] == "cp-message-456"

    def test_empty_text_part_returns_none(self, adapter: OpenCodeAdapter):
        """Empty text parts should return None."""
        part = create_text_part("part-1", "")

        event = adapter._transform_part_to_event(part, "cp-message-123")

        assert event is None

    def test_pending_tool_with_no_input_returns_none(self, adapter: OpenCodeAdapter):
        """Pending tool parts with no input should return None."""
        part = create_tool_part(
            call_id="call-1",
            tool="Bash",
            status="pending",
            input_data={},
        )

        event = adapter._transform_part_to_event(part, "cp-message-123")

        assert event is None

    def test_tool_with_completed_status(self, adapter: OpenCodeAdapter):
        """Completed tool parts should include output."""
        part = create_tool_part(
            call_id="call-1",
            tool="Bash",
            status="completed",
            input_data={"command": "ls -la"},
            output="file1.txt\nfile2.txt",
        )

        event = adapter._transform_part_to_event(part, "cp-message-123")

        assert event is not None
        assert event["type"] == "tool_call"
        assert event["status"] == "completed"
        assert event["output"] == "file1.txt\nfile2.txt"

    def test_step_start_part(self, adapter: OpenCodeAdapter):
        """Step-start parts should be transformed correctly."""
        part = {"type": "step-start", "id": "step-1"}

        event = adapter._transform_part_to_event(part, "cp-message-123")

        assert event is not None
        assert event["type"] == "step_start"
        assert event["messageId"] == "cp-message-123"

    def test_step_finish_part(self, adapter: OpenCodeAdapter):
        """Step-finish parts should include cost and token info."""
        part = {
            "type": "step-finish",
            "id": "step-1",
            "cost": 0.001,
            "tokens": 150,
            "reason": "end_turn",
        }

        event = adapter._transform_part_to_event(part, "cp-message-123")

        assert event is not None
        assert event["type"] == "step_finish"
        assert event["cost"] == 0.001
        assert event["tokens"] == 150
        assert event["reason"] == "end_turn"
        assert event["messageId"] == "cp-message-123"


class TestBuildPromptRequestBody:
    """Tests for _build_prompt_request_body method."""

    def test_basic_prompt(self, adapter: OpenCodeAdapter):
        """Should build request with text content."""
        body = adapter._build_prompt_request_body("Hello", None)

        assert body["parts"] == [{"type": "text", "text": "Hello"}]
        assert "model" not in body
        assert "messageID" not in body

    def test_with_opencode_message_id(self, adapter: OpenCodeAdapter):
        """Should include messageID when provided (expects OpenCode format)."""
        opencode_id = "msg_0123456789abcdefABCDEF"
        body = adapter._build_prompt_request_body("Hello", None, opencode_id)

        assert body["messageID"] == opencode_id

    def test_with_model_short_form(self, adapter: OpenCodeAdapter):
        """Should expand short model name to provider/model."""
        body = adapter._build_prompt_request_body("Hello", "claude-haiku-4-5")

        assert body["model"] == {
            "providerID": "anthropic",
            "modelID": "claude-haiku-4-5",
        }

    def test_with_model_full_form(self, adapter: OpenCodeAdapter):
        """Should parse provider/model format."""
        body = adapter._build_prompt_request_body("Hello", "openai/gpt-4")

        assert body["model"] == {
            "providerID": "openai",
            "modelID": "gpt-4",
        }

    def test_with_all_options(self, adapter: OpenCodeAdapter):
        """Should include all options when provided."""
        opencode_id = "msg_0123456789abcdefABCDEF"
        body = adapter._build_prompt_request_body("Hello", "anthropic/claude-3-opus", opencode_id)

        assert body["parts"] == [{"type": "text", "text": "Hello"}]
        assert body["messageID"] == opencode_id
        assert body["model"] == {
            "providerID": "anthropic",
            "modelID": "claude-3-opus",
        }

    def test_with_anthropic_manual_thinking(self, adapter: OpenCodeAdapter):
        """Non-adaptive Claude models should use manual thinking budgets."""
        body = adapter._build_prompt_request_body(
            "Hello",
            "anthropic/claude-sonnet-4-5",
            reasoning_effort="max",
        )

        assert body["model"]["options"] == {"thinking": {"type": "enabled", "budgetTokens": 31_999}}

    def test_with_opus_4_6_adaptive_thinking(self, adapter: OpenCodeAdapter):
        """Opus 4.6 should use adaptive thinking instead of manual budgets."""
        body = adapter._build_prompt_request_body(
            "Hello",
            "anthropic/claude-opus-4-6",
            reasoning_effort="medium",
        )

        assert body["model"]["options"] == {
            "thinking": {"type": "adaptive"},
            "outputConfig": {"effort": "medium"},
        }

    def test_with_sonnet_4_6_adaptive_thinking(self, adapter: OpenCodeAdapter):
        """Sonnet 4.6 should use adaptive thinking instead of manual budgets."""
        body = adapter._build_prompt_request_body(
            "Hello",
            "anthropic/claude-sonnet-4-6",
            reasoning_effort="high",
        )

        assert body["model"]["options"] == {
            "thinking": {"type": "adaptive"},
            "outputConfig": {"effort": "high"},
        }


class TestOpenCodeIdentifier:
    """Tests for OpenCode-compatible ascending ID generation."""

    def test_ascending_generates_msg_prefix(self):
        """Ascending message IDs should start with 'msg_'."""
        msg_id = OpenCodeIdentifier.ascending("message")
        assert msg_id.startswith("msg_")

    def test_ascending_generates_unique_ids(self):
        """Each call should generate a unique ID."""
        ids = [OpenCodeIdentifier.ascending("message") for _ in range(100)]
        assert len(set(ids)) == 100  # All unique

    def test_ascending_ids_are_lexicographically_ordered(self):
        """IDs generated later should be lexicographically greater."""
        id1 = OpenCodeIdentifier.ascending("message")
        id2 = OpenCodeIdentifier.ascending("message")
        id3 = OpenCodeIdentifier.ascending("message")

        assert id1 < id2 < id3

    def test_ascending_generates_correct_format(self):
        """IDs should have format: prefix_timestamphex(12)random(14)."""
        msg_id = OpenCodeIdentifier.ascending("message")

        # Format: msg_XXXXXXXXXXXX... (prefix + underscore + 26 chars)
        assert msg_id.startswith("msg_")
        suffix = msg_id[4:]  # After "msg_"

        # First 12 chars should be hex (timestamp)
        timestamp_hex = suffix[:12]
        assert all(c in "0123456789abcdef" for c in timestamp_hex)

        # Next 14 chars should be base62 (random)
        random_part = suffix[12:]
        assert len(random_part) == 14
        base62_chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        assert all(c in base62_chars for c in random_part)

    def test_ascending_supports_session_prefix(self):
        """Should support 'session' prefix."""
        ses_id = OpenCodeIdentifier.ascending("session")
        assert ses_id.startswith("ses_")

    def test_ascending_supports_part_prefix(self):
        """Should support 'part' prefix."""
        part_id = OpenCodeIdentifier.ascending("part")
        assert part_id.startswith("prt_")

    def test_ascending_rejects_unknown_prefix(self):
        """Should raise ValueError for unknown prefixes."""
        with pytest.raises(ValueError, match="Unknown prefix"):
            OpenCodeIdentifier.ascending("unknown")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
