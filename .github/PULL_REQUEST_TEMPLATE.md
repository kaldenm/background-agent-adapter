## What

Brief description of the change.

## Why

What problem does this solve?

## How

Key implementation details (if not obvious from the diff).

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] Tests pass (`npm test`)
- [ ] Web E2E passes (`npm run test:e2e -w @open-inspect/web`) for user-facing workflow changes
- [ ] Publish gate passes (`npm run check:publish`) before demo/hackathon publishing
- [ ] Live Daytona gate passes (`npm run check:publish:live`) if the demo depends on real Daytona
      sandboxes
- [ ] Built `@open-inspect/shared` if shared types changed
- [ ] Python: `ruff check` and `ruff format` pass (if applicable)
- [ ] Docs updated (if applicable)
