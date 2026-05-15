"""Tests for OpenCodeAdapter._setup_openai_oauth()."""

import json
import os
from unittest.mock import patch

from sandbox_runtime.adapters.opencode import OpenCodeAdapter


def _make_adapter() -> OpenCodeAdapter:
    """Create an OpenCodeAdapter for testing."""
    return OpenCodeAdapter()


def _auth_file(tmp_path):
    """Return the expected auth.json path under tmp_path."""
    return tmp_path / ".local" / "share" / "opencode" / "auth.json"


class TestOpenaiOauthSetup:
    """Cases for _setup_openai_oauth()."""

    def test_writes_auth_json_when_refresh_token_present(self, tmp_path):
        adapter = _make_adapter()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            adapter._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data == {
            "openai": {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }
        }

    def test_includes_account_id_when_present(self, tmp_path):
        adapter = _make_adapter()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123",
                    "OPENAI_OAUTH_ACCOUNT_ID": "acct_xyz",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            adapter._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["accountId"] == "acct_xyz"

    def test_skips_when_no_refresh_token(self, tmp_path, monkeypatch):
        adapter = _make_adapter()

        # Explicitly remove the key so it is absent regardless of test ordering
        monkeypatch.delenv("OPENAI_OAUTH_REFRESH_TOKEN", raising=False)

        with patch("pathlib.Path.home", return_value=tmp_path):
            adapter._setup_openai_oauth()

        assert not _auth_file(tmp_path).exists()

    def test_sets_secure_permissions(self, tmp_path):
        adapter = _make_adapter()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            adapter._setup_openai_oauth()

        mode = _auth_file(tmp_path).stat().st_mode & 0o777
        assert mode == 0o600

    def test_does_not_crash_on_write_failure(self, tmp_path):
        adapter = _make_adapter()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=OSError("disk full")),
        ):
            adapter._setup_openai_oauth()

    def test_no_temp_file_left_on_write_failure(self, tmp_path):
        adapter = _make_adapter()
        original_open = os.open

        def fail_on_tmp(path, *args, **kwargs):
            if ".auth.json.tmp" in path:
                raise OSError("disk full")
            return original_open(path, *args, **kwargs)

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=fail_on_tmp),
        ):
            adapter._setup_openai_oauth()

        auth_dir = tmp_path / ".local" / "share" / "opencode"
        tmp_file = auth_dir / ".auth.json.tmp"
        assert not tmp_file.exists()
