# Slack Bot

A stateless Cloudflare Worker that turns Slack messages into Open-Inspect coding agent sessions.
Users @mention the bot or DM it with a coding request; the bot classifies which repo the request
targets, creates a session via the control plane, and posts a threaded reply with the agent's
results.

The bot is a **message-to-session translator** — it verifies Slack signatures, classifies the target
repository using an LLM, creates a session via the control plane, and sends the prompt. The agent in
the sandbox does all the actual coding work. When the agent finishes, the control plane calls back
and the bot posts a formatted summary in the Slack thread.

## Architecture

```
              ┌─────────────┐
              │    Slack     │
              │   Events +   │
              │  Interactions│
              └──────┬───────┘
                     │ POST /slack/events, /slack/interactions
                     v
              ┌──────────────┐   service binding   ┌─────────────────┐
              │  Slack Bot   │ ──────────────────>  │  Control Plane  │
              │   Worker     │                      │    Worker       │
              └──────┬───────┘                      └────────┬────────┘
               eyes  │                                       │
            reaction  │                                       │ callback
                     v                                       v
              ┌──────────────┐                        ┌──────────────┐
              │    Slack     │  <── threaded reply ──  │  Slack Bot   │
              │     API      │     (completion blocks) │  /callbacks  │
              └──────────────┘                        └──────────────┘
```

Key design decisions:

- **LLM-powered repo classification**: When a user sends a message, the bot uses Claude to classify
  which repository the request targets based on message content, channel context, and available
  repos. High-confidence matches proceed automatically; low-confidence prompts the user to confirm.
- **Thread-based conversation continuity**: Thread-to-session mappings are stored in Cloudflare KV.
  Follow-up messages in the same thread route to the same session automatically.
- **DM support**: Users can DM the bot directly. DMs go through the same classification and session
  creation flow as channel mentions.
- **Completion callbacks**: When the agent finishes, the control plane POSTs to `/callbacks/slack`
  with the session results. The bot extracts tool call summaries, artifacts (PRs, branches), and the
  agent's text response, then formats them as Slack Block Kit messages.

## Deployment

The bot is deployed via Terraform as a standalone Cloudflare Worker alongside the existing workers.

**Two-phase deployment** (same pattern as the GitHub bot):

1. Deploy with `enable_service_bindings = false` (creates the worker)
2. Set `enable_service_bindings = true` and apply again (adds the `CONTROL_PLANE` binding)

### Environment Bindings

| Binding                    | Type             | Description                                                   |
| -------------------------- | ---------------- | ------------------------------------------------------------- |
| `SLACK_KV`                 | KV namespace     | Thread-to-session mapping, user preferences, repo cache       |
| `CONTROL_PLANE`            | Service binding  | Fetcher to the control plane worker                           |
| `DEPLOYMENT_NAME`          | Plain text       | Deployment identifier for logging                             |
| `SERVER_URL`               | Plain text       | Control plane URL for session links                           |
| `WEB_APP_URL`              | Plain text       | Web app URL for session links in Slack messages               |
| `DEFAULT_MODEL`            | Plain text       | Default model for new sessions                                |
| `CLASSIFICATION_MODEL`     | Plain text       | Model used for repo classification (e.g., `claude-haiku-4-5`) |
| `SLACK_BOT_TOKEN`          | Secret           | Slack Bot User OAuth Token (`xoxb-...`)                       |
| `SLACK_SIGNING_SECRET`     | Secret           | Slack request signing secret for verification                 |
| `ANTHROPIC_API_KEY`        | Secret           | API key for the LLM-powered repo classifier                   |
| `INTERNAL_CALLBACK_SECRET` | Secret           | Shared secret for HMAC auth to/from the control plane         |
| `LOG_LEVEL`                | Plain text (opt) | Log level override (`debug`, `info`, `warn`, `error`)         |

### Slack App Configuration

**OAuth scopes**: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`,
`im:history`, `mpim:history`, `reactions:write`, `reactions:read`, `channels:read`, `groups:read`,
`users:read`

**Event subscriptions**: `app_mention`, `message.im`

**Interactivity**: Enable and point Request URL to
`https://open-inspect-slack-bot-{suffix}.{account}.workers.dev/slack/interactions`

**Event Request URL**: `https://open-inspect-slack-bot-{suffix}.{account}.workers.dev/slack/events`

