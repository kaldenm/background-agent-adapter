# sandbox-runtime

The runtime that runs inside each sandbox. Contains the supervisor, bridge, and pluggable agent
adapter layer — the main contribution of this fork.

## What's Inside

```
supervisor.py          Daemon (PID 1). Clones repo, starts agent via adapter, monitors processes.
bridge.py              WebSocket link back to the session server. Streams events, handles git push, snapshots.
adapters/
  base.py              AgentAdapter ABC — 13 methods (12 abstract + shutdown default)
  opencode.py          OpenCode adapter (HTTP server, SSE streams)
  pi.py                Pi adapter (subprocess, JSONL over stdin/stdout)
  template.py          Starter skeleton for new adapters
  __init__.py          Registry — maps AGENT_ADAPTER env var to adapter class
```

## Two-Process Architecture

The adapter is instantiated in **two separate processes** with independent lifecycles:

```
┌─────────────────────────┐     ┌─────────────────────────┐
│   Supervisor process    │     │    Bridge subprocess    │
│                         │     │                         │
│  install()              │     │  configure()            │
│  prepare()              │     │  create_session()       │
│  get_process()          │     │  send_prompt()          │
│  forward_logs()         │     │  stop()                 │
│  shutdown()             │     │  health_check()         │
│                         │     │  load/save_session_id() │
└─────────────────────────┘     └─────────────────────────┘
```

Why two processes? Independent crash recovery. If the WebSocket drops, the bridge restarts without
killing the agent. If the agent crashes, the supervisor restarts it without losing the bridge's
streaming state.

## Adding a New Adapter

1. Copy `adapters/template.py` → `adapters/my_agent.py`
2. Implement the methods (the main work is `send_prompt()` — translate your agent's events into the
   standard format)
3. Register in `adapters/__init__.py`
4. Set `AGENT_ADAPTER=my_agent`

Full guide: [docs/AGENT_ADAPTER.md](../../docs/AGENT_ADAPTER.md)

## Tests

```bash
# From this directory
uv run pytest

# Specific test
uv run pytest tests/test_pi_adapter.py -v

# With coverage
uv run pytest --cov=sandbox_runtime
```

20 test files covering bridge reconnection, event buffering, git identity, adapter behavior,
supervisor monitoring, and more.

## Key Dependencies

| Package      | Purpose                                       |
| ------------ | --------------------------------------------- |
| `httpx`      | HTTP client for server-type agents (OpenCode) |
| `websockets` | Bridge ↔ session server connection            |
| `pydantic`   | Config and event validation                   |
| `PyJWT`      | Sandbox authentication tokens                 |

Python ≥ 3.12 required.

## Project Context

This package is part of [background-agent-adapter](../../README.md). See the root README for the
full architecture and how the sandbox-runtime fits into the system.
