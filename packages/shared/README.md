# @open-inspect/shared

Shared types, utilities, and model definitions used by all Open-Inspect packages. This is the
foundational dependency — every other package imports from here.

## What it exports

| Module                 | Description                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`                | Core type definitions: `Session`, `SandboxEvent`, `ClientMessage`, `ServerMessage`, `Automation`, analytics types, and all status/event enums |
| `scheduler-client`     | `dispatchToScheduler()` — the single-door client all bots use to create sessions                                                              |
| `models`               | `VALID_MODELS`, `MODEL_OPTIONS`, model validation, and reasoning effort configuration                                                         |
| `auth`                 | HMAC-SHA256 token generation and verification for service-to-service auth                                                                     |
| `logger`               | Structured JSON logger for Cloudflare Workers (flat JSON lines, zero dependencies)                                                            |
| `cache-store`          | `CacheStore` interface and KV-backed implementation                                                                                           |
| `git`                  | Branch naming utilities (`BRANCH_PREFIX`, `normalizeBranchName`)                                                                              |
| `cron`                 | Cron expression parsing and next-run calculation                                                                                              |
| `triggers`             | Automation trigger engine: conditions, glob matching, Sentry/webhook handlers                                                                 |
| `completion/extractor` | Extracts agent responses from session events for bot summaries                                                                                |

## Usage

Other packages depend on `@open-inspect/shared` as a file reference:

```json
"dependencies": {
  "@open-inspect/shared": "file:../shared"
}
```

```ts
import { dispatchToScheduler, VALID_MODELS, createLogger } from "@open-inspect/shared";
import type { Session, SandboxEvent, ClientMessage } from "@open-inspect/shared";
```

## Build

The shared package must be built before any dependent package:

```bash
npm run build -w @open-inspect/shared    # compile TypeScript → dist/
npm run typecheck -w @open-inspect/shared # type-check only
npm run test -w @open-inspect/shared     # run tests
```

The setup script (`bash .openinspect/setup.sh`) handles this automatically.
