/**
 * Opt-in live Daytona smoke test.
 *
 * This creates a disposable Daytona sandbox from DAYTONA_BASE_SNAPSHOT,
 * verifies the sandbox can start, checks repo-baked runtime/tooling through
 * Daytona's toolbox executor, then stops and deletes the sandbox.
 *
 * It is intentionally not part of normal CI. Run only with real Daytona
 * credentials when you want to prove a specific operator-owned snapshot works.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Args {
  createSandbox: boolean;
  envFile: string;
  timeoutMs: number;
  toolboxUrl: string;
}

interface SmokeConfig {
  apiUrl: string;
  apiKey: string;
  organizationId: string;
  target: string;
  baseSnapshot: string;
  envFile: string;
  toolboxUrl: string;
}

interface DaytonaSandbox {
  id: string;
  state?: string;
}

interface LiveSmokeOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface LiveSmokeResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const DEFAULT_TOOLBOX_URL = "https://proxy.app.daytona.io/toolbox";
const DEFAULT_TIMEOUT_MS = 120_000;

export async function runDaytonaLiveSmoke(
  options: LiveSmokeOptions = {}
): Promise<LiveSmokeResult> {
  const args = parseArgs(options.args ?? process.argv.slice(2));
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const config = loadConfig(args, cwd, env);
  const startedAt = now();
  const lines: string[] = [];
  let sandboxId: string | undefined;
  let cleanupError: string | undefined;

  try {
    validateOptIn(args);
    validateRequiredConfig(config);

    lines.push("Daytona live smoke: starting");
    lines.push(`env_file=${config.envFile}`);
    lines.push(`api_url=${config.apiUrl}`);
    lines.push(`api_key=${config.apiKey ? "<present>" : "<missing>"}`);
    lines.push(`organization_id=${config.organizationId ? "<present>" : "<missing>"}`);
    lines.push(`target=${config.target || "<missing>"}`);
    lines.push(`base_snapshot=${config.baseSnapshot}`);

    const client = new DaytonaApi(config, fetchImpl);

    await client.get("/sandbox");
    lines.push("auth_probe=ok");

    const sandboxName = `open-inspect-smoke-${startedAt}`;
    const sandbox = await client.post<DaytonaSandbox>("/sandbox", {
      name: sandboxName,
      snapshot: config.baseSnapshot,
      labels: {
        openinspect_smoke_test: "true",
        openinspect_snapshot: config.baseSnapshot,
      },
      env: {
        SANDBOX_ID: sandboxName,
        SANDBOX_AUTH_TOKEN: "daytona-live-smoke",
        SERVER_URL: "http://127.0.0.1:1",
        SESSION_CONFIG: JSON.stringify({
          session_id: "daytona-live-smoke",
          repo_owner: "open-inspect",
          repo_name: "smoke",
          provider: "github",
          model: "smoke",
        }),
      },
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      public: false,
      ...(config.target ? { target: config.target } : {}),
    });
    sandboxId = sandbox.id;
    lines.push(`sandbox_create=ok id=${sandboxId}`);
    lines.push("snapshot_existence=proven_by_sandbox_create");

    const ready = await waitForSandboxStarted(client, sandboxId, args.timeoutMs, sleep, now);
    lines.push(`sandbox_state=${ready.state ?? "unknown"}`);

    const toolboxOutput = await runToolboxChecks(config, fetchImpl, sandboxId);
    assertToolboxOutput(toolboxOutput);
    lines.push("toolbox_runtime_checks=ok");
    lines.push(formatIndentedToolboxOutput(toolboxOutput));

    return { exitCode: 0, stdout: lines.join("\n") };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: lines.length > 0 ? lines.join("\n") : undefined,
      stderr: sanitizeMessage(error instanceof Error ? error.message : String(error), config),
    };
  } finally {
    if (sandboxId) {
      try {
        const client = new DaytonaApi(config, fetchImpl);
        await client.post(`/sandbox/${sandboxId}/stop`);
        await client.delete(`/sandbox/${sandboxId}`);
      } catch (error) {
        cleanupError = sanitizeMessage(
          error instanceof Error ? error.message : String(error),
          config
        );
      }
    }

    if (cleanupError) {
      return {
        exitCode: 1,
        stdout: lines.length > 0 ? lines.join("\n") : undefined,
        stderr: `Daytona live smoke cleanup failed: ${cleanupError}`,
      };
    }
  }
}

class DaytonaApi {
  private readonly baseUrl: string;
  private readonly config: SmokeConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: SmokeConfig, fetchImpl: FetchLike) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
  }

  async get<T = unknown>(requestPath: string): Promise<T> {
    return this.request<T>("GET", requestPath);
  }

  async post<T = unknown>(requestPath: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", requestPath, body);
  }

  async delete<T = unknown>(requestPath: string): Promise<T> {
    return this.request<T>("DELETE", requestPath);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    requestPath: string,
    body?: unknown
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Daytona ${method} ${requestPath} failed: status=${response.status} message=${text.slice(0, 300)}`
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.config.organizationId) {
      headers["X-Daytona-Organization-ID"] = this.config.organizationId;
    }
    return headers;
  }
}

function parseArgs(argv: string[]): Args {
  return {
    createSandbox: argv.includes("--create-sandbox"),
    envFile: getFlag(argv, "env") ?? "packages/daytona-infra/.env",
    timeoutMs: Number(getFlag(argv, "timeout-ms") ?? DEFAULT_TIMEOUT_MS),
    toolboxUrl: getFlag(argv, "toolbox-url") ?? DEFAULT_TOOLBOX_URL,
  };
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

function loadConfig(args: Args, cwd: string, env: NodeJS.ProcessEnv): SmokeConfig {
  const fileEnv = loadDotEnv(path.resolve(cwd, args.envFile));
  return {
    apiUrl: (env.DAYTONA_API_URL || fileEnv.DAYTONA_API_URL || "").replace(/\/+$/, ""),
    apiKey: env.DAYTONA_API_KEY || fileEnv.DAYTONA_API_KEY || "",
    organizationId: env.DAYTONA_ORGANIZATION_ID || fileEnv.DAYTONA_ORGANIZATION_ID || "",
    target: env.DAYTONA_TARGET || fileEnv.DAYTONA_TARGET || "",
    baseSnapshot: env.DAYTONA_BASE_SNAPSHOT || fileEnv.DAYTONA_BASE_SNAPSHOT || "",
    envFile: args.envFile,
    toolboxUrl: args.toolboxUrl.replace(/\/+$/, ""),
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
    values[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function validateOptIn(args: Args): void {
  if (!args.createSandbox) {
    throw new Error(
      "Daytona live smoke is mutating. Re-run with --create-sandbox to create, inspect, stop, and delete a disposable sandbox."
    );
  }
}

function validateRequiredConfig(config: SmokeConfig): void {
  const missing = [
    config.apiUrl ? null : "DAYTONA_API_URL",
    config.apiKey ? null : "DAYTONA_API_KEY",
    config.baseSnapshot ? null : "DAYTONA_BASE_SNAPSHOT",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Daytona live smoke failed: missing ${missing.join(", ")}`);
  }
}

async function waitForSandboxStarted(
  client: DaytonaApi,
  sandboxId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<DaytonaSandbox> {
  const deadline = now() + timeoutMs;
  let last: DaytonaSandbox | undefined;

  while (now() <= deadline) {
    last = await client.get<DaytonaSandbox>(`/sandbox/${sandboxId}`);
    if (last.state === "started" || last.state === "running") {
      return last;
    }
    await sleep(2_000);
  }

  throw new Error(
    `Daytona sandbox did not start within ${timeoutMs}ms; last_state=${last?.state ?? "unknown"}`
  );
}

async function runToolboxChecks(
  config: SmokeConfig,
  fetchImpl: FetchLike,
  sandboxId: string
): Promise<string> {
  const command = [
    "set -e",
    "echo python=$(python --version 2>&1)",
    "echo node=$(node --version)",
    "echo git=$(git --version)",
    "test -d /workspace && echo workspace=ok",
    "test -f /app/sandbox_runtime/supervisor.py && echo app_runtime=ok",
    "python - <<'PY'\nimport sandbox_runtime\nprint('sandbox_runtime_import=ok')\nPY",
    "command -v agent-browser >/dev/null && echo agent_browser=ok",
    "command -v code-server >/dev/null && echo code_server=ok",
  ].join("; ");

  const response = await fetchImpl(`${config.toolboxUrl}/${sandboxId}/process/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(config.organizationId ? { "X-Daytona-Organization-ID": config.organizationId } : {}),
    },
    body: JSON.stringify({ command }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Daytona toolbox execute failed: status=${response.status} message=${text.slice(0, 300)}`
    );
  }

  return extractToolboxResult(text);
}

function extractToolboxResult(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      if ("result" in parsed && typeof parsed.result === "string") return parsed.result;
      if ("stdout" in parsed && typeof parsed.stdout === "string") return parsed.stdout;
      if ("output" in parsed && typeof parsed.output === "string") return parsed.output;
    }
  } catch {
    return text;
  }
  return text;
}

function assertToolboxOutput(output: string): void {
  const required = [
    "python=Python",
    "node=v",
    "git=git version",
    "workspace=ok",
    "app_runtime=ok",
    "sandbox_runtime_import=ok",
    "agent_browser=ok",
    "code_server=ok",
  ];
  const missing = required.filter((marker) => !output.includes(marker));
  if (missing.length > 0) {
    throw new Error(
      `Daytona runtime/tooling checks failed; missing markers: ${missing.join(", ")}`
    );
  }
}

function formatIndentedToolboxOutput(output: string): string {
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => `toolbox: ${line}`)
    .join("\n");
}

function sanitizeMessage(message: string, config: SmokeConfig): string {
  return [config.apiKey].reduce(
    (sanitized, secret) => (secret ? sanitized.replaceAll(secret, "<redacted>") : sanitized),
    message
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runDaytonaLiveSmoke();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
