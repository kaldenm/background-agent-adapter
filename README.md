# Background Agent Adapter

[![CI](https://github.com/Goober-Codes/background-agent-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/Goober-Codes/background-agent-adapter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.12+-blue.svg)](https://python.org)

**Plug any coding agent into a background agent system.**

This project adds a pluggable agent adapter layer and architectural cleanup to
[Open-Inspect](https://github.com/ColeMurray/background-agents) — an open-source background coding
agent platform inspired by
[Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent). The original
system was hardwired to one coding agent with duplicated logic scattered across files. This fork
extracts clean primitives: a pluggable adapter interface, a single-door scheduler, a session server
for browser communication, and an agent-agnostic supervisor.

> **Built on** [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents). The
> web UI, bot integrations, sandbox providers, and automations system come from the upstream
> project.

---

## Quick Start

```bash
git clone https://github.com/Goober-Codes/background-agent-adapter.git
cd background-agent-adapter
bash .openinspect/setup.sh          # installs deps, builds shared, sets up hooks
npm test                             # verify everything works
npm run dev -w @open-inspect/web     # start the web UI
```

> This builds the project and starts the web UI dev server. To actually create sessions and run
> agents, you'll need a configured backend — see the [Setup Guide](docs/SETUP_GUIDE.md) for local
> development or [Getting Started](docs/GETTING_STARTED.md) for full deployment.

---

## How It Works

```
Scheduler → creates Session → spawns Sandbox → Supervisor boots
  → starts Agent (via Adapter) → starts Bridge → connects back to Session
  → browsers connect to Session → events flow both ways
```

Five primitives run the system:

| Primitive      | File(s)                                                        | Role                                                                                           |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Scheduler**  | `packages/server/src/scheduler/scheduler.ts`                   | Manager of the server. Decides what runs. Single door for all session creation.                |
| **Session**    | `packages/server/src/session/session.ts` + `session-server.ts` | The conversation. Persistent object on Cloudflare. Owns state, connects agent to browsers.     |
| **Supervisor** | `packages/sandbox-runtime/src/sandbox_runtime/supervisor.py`   | Manager of the sandbox. Runs inside the VM. Starts and monitors agent, bridge, and sidecars.   |
| **Adapter**    | `packages/sandbox-runtime/src/sandbox_runtime/adapters/`       | The plug. Makes supervisor + bridge agent-agnostic. Swap agents by implementing one interface. |
| **Bridge**     | `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`       | WebSocket connection back to session. Streams events, handles git push, snapshots.             |

### The flow in detail

1. **Something triggers work** — a user sends a prompt in the web UI, a bot gets mentioned, an
   automation fires. All paths call `dispatchToScheduler()`.

2. **Scheduler creates a session** — calls the shared `createSession()` function. One function, one
   path, replaces three copy-pasted versions from the original codebase.

3. **Session spawns a sandbox** — the session is a persistent object on Cloudflare. It calls Modal
   or Daytona to create a VM. The session stays alive, holding WebSocket connections and state,
   while the sandbox runs.

4. **Supervisor boots inside the sandbox** — clones the repo, runs setup/start hooks, starts the
   agent via `adapter.install()` → `adapter.prepare()`, then starts the bridge.

5. **Bridge connects back to session** — opens a WebSocket to
   `wss://server/sessions/{id}/ws?type=sandbox`. Events from the agent flow through the bridge into
   the session.

6. **Session broadcasts to browsers** — `SessionServer.emit()` pushes events to every connected
   browser. `SessionServer.meta()` catches up latecomers with replay data.

---

## What This Fork Adds

### 1. Pluggable Agent Adapter

The upstream system was locked to a single coding agent (OpenCode). Swapping agents meant rewriting
a 1,700-line bridge. This fork extracts a clean adapter interface:

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
   │               │     │  (846 lines)    │
   └───────────────┘     └─────────────────┘
```

#### Bring your own agent

1. Create `adapters/my_agent.py` implementing the
   [`AgentAdapter`](packages/sandbox-runtime/src/sandbox_runtime/adapters/base.py) ABC
2. Register it in
   [`adapters/__init__.py`](packages/sandbox-runtime/src/sandbox_runtime/adapters/__init__.py)
3. Set `AGENT_ADAPTER=my_agent`

See [docs/AGENT_ADAPTER.md](docs/AGENT_ADAPTER.md) for the full guide. Start from the
[adapter template](packages/sandbox-runtime/src/sandbox_runtime/adapters/template.py).

#### Two adapters included

| Adapter                                                   | Communication Model             | Lines | How it works                                                                |
| --------------------------------------------------------- | ------------------------------- | ----- | --------------------------------------------------------------------------- |
| **OpenCode**                                              | HTTP server on localhost        | 1,243 | Bridge makes HTTP requests, reads SSE streams. Agent runs independently.    |
| **[Pi](https://github.com/mariozechner/pi-coding-agent)** | Subprocess (stdin/stdout pipes) | 846   | Bridge spawns the agent in `configure()`, writes JSONL in, reads JSONL out. |

### 2. Scheduler Single Door

All session creation goes through one endpoint: `/scheduler/dispatch`. Before, bots and the web UI
each created sessions independently with different orderings and quirks. Now:

```
Bot/Web/Cron
    │
    ▼
dispatchToScheduler() ──POST──▶ Scheduler
                                    │
                                    ▼
                              createSession()  ← one shared function
```

- **One shared `createSession()`** replaces three copy-pasted versions
- **Bots don't know about sessions** — they describe what they want, the scheduler handles it
- **The scheduler always knows what's running** — concurrency enforcement, prioritization

### 3. Session Cleanup

The session Durable Object went from 1,770 lines to 990 lines:

- **SessionServer handles browser communication** — `emit()`, `meta()`, `replay()`. The session
  delegates instead of duplicating.
- **Service wiring extracted to factory** — 17 lazy getters moved to `create-services.ts`. The
  session has one services getter instead of seventeen.
- **Class renamed** `SessionDO` → `Session`. File renamed `durable-object.ts` → `session.ts`.

### 4. Agent-Agnostic Supervisor

The entrypoint was renamed to `supervisor.py` and stripped of all agent-specific knowledge:

- **1,398 → 1,046 lines** — deleted 8 OpenCode-specific methods (~250 lines of duplicated logic)
- **Zero `isinstance` checks** — calls `adapter.install()` → `adapter.prepare()`, that's it
- **Zero agent imports** — doesn't know what agent is running

---

## The Adapter Interface

Every adapter implements 13 methods (12 abstract + `shutdown()` with a default), split across two
processes:

**Supervisor process** (agent lifecycle):

- `install()` — set up tools, plugins, config files
- `prepare()` — launch the agent process or validate binary
- `get_process()` — return subprocess handle for crash detection
- `forward_logs()` — pipe agent stdout to supervisor
- `shutdown()` — terminate the agent process

**Bridge subprocess** (agent communication):

- `configure()` — establish communication channel (HTTP client or spawn subprocess)
- `create_session()` — create a new agent session, return session ID
- `send_prompt()` — send prompt, yield events (token, tool_call, step_start, step_finish, error)
- `stop()` — cancel current execution
- `health_check()` — is the agent alive?
- `load_session_id()` — restore session ID from disk (for snapshot restore)
- `save_session_id()` — persist session ID to disk
- `get_session_id_for_snapshot()` — return session ID for snapshot metadata

They run in two separate processes because they need independent crash/restart lifecycles. If the
WebSocket drops, the bridge restarts without killing the agent. If the agent crashes, the supervisor
restarts it without killing the bridge.

---

## Architecture

```
                                    ┌──────────────────┐
                                    │     Clients      │
                                    │  Web / Slack /   │
                                    │  GitHub / Linear │
                                    │  / Webhooks      │
                                    └────────┬─────────┘
                                             │
                                     dispatchToScheduler()
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Server (Cloudflare)                         │
│                                                                    │
│  Scheduler ─── single door for all session creation                │
│       │                                                            │
│       ▼                                                            │
│  Session (per conversation) ─── persistent, holds state + WS       │
│       │                          │                                 │
│       │ spawns                   │ WebSocket                       │
│       ▼                          ▼                                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Sandbox (Modal / Daytona)                 │   │
│  │                                                             │   │
│  │  Supervisor (PID 1)                                         │   │
│  │    ├── Agent (via Adapter) ─── does the coding work         │   │
│  │    ├── Bridge ──────────────── WebSocket back to Session    │   │
│  │    ├── code-server ─────────── browser IDE                  │   │
│  │    └── ttyd ────────────────── browser terminal             │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

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

## Packages

| Package                                     | Description                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| [sandbox-runtime](packages/sandbox-runtime) | **Agent adapter layer** — the ABC, adapter registry, bridge, and supervisor |
| [server](packages/server)                   | Cloudflare Workers — scheduler, session management, Durable Objects         |
| [web](packages/web)                         | Next.js web client                                                          |
| [modal-infra](packages/modal-infra)         | Modal sandbox infrastructure                                                |
| [daytona-infra](packages/daytona-infra)     | Operator-owned Daytona base snapshot tooling                                |
| [slack-bot](packages/slack-bot)             | Slack integration                                                           |
| [github-bot](packages/github-bot)           | GitHub integration                                                          |
| [linear-bot](packages/linear-bot)           | Linear integration                                                          |
| [shared](packages/shared)                   | Shared types, utilities, and `dispatchToScheduler()` client                 |

## Security Model (Single-Tenant Only)

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

## Documentation

For a suggested reading order, see [docs/README.md](docs/README.md).

| Doc                                                 | Description                       |
| --------------------------------------------------- | --------------------------------- |
| [AGENT_ADAPTER.md](docs/AGENT_ADAPTER.md)           | **How to add a new coding agent** |
| [SETUP_GUIDE.md](docs/SETUP_GUIDE.md)               | Local development setup           |
| [GETTING_STARTED.md](docs/GETTING_STARTED.md)       | Full deployment with Terraform    |
| [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)             | Architecture deep dive            |
| [AUTOMATIONS.md](docs/AUTOMATIONS.md)               | Cron, Sentry, webhook automations |
| [SECRETS.md](docs/SECRETS.md)                       | Repo secrets management           |
| [DEBUGGING_PLAYBOOK.md](docs/DEBUGGING_PLAYBOOK.md) | Troubleshooting guide             |
| [PI_ADAPTER.md](docs/PI_ADAPTER.md)                 | Pi adapter implementation details |
| [IMAGE_PREBUILD.md](docs/IMAGE_PREBUILD.md)         | Image prebuilding                 |
| [OPENAI_MODELS.md](docs/OPENAI_MODELS.md)           | OpenAI model configuration        |
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
