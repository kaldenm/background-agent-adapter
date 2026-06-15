/**
 * Daytona snapshot operator command.
 *
 * This command makes the Daytona base snapshot contract explicit:
 * - manual: use an existing operator-owned snapshot
 * - verify: run non-mutating Daytona checks
 * - build: invoke the repo-local Daytona snapshot bootstrap
 *
 * It never prints secret values.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SnapshotMode = "manual" | "verify" | "build";

interface Args {
  mode: SnapshotMode;
  dryRun: boolean;
  envFile: string;
}

interface SnapshotConfig {
  apiUrl: string;
  apiKey: string;
  organizationId: string;
  target: string;
  baseSnapshot: string;
  envFile: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.envFile);
  await run(args, config);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const [modeArg, ...rest] = argv;
  if (!isSnapshotMode(modeArg)) {
    throw new Error(
      "Usage: node --experimental-strip-types scripts/daytona-snapshot.ts <manual|verify|build> [--dry-run] [--env <path>]"
    );
  }

  return {
    mode: modeArg,
    dryRun: rest.includes("--dry-run"),
    envFile: getFlag(rest, "env") ?? "packages/daytona-infra/.env",
  };
}

function isSnapshotMode(value: string | undefined): value is SnapshotMode {
  return value === "manual" || value === "verify" || value === "build";
}

function getFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eqArg = argv.find((arg) => arg.startsWith(prefix));
  if (eqArg) return eqArg.slice(prefix.length);

  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith("--")) {
    return argv[idx + 1];
  }
  return undefined;
}

function loadConfig(envFile: string): SnapshotConfig {
  const fileEnv = loadDotEnv(path.resolve(envFile));
  return {
    apiUrl: (process.env.DAYTONA_API_URL || fileEnv.DAYTONA_API_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.DAYTONA_API_KEY || fileEnv.DAYTONA_API_KEY || "",
    organizationId: process.env.DAYTONA_ORGANIZATION_ID || fileEnv.DAYTONA_ORGANIZATION_ID || "",
    target: process.env.DAYTONA_TARGET || fileEnv.DAYTONA_TARGET || "",
    baseSnapshot: process.env.DAYTONA_BASE_SNAPSHOT || fileEnv.DAYTONA_BASE_SNAPSHOT || "",
    envFile,
  };
}

function loadDotEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  const values: Record<string, string> = {};
  const text = fs.readFileSync(filePath, "utf8");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const idx = line.indexOf("=");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

async function run(args: Args, config: SnapshotConfig): Promise<void> {
  validateRequiredConfig(config);

  printSummary(args, config);

  switch (args.mode) {
    case "manual":
      runManual(args, config);
      return;
    case "verify":
      await runVerify(args, config);
      return;
    case "build":
      runBuild(args, config);
      return;
  }
}

function validateRequiredConfig(config: SnapshotConfig): void {
  const missing = [
    config.apiUrl ? null : "DAYTONA_API_URL",
    config.apiKey ? null : "DAYTONA_API_KEY",
    config.baseSnapshot ? null : "DAYTONA_BASE_SNAPSHOT",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Daytona snapshot command failed: missing ${missing.join(", ")}`);
  }
}

function printSummary(args: Args, config: SnapshotConfig): void {
  console.log(`Daytona snapshot mode: ${args.mode}`);
  console.log(`dry_run=${args.dryRun ? "true" : "false"}`);
  console.log(`env_file=${config.envFile}`);
  console.log(`api_url=${config.apiUrl}`);
  console.log(`api_key=${config.apiKey ? "<present>" : "<missing>"}`);
  console.log(`organization_id=${config.organizationId ? "<present>" : "<missing>"}`);
  console.log(`target=${config.target || "<missing>"}`);
  console.log(`base_snapshot=${config.baseSnapshot}`);
  console.log(`source_fingerprint=${computeSourceFingerprint(repoRoot)}`);
}

function runManual(args: Args, config: SnapshotConfig): void {
  console.log(
    `Using existing Daytona snapshot ${config.baseSnapshot}; no build or live verification attempted.`
  );
  if (args.dryRun) {
    console.log("Manual dry-run complete: no Daytona API calls were made.");
  }
}

async function runVerify(args: Args, config: SnapshotConfig): Promise<void> {
  if (args.dryRun) {
    console.log("Verify dry-run complete: live calls skipped.");
    console.log("Would run non-mutating auth probe: GET /sandbox.");
    console.log(
      "Would confirm snapshot readiness when a stable Daytona snapshot lookup is available."
    );
    return;
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
  if (config.organizationId) {
    headers["X-Daytona-Organization-ID"] = config.organizationId;
  }

  const response = await fetch(`${config.apiUrl}/sandbox`, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Daytona snapshot verify failed: GET /sandbox status=${response.status} message=${sanitizeMessage(text, config)}`
    );
  }

  console.log(`Daytona snapshot verify ok: GET /sandbox status=${response.status}`);
  console.log(
    "Snapshot existence lookup was not attempted; this command verified credentials and snapshot configuration presence without mutation."
  );
}

function runBuild(args: Args, config: SnapshotConfig): void {
  const infraDir = path.join(repoRoot, "packages", "daytona-infra");
  const command = "uv";
  const commandArgs = ["run", "--with", "daytona", "python", "-m", "src.bootstrap", "--force"];

  console.log(`Build command: cd packages/daytona-infra && ${command} ${commandArgs.join(" ")}`);
  console.log(`Build target snapshot: ${config.baseSnapshot}`);

  if (args.dryRun) {
    console.log("Build dry-run complete: bootstrap command was not executed.");
    return;
  }

  if (!fs.existsSync(infraDir)) {
    throw new Error(`Daytona infra directory not found: ${infraDir}`);
  }

  const result = spawnSync(command, commandArgs, {
    cwd: infraDir,
    env: {
      ...process.env,
      DAYTONA_API_URL: config.apiUrl,
      DAYTONA_API_KEY: config.apiKey,
      DAYTONA_ORGANIZATION_ID: config.organizationId,
      DAYTONA_TARGET: config.target,
      DAYTONA_BASE_SNAPSHOT: config.baseSnapshot,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(
      `Failed to run uv. Install uv or run from an environment with uv available: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(`Daytona snapshot build failed with exit code ${result.status ?? "unknown"}`);
  }
}

function computeSourceFingerprint(repoRoot: string): string {
  const roots = [
    path.join(repoRoot, "packages", "daytona-infra", "src"),
    path.join(repoRoot, "packages", "sandbox-runtime", "src"),
  ];

  const files = roots.flatMap((root) => listSourceFiles(root)).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(repoRoot, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(py|js|ts)$/.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

function sanitizeMessage(text: string, config: SnapshotConfig): string {
  let message = text.slice(0, 200).replace(/\s+/g, " ");
  for (const secret of [config.apiKey]) {
    if (secret) message = message.replaceAll(secret, "<redacted>");
  }
  return message;
}
