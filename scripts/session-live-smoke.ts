/**
 * Opt-in deployed Open-Inspect session smoke test.
 *
 * This uses the authenticated web API, creates a real session, opens the real
 * session WebSocket, sends a tiny prompt, waits for an execution_complete event,
 * then deletes the session. It is intentionally not part of normal CI.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Args {
  baseUrl: string;
  wsUrl: string;
  cookie: string;
  authHeader: string;
  repo: string;
  prompt: string;
  marker: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  keepSession: boolean;
}

interface SmokeOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface SmokeResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

type WebSocketFactory = (url: string) => SmokeWebSocket;

interface SmokeWebSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MARKER = "OPEN_INSPECT_SMOKE_OK";

export async function runSessionLiveSmoke(options: SmokeOptions = {}): Promise<SmokeResult> {
  const env = options.env ?? process.env;
  const args = parseArgs(options.args ?? process.argv.slice(2), env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const lines: string[] = [];
  let sessionId: string | undefined;

  try {
    validateArgs(args);
    const [repoOwner, repoName] = splitRepo(args.repo);
    const client = new WebClient(args, fetchImpl);

    lines.push("Open-Inspect live session smoke: starting");
    lines.push(`base_url=${args.baseUrl}`);
    lines.push(`ws_url=${args.wsUrl}`);
    lines.push(`auth=${args.cookie ? "cookie" : "authorization_header"}`);
    lines.push(`repo=${args.repo}`);
    lines.push(`marker=${args.marker}`);

    const createBody = {
      repoOwner,
      repoName,
      title: `Daytona live smoke ${new Date(now()).toISOString()}`,
      prompt: args.prompt,
      model: args.model || undefined,
      reasoningEffort: args.reasoningEffort || undefined,
    };
    const createResponse = await client.postJson<{ sessionId: string; status?: string }>(
      "/api/sessions",
      createBody
    );
    sessionId = createResponse.sessionId;
    if (!sessionId) throw new Error("Session create response did not include sessionId");
    lines.push(`session_create=ok id=${sessionId}`);

    const tokenResponse = await client.postJson<{ token: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/ws-token`,
      {}
    );
    if (!tokenResponse.token) throw new Error("WS token response did not include token");
    lines.push("ws_token=ok");

    const wsEvents = await observeSessionWebSocket({
      wsUrl: `${args.wsUrl}/sessions/${encodeURIComponent(sessionId)}/ws`,
      token: tokenResponse.token,
      marker: args.marker,
      timeoutMs: args.timeoutMs,
      webSocketFactory,
      sleep,
      now,
    });
    lines.push(...wsEvents.summaryLines);

    if (!wsEvents.sawMarker) {
      throw new Error(`Did not observe marker ${args.marker} in session stream`);
    }
    if (!wsEvents.executionCompleteSuccess) {
      throw new Error("Did not observe successful execution_complete event");
    }

    lines.push("session_live_smoke=ok");
    return { exitCode: 0, stdout: lines.join("\n") };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: lines.length > 0 ? lines.join("\n") : undefined,
      stderr: sanitizeForLog(error instanceof Error ? error.message : String(error), args),
    };
  } finally {
    if (sessionId && !args.keepSession) {
      try {
        const client = new WebClient(args, fetchImpl);
        await client.deleteJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
      } catch {
        // Do not mask the primary smoke result with best-effort cleanup.
      }
    }
  }
}

class WebClient {
  private readonly args: Args;
  private readonly fetchImpl: FetchLike;

  constructor(args: Args, fetchImpl: FetchLike) {
    this.args = args;
    this.fetchImpl = fetchImpl;
  }

  async postJson<T>(requestPath: string, body: unknown): Promise<T> {
    return this.requestJson<T>("POST", requestPath, body);
  }

  async deleteJson<T = unknown>(requestPath: string): Promise<T> {
    return this.requestJson<T>("DELETE", requestPath);
  }

  private async requestJson<T>(
    method: "POST" | "DELETE",
    requestPath: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.args.baseUrl}${requestPath}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${requestPath} failed: status=${response.status} body=${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.args.cookie ? { Cookie: this.args.cookie } : {}),
      ...(this.args.authHeader ? { Authorization: this.args.authHeader } : {}),
    };
  }
}

async function observeSessionWebSocket(options: {
  wsUrl: string;
  token: string;
  marker: string;
  timeoutMs: number;
  webSocketFactory: WebSocketFactory;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<{
  sawMarker: boolean;
  executionCompleteSuccess: boolean;
  summaryLines: string[];
}> {
  const ws = options.webSocketFactory(options.wsUrl);
  const deadline = options.now() + options.timeoutMs;
  const summary = new Set<string>();
  let opened = false;
  let subscribed = false;
  let sawMarker = false;
  let executionCompleteSuccess = false;
  let closed: { code?: number; reason?: string } | null = null;
  let socketError: string | null = null;

  ws.onopen = () => {
    opened = true;
    ws.send(
      JSON.stringify({
        type: "subscribe",
        token: options.token,
        clientId: randomUUID(),
      })
    );
  };
  ws.onerror = (event) => {
    socketError = `WebSocket error: ${String(event)}`;
  };
  ws.onclose = (event) => {
    closed = { code: event.code, reason: event.reason };
  };
  ws.onmessage = (event) => {
    const parsed = safeJsonParse(event.data);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
    const type = String(parsed.type);
    summary.add(`ws_event=${type}`);

    if (type === "subscribed") subscribed = true;
    if (type === "sandbox_ready") summary.add("sandbox_ready=ok");
    if (type === "sandbox_error" && "error" in parsed) {
      socketError = `Sandbox error: ${String(parsed.error)}`;
    }

    const text = JSON.stringify(parsed);
    if (text.includes(options.marker)) sawMarker = true;

    if (
      type === "sandbox_event" &&
      "event" in parsed &&
      parsed.event &&
      typeof parsed.event === "object"
    ) {
      const sandboxEvent = parsed.event as { type?: unknown; success?: unknown };
      if (sandboxEvent.type) summary.add(`sandbox_event=${String(sandboxEvent.type)}`);
      if (sandboxEvent.type === "execution_complete" && sandboxEvent.success === true) {
        executionCompleteSuccess = true;
      }
    }
  };

  while (options.now() <= deadline) {
    if (socketError) throw new Error(socketError);
    if (closed && !executionCompleteSuccess) {
      throw new Error(
        `WebSocket closed before completion: code=${closed.code} reason=${closed.reason}`
      );
    }
    if (opened && subscribed && sawMarker && executionCompleteSuccess) {
      ws.close();
      return {
        sawMarker,
        executionCompleteSuccess,
        summaryLines: ["ws_open=ok", "ws_subscribed=ok", ...summary],
      };
    }
    await options.sleep(500);
  }

  ws.close();
  throw new Error(
    `Timed out waiting for live session completion; opened=${opened} subscribed=${subscribed} saw_marker=${sawMarker} execution_complete_success=${executionCompleteSuccess}`
  );
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const baseUrl = (
    getFlag(argv, "base-url") ??
    env.OPEN_INSPECT_BASE_URL ??
    env.NEXT_PUBLIC_APP_URL ??
    ""
  ).replace(/\/+$/, "");
  const wsUrl = (
    getFlag(argv, "ws-url") ??
    env.OPEN_INSPECT_WS_URL ??
    baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
  ).replace(/\/+$/, "");
  const repo = getFlag(argv, "repo") ?? env.OPEN_INSPECT_SMOKE_REPO ?? "";
  const marker = getFlag(argv, "marker") ?? env.OPEN_INSPECT_SMOKE_MARKER ?? DEFAULT_MARKER;

  return {
    baseUrl,
    wsUrl,
    cookie: getFlag(argv, "cookie") ?? env.OPEN_INSPECT_COOKIE ?? "",
    authHeader: getFlag(argv, "auth-header") ?? env.OPEN_INSPECT_AUTH_HEADER ?? "",
    repo,
    marker,
    prompt:
      getFlag(argv, "prompt") ??
      env.OPEN_INSPECT_SMOKE_PROMPT ??
      `Reply with exactly ${marker}. Do not create files or make changes.`,
    model: getFlag(argv, "model") ?? env.OPEN_INSPECT_SMOKE_MODEL ?? "",
    reasoningEffort:
      getFlag(argv, "reasoning-effort") ?? env.OPEN_INSPECT_SMOKE_REASONING_EFFORT ?? "",
    timeoutMs: Number(
      getFlag(argv, "timeout-ms") ?? env.OPEN_INSPECT_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS
    ),
    keepSession: argv.includes("--keep-session") || env.OPEN_INSPECT_SMOKE_KEEP_SESSION === "1",
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

function validateArgs(args: Args): void {
  const missing = [
    args.baseUrl ? null : "OPEN_INSPECT_BASE_URL or --base-url",
    args.wsUrl ? null : "OPEN_INSPECT_WS_URL or --ws-url",
    args.repo ? null : "OPEN_INSPECT_SMOKE_REPO or --repo",
    args.cookie || args.authHeader
      ? null
      : "OPEN_INSPECT_COOKIE/--cookie or OPEN_INSPECT_AUTH_HEADER/--auth-header",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Session live smoke missing required input: ${missing.join(", ")}`);
  }
}

function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  if (!owner || !name || repo.split("/").length !== 2) {
    throw new Error(`Repo must be in owner/name form; got ${repo || "<missing>"}`);
  }
  return [owner, name];
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeForLog(message: string, args: Args): string {
  return [args.cookie, args.authHeader].reduce(
    (sanitized, secret) => (secret ? sanitized.replaceAll(secret, "<redacted>") : sanitized),
    message
  );
}

function defaultWebSocketFactory(url: string): SmokeWebSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("Global WebSocket is unavailable in this Node runtime");
  }
  return new WebSocket(url) as SmokeWebSocket;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runSessionLiveSmoke();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
