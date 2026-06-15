# Scripts

Utility scripts for debugging, migration, and infrastructure management.

## Release checks

Run the non-live publish gate before pushing a demo or hackathon branch:

```bash
npm run check:publish
```

This runs formatting, lint, typecheck, workspace tests, browser E2E, Python lint/type/test checks,
production builds, and Cloudflare dry-runs. It does not validate live Daytona credentials; run
`npm run check:daytona` for that external auth check.

For a Daytona-backed live demo, use the stricter gate:

```bash
npm run check:publish:live
```

That fails fast unless Daytona accepts the configured API key and optional organization header, then
runs the non-live publish gate.

To prove a real Daytona snapshot works end-to-end enough to create a sandbox and inspect the baked
runtime, run the opt-in live smoke:

```bash
npm run check:daytona:live
```

This creates a disposable Daytona sandbox from `DAYTONA_BASE_SNAPSHOT`, runs toolbox checks inside
it, then stops and deletes it. Do not put it in default CI.

To prove a deployed Open-Inspect instance works end-to-end with a real logged-in user, repo, model
credential, Daytona sandbox, bridge connection, and agent run, use the deployed session smoke:

```bash
OPEN_INSPECT_BASE_URL=https://your-app.example \
OPEN_INSPECT_WS_URL=wss://your-worker.example \
OPEN_INSPECT_COOKIE='next-auth.session-token=...' \
OPEN_INSPECT_SMOKE_REPO=owner/repo \
npm run check:session:live
```

This creates a real session through the authenticated web API, opens the session WebSocket, waits
for the smoke marker and successful `execution_complete`, then deletes the session. Keep it opt-in.

Before staging a publish commit, run the local scope guard:

```bash
npm run check:publish-scope
```

It fails when tracked scratch/audit Markdown files are modified or staged, so you do not
accidentally publish local investigation notes with `git add -A`.

Before telling someone the local browser app is ready for manual testing, run the local dev smoke:

```bash
npm run check:local-dev
```

It requires the Next dev server and local Worker to already be running. It checks
`@open-inspect/shared` build output, Worker `/health`, authenticated Worker `/sessions` and
`/repos`, Daytona auth when `SANDBOX_PROVIDER=daytona`, repeated page loads, a real headless browser
render, and newly emitted Next dev logs for fatal module/cache errors.

| Script                                                                       | What it does                                                                                                                                                                                                            | When you'd use it                                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cf-logs.ts`](cf-logs.ts)                                                   | Query Cloudflare Worker logs by session ID, request ID, trace ID, or free-text search. Supports `--json` for piping to LLMs.                                                                                            | Debugging production issues. Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.                                                       |
| [`check-daytona-auth.ts`](check-daytona-auth.ts)                             | Non-destructive Daytona API auth probe. Calls `GET /sandbox` and never prints secrets.                                                                                                                                  | Before demos/deploys when sandbox creation says `Invalid credentials`. Usage: `node --experimental-strip-types scripts/check-daytona-auth.ts`   |
| [`local-dev-smoke.ts`](local-dev-smoke.ts)                                   | Opt-in local browser smoke. Verifies shared build output, Worker health, Worker `/sessions` and `/repos`, Daytona auth for Daytona-backed local dev, repeated Next page loads, browser render, and fresh Next dev logs. | Before telling someone `localhost:3001` is usable for manual testing. Usage: `npm run check:local-dev`                                          |
| [`check-publish-scope.ts`](check-publish-scope.ts)                           | Local publish-scope guard for tracked scratch/audit Markdown files.                                                                                                                                                     | Before staging/pushing. Usage: `npm run check:publish-scope`                                                                                    |
| [`d1-migrate.sh`](d1-migrate.sh)                                             | Run SQL migrations against a remote Cloudflare D1 database. Tracks applied versions in a `_schema_migrations` table.                                                                                                    | Applying schema changes to production D1. Usage: `./scripts/d1-migrate.sh <database-name>`                                                      |
| [`daytona-live-smoke.ts`](daytona-live-smoke.ts)                             | Opt-in live Daytona smoke. Creates a disposable sandbox from `DAYTONA_BASE_SNAPSHOT`, checks runtime/tooling, then cleans up.                                                                                           | Proving real Daytona credentials and the selected base snapshot work. Usage: `npm run check:daytona:live`                                       |
| [`daytona-snapshot.ts`](daytona-snapshot.ts)                                 | Daytona snapshot operator command with `manual`, `verify`, and `build` modes. Dry-runs redact secrets and avoid mutation.                                                                                               | Clarifying or rebuilding the Daytona base snapshot contract before a Daytona-backed demo. Usage: `npm run daytona:snapshot -- verify --dry-run` |
| [`get-sandbox-token.ts`](get-sandbox-token.ts)                               | OAuth flow to get a separate Anthropic token for sandbox use. Opens browser, prints a refresh token to paste into the web UI.                                                                                           | Setting up Pi agent auth for sandboxes (independent from your local Pi token).                                                                  |
| [`generate-web-wrangler-production.ts`](generate-web-wrangler-production.ts) | Generate the ignored `packages/web/wrangler.production.toml` used by direct Cloudflare web deploy scripts.                                                                                                              | Before `npm run deploy:web` / `npm run deploy:web:dry-run`; the npm scripts run it automatically.                                               |
| [`migrate-kv-to-d1.sh`](migrate-kv-to-d1.sh)                                 | One-time migration of session and repo metadata from Cloudflare KV to D1. Idempotent — safe to re-run.                                                                                                                  | Migrating from the old KV-based storage to D1. Usage: `./scripts/migrate-kv-to-d1.sh <kv-namespace-id> <d1-database-name>`                      |
| [`sandbox.sh`](sandbox.sh)                                                   | Inspect running Daytona sandboxes — list recent sandboxes, exec commands, or dump debug info (processes, auth, env, errors).                                                                                            | Debugging a live sandbox. Requires `.env` in `packages/daytona-infra/`. Usage: `./scripts/sandbox.sh [list\|exec <id> <cmd>\|logs <id>]`        |
| [`session-live-smoke.ts`](session-live-smoke.ts)                             | Opt-in deployed session smoke. Uses a logged-in web auth cookie, creates a session, watches WebSocket events, then cleans up.                                                                                           | Proving deployed Open-Inspect + Daytona + bridge + agent execution. Usage: `npm run check:session:live`                                         |
| [`wrangler-secrets.sh`](wrangler-secrets.sh)                                 | Upload known Worker secrets from environment variables, including `DAYTONA_API_KEY`; never stores values in files.                                                                                                      | Initial secret setup or secret rotation for a deployed worker.                                                                                  |
