# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Pluggable agent adapter layer** — 13-method ABC interface (`AgentAdapter`) that any coding agent
  can implement to work inside the background agent sandbox
  ([`adapters/base.py`](packages/sandbox-runtime/src/sandbox_runtime/adapters/base.py))
- **Pi adapter** — full implementation for the Pi coding agent using stdin/stdout subprocess pipes,
  proving the adapter pattern works with a fundamentally different communication model than the
  original HTTP-based agent
  ([`adapters/pi.py`](packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py))
- **Adapter registry** — `load_adapter("opencode")` or `load_adapter("pi")` via one env var
  (`AGENT_ADAPTER`)
- **Agent adapter documentation** — guide for adding new agents
  ([`docs/AGENT_ADAPTER.md`](docs/AGENT_ADAPTER.md))
- **566-line Pi adapter test suite**
  ([`test_pi_adapter.py`](packages/sandbox-runtime/tests/test_pi_adapter.py))

### Changed

- **Refactored bridge** from ~1,700-line monolith with hardcoded OpenCode logic to ~870-line
  agent-agnostic orchestrator
- **Refactored entrypoint** to use adapter interface instead of direct OpenCode calls
- **Extracted OpenCode adapter** — all OpenCode-specific logic moved from bridge into
  [`adapters/opencode.py`](packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py) (1,243
  lines)
- **Cleaned up backward compatibility shims** — removed all `isinstance(OpenCodeAdapter)` checks
  from bridge, updated tests to use adapter interface directly
- **Renamed methods for clarity** — `create_session()` → `ensure_session()`, `_translate_event()` →
  `_convert_pi_event_to_standard()`, `_handle_extension_ui()` → `_auto_respond_to_dialog()`

### Upstream

Built on [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents)
(Open-Inspect), which provides the control plane, web UI, bot integrations, sandbox provider
abstraction, and automations system.
