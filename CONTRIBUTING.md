# Contributing to Background Agent Adapter

Thank you for your interest in contributing! This project adds a pluggable agent adapter layer to
the [Open-Inspect](https://github.com/ColeMurray/background-agents) background coding agent system.

## Ways to Contribute

### Add a new agent adapter

This is the highest-impact contribution. If you have a coding agent you want to run as a background
agent, you can add an adapter for it:

1. Read [docs/AGENT_ADAPTER.md](docs/AGENT_ADAPTER.md) — the full guide
2. Look at the existing adapters in
   [`packages/sandbox-runtime/src/sandbox_runtime/adapters/`](packages/sandbox-runtime/src/sandbox_runtime/adapters/)
3. Implement the 13-method `AgentAdapter` ABC
4. Add tests (see `tests/test_pi_adapter.py` for reference)
5. Open a PR

Use the
[New Agent Adapter](https://github.com/Goober-Codes/background-agent-adapter/issues/new?template=new_adapter.md)
issue template to discuss before starting.

### Fix bugs or improve existing code

Standard contribution flow — find an issue, fix it, open a PR.

### Improve documentation

Docs live in `docs/`. If something is unclear or missing, PRs are welcome.

## Getting Started

```bash
# Clone and bootstrap
git clone https://github.com/Goober-Codes/background-agent-adapter.git
cd background-agent-adapter
bash .openinspect/setup.sh
```

This handles npm dependencies, builds the shared package, configures git hooks, and optionally sets
up a Python virtualenv for `packages/modal-infra`.

For manual setup or individual steps:

```bash
npm install
npm run build -w @open-inspect/shared    # build shared first
npm run typecheck
npm run lint
npm test
```

## Project Structure

| Package                    | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `packages/sandbox-runtime` | **Agent adapter layer** — the ABC, registry, bridge, entrypoint |
| `packages/server`          | Cloudflare Workers + Durable Objects                            |
| `packages/web`             | Next.js web application                                         |
| `packages/modal-infra`     | Modal sandbox infrastructure                                    |
| `packages/shared`          | Shared types and utilities                                      |

## Development Workflow

### TypeScript

```bash
npm run build -w @open-inspect/shared    # rebuild if shared types changed
npm run lint                             # ESLint + Prettier
npm run typecheck                        # tsc across all packages
npm test                                 # all tests

# Targeted tests
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane
npm test -w @open-inspect/web
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot
```

### Python (sandbox-runtime / modal-infra)

```bash
cd packages/modal-infra
uv sync --frozen --extra dev      # or: pip install -e ".[dev]"
pytest tests/ -v
ruff check --fix && ruff format
```

## Code Style

- Run `npm run lint` and `npm run typecheck` before committing
- Husky + lint-staged will catch most issues on commit
- Follow existing patterns in the codebase

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` code restructure
- `test:` adding or updating tests
- `chore:` maintenance

Keep the subject under 72 characters.

## Pull Requests

1. Ensure all tests pass
2. Ensure linting and type checking pass
3. Update documentation if needed
4. Fill out the PR template
5. Provide a clear description of your changes

### For new adapters specifically

Follow the checklist in
[docs/provider-contribution-checklist.md](docs/provider-contribution-checklist.md) and reference
[docs/AGENT_ADAPTER.md](docs/AGENT_ADAPTER.md).

## Reporting Issues

Use the GitHub issue templates:

- [Bug Report](https://github.com/Goober-Codes/background-agent-adapter/issues/new?template=bug_report.md)
- [Feature Request](https://github.com/Goober-Codes/background-agent-adapter/issues/new?template=feature_request.md)
- [New Agent Adapter](https://github.com/Goober-Codes/background-agent-adapter/issues/new?template=new_adapter.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