## Message Flow

### Channel @mention

1. User @mentions the bot with a coding request
2. Bot verifies Slack signature and deduplicates by `event_id`
3. Bot posts :eyes: reaction as acknowledgment
4. **Repo classification**: Bot sends message + channel context to Claude, which picks the target
   repo from the GitHub App's installed repositories
5. If classification confidence is low, bot posts a repo selection dropdown and waits
6. If high, bot creates a session via the control plane's `dispatchToScheduler()`
7. Stores thread→session mapping in KV for follow-up routing
8. On agent completion, control plane calls `/callbacks/slack`
9. Bot extracts response, builds Block Kit message, posts threaded reply

### DM

Same flow as @mention, but without the @mention stripping step. DMs are identified by
`channel_type === "im"` and filtered to exclude bot messages and edit notifications.

### Thread Follow-up

1. User sends another message in the same thread
2. Bot looks up thread→session mapping in KV
3. If found, routes the message to the existing session as a follow-up prompt
4. If not found, treats it as a new request (re-classifies)

## Authentication

### Slack Signature Verification

Incoming requests are verified using Slack's signing secret:

1. Concatenate `v0:{timestamp}:{body}`
2. Compute `HMAC-SHA256(signing_secret, concatenated)`
3. Compare against `X-Slack-Signature` header using constant-time comparison
4. Reject if timestamp is older than 5 minutes (replay protection)

### Control Plane Auth

Requests to the control plane use HMAC tokens generated from `INTERNAL_CALLBACK_SECRET` (same
mechanism as the GitHub bot). The token is sent as a `Bearer` token in the `Authorization` header.

## Observability

All log entries are structured JSON with `trace_id` for cross-service correlation:

```
Slack event → Bot (trace_id = event_id) → Control plane (trace_id in x-trace-id header) → Sandbox
```

Key log events:

| Event                       | Level | When                                             |
| --------------------------- | ----- | ------------------------------------------------ |
| `slack.event.received`      | info  | Slack event arrives (type, channel, user)        |
| `slack.event.duplicate`     | info  | Duplicate event_id skipped                       |
| `classification.result`     | info  | Repo classification completed (repo, confidence) |
| `classification.ambiguous`  | info  | Low confidence — posting repo selection          |
| `control_plane.send_prompt` | info  | Prompt sent to session                           |
| `control_plane.send_prompt` | error | Prompt delivery failed                           |
| `callback.completion`       | info  | Agent completion callback received               |
| `slack.message.posted`      | info  | Completion message posted to thread              |

## Development

```bash
# Install dependencies (from repo root)
npm install

# Build
npm run build -w @open-inspect/slack-bot

# Run tests
npm run test -w @open-inspect/slack-bot

# Type check
npm run typecheck -w @open-inspect/slack-bot

# Lint
npm run lint -w @open-inspect/slack-bot
```

Tests run in Node.js via Vitest (no `@cloudflare/vitest-pool-workers` needed — the bot has no
Durable Objects or D1). All tests are deterministic and run without network access.

## Package Structure

```
src/
├── index.ts              # Hono app, routes, Slack event/interaction routing (~1850 lines)
├── types/
│   └── index.ts          # Env bindings, Slack event types, callback types
├── classifier/
│   ├── index.ts          # LLM-powered repo classification using Claude tool_use
│   ├── repos.ts          # Repo fetching from control plane, channel associations
│   └── index.test.ts     # Classifier tests
├── completion/
│   ├── extractor.ts      # Extracts agent response from session events
│   ├── blocks.ts         # Builds Slack Block Kit messages from agent responses
│   ├── blocks.test.ts    # Block building tests
│   └── extractor.test.ts # Extractor tests
├── callbacks.ts          # POST /callbacks/slack — handles control plane completion notifications
├── branch-preferences.ts # Per-user branch preference modals and KV storage
├── dm-utils.ts           # DM detection and @mention stripping
├── logger.ts             # Structured JSON logger (re-exports shared logger)
└── utils/
    ├── slack-client.ts   # Slack API helpers (postMessage, addReaction, etc.)
    ├── resolve-users.ts  # Resolves Slack user IDs to display names
    ├── internal.ts       # Re-exports generateInternalToken from @open-inspect/shared
    └── repo.ts           # Repo display name formatting
```
