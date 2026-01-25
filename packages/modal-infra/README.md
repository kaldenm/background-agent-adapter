# Open-Inspect Modal Infrastructure

Modal-based sandbox infrastructure for the Open-Inspect coding agent system.

## Overview

This package provides the data plane for Open-Inspect:

- **Sandboxes**: Isolated development environments running OpenCode
- **Images**: Pre-built container images with all development tools
- **Snapshots**: Filesystem snapshots for fast startup and session persistence
- **Scheduler**: Image rebuilding infrastructure (currently disabled)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Session Sandbox                              │
│  ┌──────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │  Supervisor      │  │  OpenCode       │  │  Bridge       │  │
│  │  (entrypoint.py) │──│  Server         │──│  (bridge.py)  │  │
│  └──────────────────┘  └─────────────────┘  └───────────────┘  │
│           │                    │                    │           │
│           └────────────────────┼────────────────────┘           │
│                                │                                │
│                        WebSocket to                             │
│                      Control Plane                              │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### Images (`src/images/`)

Base image definition with:
- Debian slim + git, curl, build-essential
- Node.js 22, pnpm, Bun
- Python 3.12 with uv
- OpenCode CLI
- Playwright + headless Chrome

### Sandbox (`src/sandbox/`)

- **manager.py**: Sandbox lifecycle (create, warm, snapshot)
- **entrypoint.py**: Supervisor process (runs as PID 1)
- **bridge.py**: WebSocket bridge to control plane
- **types.py**: Event and configuration types

### Registry (`src/registry/`)

- **models.py**: Repository and snapshot data models
- **store.py**: Persistent metadata storage

### Scheduler (`src/scheduler/`)

- **image_builder.py**: Image rebuild infrastructure (scheduling currently disabled)

## Usage

> **Full deployment guide**: See [docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md) for complete setup
> instructions including all required secrets and configuration.

### Prerequisites

1. Install Modal CLI: `pip install modal`
2. Authenticate: `modal setup`
3. Create secrets via Modal CLI:

```bash
# LLM API keys
modal secret create llm-api-keys ANTHROPIC_API_KEY="sk-ant-..."

# GitHub App credentials (for repo access)
modal secret create github-app \
  GITHUB_APP_ID="123456" \
  GITHUB_APP_PRIVATE_KEY="$(cat private-key-pkcs8.pem)" \
  GITHUB_APP_INSTALLATION_ID="12345678"

# Internal API secret (for control plane authentication)
modal secret create internal-api MODAL_API_SECRET="$(openssl rand -hex 32)"
```

See `.env.example` for a full list of environment variables.

### Deploy

```bash
# Deploy the app (recommended)
modal deploy deploy.py

# Alternative: deploy the src package directly
modal deploy -m src

# Run locally for development
modal run src/
```

> **Note**: Never deploy `src/app.py` directly - it only defines the app and shared resources.
> Use `deploy.py` or `-m src` to ensure all function modules are registered.

### Register a Repository

```python
from modal import App
import modal

# Get the deployed app
app = modal.App.lookup("open-inspect")

# Register a repository for scheduled builds
register = modal.Function.lookup("open-inspect", "register_repository")
register.remote(
    repo_owner="your-org",
    repo_name="your-repo",
    default_branch="main",
)
```

### Trigger a Build

```python
from modal import App
import modal

build = modal.Function.lookup("open-inspect", "build_single_repo_image")
result = build.remote(
    repo_owner="your-org",
    repo_name="your-repo",
)
print(result)  # {"snapshot_id": "...", "status": "success", ...}
```

### Create a Sandbox

```python
from modal import App
import modal

create = modal.Function.lookup("open-inspect", "create_sandbox")
result = create.remote(
    session_id="session-123",
    repo_owner="your-org",
    repo_name="your-repo",
    control_plane_url="https://your-control-plane.com",
    sandbox_auth_token="your-token",
)
print(result)  # {"sandbox_id": "...", "status": "warming"}
```

## Environment Variables

Set via Modal secrets:

| Variable | Secret | Description |
|----------|--------|-------------|
| `ANTHROPIC_API_KEY` | `llm-api-keys` | Anthropic API key for Claude |
| `GITHUB_APP_ID` | `github-app` | GitHub App ID for repo access |
| `GITHUB_APP_PRIVATE_KEY` | `github-app` | GitHub App private key (PKCS#8) |
| `GITHUB_APP_INSTALLATION_ID` | `github-app` | GitHub App installation ID |
| `MODAL_API_SECRET` | `internal-api` | Shared secret for control plane auth |
| `ALLOWED_CONTROL_PLANE_HOSTS` | `internal-api` | Comma-separated allowed hostnames for URL validation |

## Verification Criteria

| Criterion | Test Method |
|-----------|-------------|
| App deploys successfully | `modal deploy deploy.py` completes without errors |
| Sandbox starts from snapshot | Time `create_sandbox()` after warm |
| Git sync completes | Verify HEAD matches origin |
| OpenCode server responds | `curl localhost:4096/global/health` |
| Snapshot preserves state | Create file, snapshot, restore, verify |
| Crash recovery works | Kill OpenCode, verify restart |
| Session persists | Send 2 prompts, verify context |

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/

# Type check
mypy src/
```
