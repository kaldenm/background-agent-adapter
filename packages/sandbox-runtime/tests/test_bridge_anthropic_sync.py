"""Tests for Anthropic OAuth token sync-back from Pi."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime import bridge as bridge_module
from sandbox_runtime.bridge import AgentBridge
from tests.conftest import MockResponse


def make_bridge(monkeypatch: pytest.MonkeyPatch, refresh_token: str | None) -> AgentBridge:
    monkeypatch.delenv("ANTHROPIC_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_OAUTH_REFRESH_TOKEN", raising=False)
    if refresh_token:
        monkeypatch.setenv("ANTHROPIC_OAUTH_TOKEN", refresh_token)

    return AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        server_url="https://control.example",
        auth_token="sandbox-auth-token",
        adapter=MagicMock(),
    )


@pytest.mark.asyncio
async def test_sync_back_anthropic_token_posts_rotated_refresh_token(tmp_path, monkeypatch):
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"anthropic": {"refresh": "refresh-v2"}}))
    monkeypatch.setattr(bridge_module, "_PI_AUTH_JSON_PATHS", [auth_path])

    agent_bridge = make_bridge(monkeypatch, "refresh-v1")
    agent_bridge.http_client = MagicMock()
    agent_bridge.http_client.post = AsyncMock(return_value=MockResponse(200))

    await agent_bridge._sync_back_anthropic_token()

    agent_bridge.http_client.post.assert_awaited_once_with(
        "https://control.example/sessions/session-1/anthropic-token-sync-back",
        json={"refresh_token": "refresh-v2"},
        headers={"Authorization": "Bearer sandbox-auth-token"},
        timeout=10.0,
    )
    assert agent_bridge._original_anthropic_refresh_token == "refresh-v2"


@pytest.mark.asyncio
async def test_sync_back_anthropic_token_skips_unchanged_refresh_token(tmp_path, monkeypatch):
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"anthropic": {"refresh": "refresh-v1"}}))
    monkeypatch.setattr(bridge_module, "_PI_AUTH_JSON_PATHS", [auth_path])

    agent_bridge = make_bridge(monkeypatch, "refresh-v1")
    agent_bridge.http_client = MagicMock()
    agent_bridge.http_client.post = AsyncMock()

    await agent_bridge._sync_back_anthropic_token()

    agent_bridge.http_client.post.assert_not_awaited()
    assert agent_bridge._original_anthropic_refresh_token == "refresh-v1"


@pytest.mark.asyncio
async def test_sync_back_anthropic_token_keeps_baseline_on_failed_post(tmp_path, monkeypatch):
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"anthropic": {"refresh": "refresh-v2"}}))
    monkeypatch.setattr(bridge_module, "_PI_AUTH_JSON_PATHS", [auth_path])

    agent_bridge = make_bridge(monkeypatch, "refresh-v1")
    agent_bridge.http_client = MagicMock()
    agent_bridge.http_client.post = AsyncMock(return_value=MockResponse(500, text="nope"))

    await agent_bridge._sync_back_anthropic_token()

    agent_bridge.http_client.post.assert_awaited_once()
    assert agent_bridge._original_anthropic_refresh_token == "refresh-v1"


@pytest.mark.asyncio
async def test_sync_back_anthropic_token_skips_without_original_token(tmp_path, monkeypatch):
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"anthropic": {"refresh": "refresh-v2"}}))
    monkeypatch.setattr(bridge_module, "_PI_AUTH_JSON_PATHS", [auth_path])

    agent_bridge = make_bridge(monkeypatch, None)
    agent_bridge.http_client = MagicMock()
    agent_bridge.http_client.post = AsyncMock()

    await agent_bridge._sync_back_anthropic_token()

    agent_bridge.http_client.post.assert_not_awaited()
