"""Tests for codex auth proxy plugin deployment in OpenCodeAdapter."""

import json
import os
from pathlib import Path
from unittest.mock import patch

from sandbox_runtime.adapters.opencode import OpenCodeAdapter


def _make_adapter() -> OpenCodeAdapter:
    """Create an OpenCodeAdapter for testing."""
    return OpenCodeAdapter()


def _auth_file(tmp_path: Path) -> Path:
    """Return the expected auth.json path under tmp_path."""
    return tmp_path / ".local" / "share" / "opencode" / "auth.json"


class TestCodexAuthPluginSetup:
    """Cases for codex auth proxy plugin deployment."""

    def test_auth_json_uses_sentinel_token(self, tmp_path):
        """auth.json should contain the sentinel, not the real refresh token."""
        adapter = _make_adapter()

        with (
            patch.dict(
                "os.environ",
                {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_real_secret"},
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            adapter._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["refresh"] == "managed-by-control-plane"
        assert data["openai"]["type"] == "oauth"
        assert data["openai"]["access"] == ""
        assert data["openai"]["expires"] == 0

    def test_auth_json_still_includes_account_id(self, tmp_path):
        """Account ID should still be written if present."""
        adapter = _make_adapter()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc",
                    "OPENAI_OAUTH_ACCOUNT_ID": "acct_xyz",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            adapter._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["refresh"] == "managed-by-control-plane"
        assert data["openai"]["accountId"] == "acct_xyz"

    async def test_install_copies_js_plugin(self, tmp_path):
        """install() should deploy the precompiled JS plugin into .opencode/plugins."""
        adapter = _make_adapter()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        plugin_source = tmp_path / "app" / "sandbox_runtime" / "plugins" / "codex-auth-plugin.js"
        plugin_source.parent.mkdir(parents=True)
        plugin_source.write_text("export const CodexAuthProxy = async () => ({});")

        original_path = Path

        with (
            patch.dict(os.environ, {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_real_secret"}, clear=False),
            patch("sandbox_runtime.adapters.opencode.Path") as mock_path,
            patch("sandbox_runtime.adapters.opencode.shutil.copy") as mock_copy,
        ):
            mock_path.side_effect = lambda p: (
                plugin_source
                if p == "/app/sandbox_runtime/plugins/codex-auth-plugin.js"
                else original_path(p)
            )

            # Only test install(), not start()
            await adapter.install(workdir, {})

        mock_copy.assert_any_call(
            plugin_source,
            workdir / ".opencode" / "plugins" / "codex-auth-plugin.js",
        )
