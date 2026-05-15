# Background Agent Adapter

[![CI](https://github.com/Goober-Codes/background-agent-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/Goober-Codes/background-agent-adapter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.12+-blue.svg)](https://python.org)

**Plug any coding agent into a background agent system.**

<!-- TODO: Uncomment when screenshot is captured
![Session streaming](docs/assets/session-streaming.png)
-->

This project adds a pluggable agent adapter layer to
[Open-Inspect](https://github.com/ColeMurray/background-agents) — an open-source background coding
agent platform inspired by
[Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent). The original
system was hardwired to one coding agent. This fork extracts a clean adapter interface so you can
swap in **any** coding agent by implementing 13 methods and setting one environment variable.

> **Built on** [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents). The
> control plane, web UI, bot integrations, sandbox providers, and automations system come from the
> upstream project. This fork's contribution is the **pluggable agent adapter layer**.

---

## Quick Start

```bash
git clone https://github.com/Goober-Codes/background-agent-adapter.git
cd background-agent-adapter
bash .openinspect/setup.sh          # installs deps, builds shared, sets up hooks
npm run dev -w @open-inspect/web     # start the web UI
```

For full deployment (Cloudflare + sandbox provider), see
[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

---

## What This Adds

The upstream Open-Inspect system was locked to a single coding agent (OpenCode). Swapping agents
meant rewriting the 1,700-line bridge that handles WebSocket streaming, event buffering, git push,
and sandbox coordination.

This fork extracts that into a **pluggable adapter layer**:

```
┌─────────────────────────────────────────────────────┐
│  Bridge (agent-agnostic orchestration)              │
│  WebSocket streaming, event buffering, git push,    │
│  snapshot coordination — doesn't change when you    │
│  swap agents                                        │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  AgentAdapter   │  ← 13 methods
              │  (base.py)      │
              └────────┬────────┘
                       │
           ┌───────────┼───────────┐
           │                       │
   ┌───────▼───────┐     ┌────────▼────────┐
   │   OpenCode    │     │       Pi        │
   │  HTTP server  │     │  subprocess     │
   │  (1,243 lines)│     │  stdin/stdout   │
   │               │     │  (754 lines)    │
   └───────────────┘     └─────────────────┘
```

### Bring your own agent

1. Create `adapters/my_agent.py` implementing the
   [`AgentAdapter`](packages/sandbox-runtime/src/sandbox_runtime/adapters/base.py) ABC
2. Register it in
   [`adapters/__init__.py`](packages/sandbox-runtime/src/sandbox_runtime/adapters/__init__.py)
3. Set `AGENT_ADAPTER=my_agent`

Your adapter translates between your agent's protocol and 5 standard event types. The bridge,
control plane, web UI, and bot integrations all work without changes.

See [docs/AGENT_ADAPTER.md](docs/AGENT_ADAPTER.md) for the full guide.

### Two adapters included

| Adapter      | Communication Model             | Lines | How it works                                                                     |
| ------------ | ------------------------------- | ----- | -------------------------------------------------------------------------------- |
| **OpenCode** | HTTP server on localhost        | 1,243 | Bridge makes HTTP requests, reads SSE streams. Agent runs independently.         |
| **Pi**       | Subprocess (stdin/stdout pipes) | 754   | Bridge spawns the agent, writes JSON in, reads JSON out. Agent dies with bridge. |

These two adapters prove the pattern works across fundamentally different communication models — an
HTTP server vs a child process with pipes.

---

## The Adapter Interface

Every adapter implements 13 methods, split across two processes:

**Entrypoint process** (agent lifecycle):

- `install()` — set up tools, plugins, config files
- `start()` — launch the agent process
- `get_process()` — return subprocess handle for crash detection
- `forward_logs()` — pipe agent stdout to supervisor

**Bridge subprocess** (agent communication):

- `configure()` — receive shared HTTP client and port
- `ensure_session()` — create or resume a session
- `send_prompt()` — send prompt, yield events (token, tool_call, step_start, step_finish, error)
- `stop()` — cancel current execution
- `health_check()` — is the agent alive?
- `load_session_id()` — restore session ID from disk (for snapshot restore)
- `save_session_id()` — persist session ID to disk
- `get_session_id_for_snapshot()` — return session ID for snapshot metadata
- `shutdown()` — clean up before exit

They run in two separate processes because they need independent crash/restart lifecycles. If the
WebSocket drops, the bridge restarts without killing the agent. If the agent crashes, the entrypoint
restarts it without killing the bridge.

---

## Platform Features

Everything below comes from the upstream
[Open-Inspect](https://github.com/ColeMurray/background-agents) platform and works with any adapter:

- **Background sessions** — send a prompt, close your laptop, check the PR later
- **Multiplayer** — multiple users in the same session with real-time streaming
- **Web UI** — session dashboard, model selector, terminal panel
- **Slack bot** — @mention or DM to start a session
- **GitHub bot** — auto-review PRs, respond to @mentions
- **Linear bot** — assign an issue to the agent
- **Automations** — cron schedules, Sentry alerts, inbound webhooks
- **Snapshot save/restore** — freeze sandbox state, restore instantly on follow-up
- **Sub-task spawning** — agents decompose work into parallel child sessions
- **Commit attribution** — PRs attributed to the user who sent the prompt
- **Repo secrets** — AES-256-GCM encrypted, injected as env vars
- **Multi-model** — Anthropic Claude, OpenAI, OpenCode Zen

## Architecture

```
                                    ┌──────────────────┐
                                    │     Clients      │
                                    │  Web / Slack /   │
                                    │  GitHub / Linear │
                                    │  / Webhooks      │
                                    └────────┬─────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                     Control Plane (Cloudflare)                     │
│  Durable Objects (per session) + D1 Database                       │
│  SQLite · WebSocket Hub · Event Stream · GitHub Integration        │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Sandbox (Modal / Daytona)                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Entrypoint (PID 1)                                         │  │
│  │    └─ Bridge ──▶ AgentAdapter ──▶ [Your Agent Here]         │  │
│  │                                                              │  │
│  │  Full dev environment: Node.js, Python, git, browser, VS Code│  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package                                     | Description                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| [sandbox-runtime](packages/sandbox-runtime) | **Agent adapter layer** — the ABC, adapter registry, bridge, and entrypoint |
| [server](packages/server)                   | Cloudflare Workers + Durable Objects session management                     |
| [web](packages/web)                         | Next.js web client                                                          |
| [modal-infra](packages/modal-infra)         | Modal sandbox infrastructure                                                |
| [daytona-infra](packages/daytona-infra)     | Daytona sandbox snapshot tooling                                            |
| [slack-bot](packages/slack-bot)             | Slack integration                                                           |
| [github-bot](packages/github-bot)           | GitHub integration                                                          |
| [linear-bot](packages/linear-bot)           | Linear integration                                                          |
| [shared](packages/shared)                   | Shared types and utilities                                                  |

<details>
<summary><strong>Security Model (single-tenant only)</strong></summary>

This system is designed for **single-tenant deployment only**, where all users are trusted members
of the same organization.

- **All users share the same GitHub App credentials** — the App's installation scope defines what
  the system can access
- **No per-user repository access validation** — the system does not verify per-repo permissions at
  session creation
- **User OAuth tokens are used for PR creation** — ensuring proper attribution and write-access
  enforcement

| Token Type       | Purpose                | Scope                            |
| ---------------- | ---------------------- | -------------------------------- |
| GitHub App Token | Clone repos, push code | All repos where App is installed |
| User OAuth Token | Create PRs, user info  | Repos user has access to         |
| WebSocket Token  | Real-time session auth | Single session                   |

**Deployment recommendations:**

1. Deploy behind your organization's SSO/VPN
2. Install the GitHub App only on intended repositories
3. Use GitHub's repository selection — specific repos, not "All repositories"

</details>

## Documentation

| Doc                                                 | Description                       |
| --------------------------------------------------- | --------------------------------- |
| [AGENT_ADAPTER.md](docs/AGENT_ADAPTER.md)           | **How to add a new coding agent** |
| [SETUP_GUIDE.md](docs/SETUP_GUIDE.md)               | Local development setup           |
| [GETTING_STARTED.md](docs/GETTING_STARTED.md)       | Full deployment with Terraform    |
| [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)             | Architecture deep dive            |
| [AUTOMATIONS.md](docs/AUTOMATIONS.md)               | Cron, Sentry, webhook automations |
| [SECRETS.md](docs/SECRETS.md)                       | Repo secrets management           |
| [DEBUGGING_PLAYBOOK.md](docs/DEBUGGING_PLAYBOOK.md) | Troubleshooting guide             |
| [CHANGELOG.md](CHANGELOG.md)                        | Release history                   |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
bash .openinspect/setup.sh     # one-time setup
npm run lint                   # lint all packages
npm run typecheck              # type-check all packages
npm test                       # run all tests
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built on [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents)
(Open-Inspect), with:

- [Modal](https://modal.com) — cloud sandbox infrastructure
- [Cloudflare Workers](https://workers.cloudflare.com) — edge computing
- [Daytona](https://daytona.io) — sandbox provider
- [Next.js](https://nextjs.org) — web framework

Inspired by [Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent).
