# Open-Inspect Daytona Snapshot Tooling

Standalone scripts for seeding and managing Daytona base snapshots used by Open-Inspect sandboxes.

The control plane communicates with the Daytona REST API directly — these scripts are for one-time
snapshot setup, not runtime operations.

## Scripts

- **`src/bootstrap.py`** — Seeds the named Daytona base snapshot from the repo-local sandbox runtime
- **`src/toolchain.py`** — Toolchain management utilities for snapshot images
- **`../../scripts/daytona-snapshot.ts`** — Operator command that makes snapshot mode explicit:
  `manual`, `verify`, or `build`

## Environment

- `DAYTONA_API_KEY` (required)
  - For runtime sandbox creation in the control plane, the key must have **Sandboxes: Read, Write**
    permissions.
  - For this snapshot bootstrap tooling, the key must also have **Snapshots: Read, Write, Delete**
    permissions.
- `DAYTONA_API_URL`
- `DAYTONA_ORGANIZATION_ID` (optional, for Daytona accounts that require
  `X-Daytona-Organization-ID`)
- `DAYTONA_TARGET`
- `DAYTONA_BASE_SNAPSHOT` (required)

Before demos or deploys, verify the runtime key without creating a sandbox:

```bash
npm run check:daytona
```

If this returns `401 Invalid credentials`, Daytona rejected the key before any sandbox or agent code
ran. Rotate `DAYTONA_API_KEY` in Daytona and update the local `.env` and deployed Worker secret.

## Usage

The Daytona base snapshot is the prebuilt image used for fresh Open-Inspect sandboxes. It is
operator-owned: use your own existing snapshot for fast private deploys, or build one from this repo
when you want a publishable, reproducible baseline.

For an existing preseeded snapshot, check the contract without contacting Daytona:

```bash
npm run daytona:snapshot -- manual --dry-run
```

Use this with Terraform `daytona_snapshot_mode = "manual"`. Terraform will pass the named
`DAYTONA_BASE_SNAPSHOT` to the control plane and will not rebuild it automatically.

To verify credentials/configuration without mutating snapshots:

```bash
npm run daytona:snapshot -- verify --dry-run
npm run daytona:snapshot -- verify
```

To build or refresh the snapshot from this repo:

```bash
npm run daytona:snapshot -- build --dry-run
npm run daytona:snapshot -- build
```

Build mode runs `uv run --with daytona python -m src.bootstrap --force` inside this package. Rebuild
whenever `packages/daytona-infra/src` or `packages/sandbox-runtime/src` changes in a way that should
be present in fresh Daytona sandboxes. Roll back by setting `DAYTONA_BASE_SNAPSHOT` or
`daytona_base_snapshot` to the previous known-good snapshot name and redeploying.

Terraform supports the same modes through `daytona_snapshot_mode`: `manual`, `verify`, or `build`.
Use `build` only when the Terraform runner is allowed to mutate Daytona snapshots.

## Live Smoke Test

When you need to prove real Daytona credentials and the selected base snapshot work, run:

```bash
npm run check:daytona:live
```

This is intentionally opt-in and mutating. It creates a disposable sandbox from
`DAYTONA_BASE_SNAPSHOT`, waits for it to start, runs toolbox checks for Python, Node, git,
`/workspace`, `/app/sandbox_runtime`, `agent-browser`, and `code-server`, then stops and deletes the
sandbox. It proves the Daytona account, snapshot name, sandbox creation path, and baked runtime
tooling. It does not replace a deployed Open-Inspect session smoke test.
