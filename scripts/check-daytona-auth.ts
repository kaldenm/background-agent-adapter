/**
 * Non-destructive Daytona auth probe.
 *
 * Verifies that the configured Daytona API URL/key can authenticate against
 * GET /sandbox. This does not create, start, stop, or delete sandboxes.
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-daytona-auth.ts
 *   node --experimental-strip-types scripts/check-daytona-auth.ts --env packages/daytona-infra/.env
 *
 * Environment variables:
 *   DAYTONA_API_URL
 *   DAYTONA_API_KEY
 *   DAYTONA_ORGANIZATION_ID (optional)
 *   DAYTONA_TARGET (recommended for runtime sandbox creation)
 *   DAYTONA_BASE_SNAPSHOT (required for runtime sandbox creation)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DaytonaAuthProbeOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: FetchLike;
}

export interface DaytonaAuthProbeResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

interface ProbeResult {
  path: string;
  status: number;
  ok: boolean;
  message: string;
  parsed: unknown;
}

function getFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eqArg = args.find((arg) => arg.startsWith(prefix));
  if (eqArg) return eqArg.slice(prefix.length);

  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
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

function extractMessage(text: string): { message: string; parsed: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const message =
    parsed &&
    typeof parsed === "object" &&
    "message" in parsed &&
    typeof parsed.message === "string"
      ? parsed.message
      : parsed &&
          typeof parsed === "object" &&
          "error" in parsed &&
          typeof parsed.error === "string"
        ? parsed.error
        : text.slice(0, 200).replace(/\s+/g, " ");

  return { message, parsed };
}

export async function runDaytonaAuthProbe(
  options: DaytonaAuthProbeOptions = {}
): Promise<DaytonaAuthProbeResult> {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;

  const envFile = getFlag(args, "env") ?? "packages/daytona-infra/.env";
  const fileEnv = loadDotEnv(path.resolve(cwd, envFile));
  const apiUrl = (env.DAYTONA_API_URL || fileEnv.DAYTONA_API_URL || "").replace(/\/+$/, "");
  const apiKey = env.DAYTONA_API_KEY || fileEnv.DAYTONA_API_KEY || "";
  const organizationId = env.DAYTONA_ORGANIZATION_ID || fileEnv.DAYTONA_ORGANIZATION_ID || "";
  const target = env.DAYTONA_TARGET || fileEnv.DAYTONA_TARGET || "";
  const baseSnapshot = env.DAYTONA_BASE_SNAPSHOT || fileEnv.DAYTONA_BASE_SNAPSHOT || "";

  const configSummary = [
    `env_file=${envFile}`,
    `api_url=${apiUrl || "<missing>"}`,
    `api_key=${apiKey ? "<present>" : "<missing>"}`,
    `organization_id=${organizationId ? "<present>" : "<missing>"}`,
    `target=${target || "<missing>"}`,
    `base_snapshot=${baseSnapshot || "<missing>"}`,
  ].join(" ");

  if (!apiUrl || !apiKey) {
    return {
      exitCode: 2,
      stderr: `Daytona auth probe failed: DAYTONA_API_URL and DAYTONA_API_KEY are required.\nconfig ${configSummary}`,
    };
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (organizationId) {
    headers["X-Daytona-Organization-ID"] = organizationId;
  }

  async function probe(probePath: string): Promise<ProbeResult> {
    const response = await fetchImpl(`${apiUrl}${probePath}`, { headers });
    const text = await response.text();
    const { message, parsed } = extractMessage(text);

    return {
      path: probePath,
      status: response.status,
      ok: response.ok,
      message,
      parsed,
    };
  }

  const sandboxProbe = await probe("/sandbox");

  if (sandboxProbe.ok) {
    const count = Array.isArray(sandboxProbe.parsed)
      ? sandboxProbe.parsed.length
      : sandboxProbe.parsed &&
          typeof sandboxProbe.parsed === "object" &&
          "data" in sandboxProbe.parsed &&
          Array.isArray(sandboxProbe.parsed.data)
        ? sandboxProbe.parsed.data.length
        : "unknown";
    const runtimeWarnings = [
      organizationId
        ? null
        : "DAYTONA_ORGANIZATION_ID is not set; add it if this account is org-scoped.",
      target
        ? null
        : "DAYTONA_TARGET is not set; sandbox creation may fail if Daytona requires a target.",
      baseSnapshot
        ? null
        : "DAYTONA_BASE_SNAPSHOT is not set; runtime sandbox creation requires it.",
    ].filter(Boolean);

    return {
      exitCode: 0,
      stdout: [
        `Daytona auth ok: GET /sandbox status=${sandboxProbe.status} sandbox_count=${count}`,
        `config ${configSummary}`,
        runtimeWarnings.length > 0
          ? `Daytona runtime warnings:\n- ${runtimeWarnings.join("\n- ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const followUpProbes =
    sandboxProbe.status === 401
      ? await Promise.all(["/organizations", "/regions", "/snapshots"].map((p) => probe(p)))
      : [];

  const diagnostic =
    followUpProbes.length > 0
      ? `\nread-only diagnostics=${followUpProbes
          .map((result) => `${result.path}:${result.status}:${result.message}`)
          .join(" | ")}${
          followUpProbes.every((result) => result.status === 401)
            ? "\ncredential_scope=global_rejection"
            : ""
        }`
      : "";

  const hint =
    sandboxProbe.status === 401
      ? "Generate or rotate DAYTONA_API_KEY in Daytona, ensure it has Sandboxes Read/Write, and set DAYTONA_ORGANIZATION_ID if your Daytona account requires org-scoped requests. This failed before sandbox creation, so DAYTONA_TARGET, DAYTONA_BASE_SNAPSHOT, and agent auth were not reached."
      : "Check DAYTONA_API_URL, DAYTONA_API_KEY permissions, and Daytona service status.";

  return {
    exitCode: 1,
    stderr: `Daytona auth failed: GET /sandbox status=${sandboxProbe.status} message=${sandboxProbe.message}${diagnostic}\nconfig ${configSummary}\n${hint}`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runDaytonaAuthProbe();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
