/**
 * Opt-in local dev smoke test.
 *
 * This verifies the thing a human actually needs before manual testing:
 * the local Next app renders in a browser, the Worker is healthy, and the
 * current dev-server logs do not show broken workspace/module/cache output.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

type FetchLike = typeof fetch;

export interface LocalDevSmokeOptions {
  nextUrl?: string;
  workerUrl?: string;
  logPath?: string;
  sharedDistPath?: string;
  devVarsPath?: string;
  internalSecret?: string;
  fetchImpl?: FetchLike;
  browserFactory?: () => Promise<Browser>;
  now?: () => number;
}

export interface LocalDevSmokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_NEXT_URL = "http://localhost:3001";
const DEFAULT_WORKER_URL = "http://127.0.0.1:8787";
const DEFAULT_LOG_PATH = "packages/web/.next/dev/logs/next-development.log";
const DEFAULT_SHARED_DIST_PATH = "packages/shared/dist/index.js";
const DEFAULT_DEV_VARS_PATH = "packages/server/.dev.vars";

const FATAL_LOG_PATTERNS = [
  /Module not found/i,
  /Can't resolve '@open-inspect\/shared'/i,
  /Could not resolve\s+"@open-inspect\/shared"/i,
  /build-manifest\.json/i,
  /Internal Server Error/i,
  /Persisting failed/i,
  /ENOENT: no such file or directory/i,
];

const FATAL_PAGE_TEXT = [/Internal Server Error/i, /This site can't be reached/i];

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readFileLength(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function readFileFrom(path: string, offset: number): string {
  try {
    const buffer = fs.readFileSync(path);
    return buffer.subarray(Math.min(offset, buffer.length)).toString("utf8");
  } catch {
    return "";
  }
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    const vars: Record<string, string> = {};
    for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index);
      let value = line.slice(index + 1);
      try {
        value = JSON.parse(value);
      } catch {
        value = value.replace(/^['"]|['"]$/g, "");
      }
      vars[key] = value;
    }
    return vars;
  } catch {
    return {};
  }
}

function findFatalLogLine(log: string): string | null {
  for (const line of log.split(/\r?\n/)) {
    if (FATAL_LOG_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.trim();
    }
  }
  return null;
}

function buildInternalAuthHeaders(secret: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");
  return { Authorization: `Bearer ${timestamp}.${signature}` };
}

async function assertHttpOk(
  fetchImpl: FetchLike,
  url: string,
  label: string,
  expectedStatus?: number
): Promise<string> {
  const response = await fetchImpl(url);
  const body = await response.text();
  const ok =
    expectedStatus === undefined
      ? response.status >= 200 && response.status < 300
      : response.status === expectedStatus;

  if (!ok) {
    throw new Error(`${label} returned ${response.status}: ${body.slice(0, 240)}`);
  }

  return body;
}

async function assertWorkerJsonOk(
  fetchImpl: FetchLike,
  workerUrl: string,
  path: string,
  headers: Record<string, string>
): Promise<string> {
  const response = await fetchImpl(`${workerUrl}${path}`, { headers });
  const body = await response.text();

  if (response.status >= 500) {
    throw new Error(`worker ${path} returned ${response.status}: ${body.slice(0, 240)}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `worker ${path} rejected internal auth with ${response.status}: ${body.slice(0, 240)}`
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`worker ${path} returned ${response.status}: ${body.slice(0, 240)}`);
  }

  return body;
}

async function assertDaytonaAuthOk(
  fetchImpl: FetchLike,
  devVars: Record<string, string>
): Promise<string> {
  const provider = devVars.SANDBOX_PROVIDER || "modal";
  if (provider !== "daytona") {
    return `daytona_auth=skipped provider=${provider}`;
  }

  const apiUrl = normalizeBaseUrl(devVars.DAYTONA_API_URL || "https://app.daytona.io/api");
  const apiKey = devVars.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("daytona_auth=failed missing DAYTONA_API_KEY");
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (devVars.DAYTONA_ORGANIZATION_ID) {
    headers["X-Daytona-Organization-ID"] = devVars.DAYTONA_ORGANIZATION_ID;
  }

  const response = await fetchImpl(`${apiUrl}/sandbox`, { headers });
  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error(`daytona_auth=failed status=${response.status} ${body.slice(0, 240)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`daytona_auth=failed status=${response.status} ${body.slice(0, 240)}`);
  }

  return `daytona_auth=ok status=${response.status}`;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  );
}

function assertDaytonaCallbackUrl(devVars: Record<string, string>): string {
  const provider = devVars.SANDBOX_PROVIDER || "modal";
  if (provider !== "daytona") {
    return `daytona_callback_url=skipped provider=${provider}`;
  }

  const workerUrl = devVars.WORKER_URL || "";
  if (!workerUrl) {
    throw new Error(
      "daytona_callback_url=failed missing WORKER_URL. Daytona sandboxes need a public Worker URL to connect back."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(workerUrl);
  } catch {
    throw new Error(`daytona_callback_url=failed invalid WORKER_URL=${workerUrl}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `daytona_callback_url=failed WORKER_URL must be public https for Daytona, got ${workerUrl}`
    );
  }

  if (isLocalHostname(parsed.hostname)) {
    throw new Error(
      `daytona_callback_url=failed WORKER_URL points at local machine (${workerUrl}); use a deployed Worker or a tunnel URL.`
    );
  }

  return `daytona_callback_url=ok host=${parsed.hostname}`;
}

async function checkBrowserPage(browser: Browser, nextUrl: string): Promise<string[]> {
  const context: BrowserContext = await browser.newContext();
  const page: Page = await context.newPage();
  const errors: string[] = [];

  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });

  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (status >= 500) {
      errors.push(`response ${status}: ${url}`);
    }
  });

  const response = await page.goto(nextUrl, { waitUntil: "networkidle", timeout: 30_000 });
  if (!response) {
    errors.push("browser navigation produced no response");
  } else if (response.status() >= 400) {
    errors.push(`document returned ${response.status()}`);
  }

  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 10_000 })
    .catch(() => "");
  for (const pattern of FATAL_PAGE_TEXT) {
    if (pattern.test(bodyText)) {
      errors.push(`page rendered fatal text: ${pattern}`);
    }
  }

  await context.close();
  return errors;
}

export async function runLocalDevSmoke(
  options: LocalDevSmokeOptions = {}
): Promise<LocalDevSmokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const nextUrl = normalizeBaseUrl(
    options.nextUrl ?? process.env.LOCAL_DEV_NEXT_URL ?? DEFAULT_NEXT_URL
  );
  const workerUrl = normalizeBaseUrl(
    options.workerUrl ?? process.env.LOCAL_DEV_WORKER_URL ?? DEFAULT_WORKER_URL
  );
  const logPath = options.logPath ?? process.env.LOCAL_DEV_NEXT_LOG ?? DEFAULT_LOG_PATH;
  const sharedDistPath =
    options.sharedDistPath ?? process.env.LOCAL_DEV_SHARED_DIST ?? DEFAULT_SHARED_DIST_PATH;
  const devVarsPath =
    options.devVarsPath ?? process.env.LOCAL_DEV_SERVER_VARS ?? DEFAULT_DEV_VARS_PATH;
  const devVars = parseEnvFile(devVarsPath);
  const internalSecret =
    options.internalSecret ??
    process.env.LOCAL_DEV_INTERNAL_CALLBACK_SECRET ??
    devVars.INTERNAL_CALLBACK_SECRET;
  const beforeLogOffset = readFileLength(logPath);

  try {
    if (!fs.existsSync(sharedDistPath)) {
      throw new Error(
        `${sharedDistPath} is missing. Run npm run build -w @open-inspect/shared before starting local dev.`
      );
    }
    stdout.push(`shared_dist=ok path=${sharedDistPath}`);

    const workerBody = await assertHttpOk(fetchImpl, `${workerUrl}/health`, "worker health");
    stdout.push(`worker_health=ok ${workerBody.slice(0, 120)}`);

    if (!internalSecret) {
      throw new Error(
        `missing INTERNAL_CALLBACK_SECRET for local Worker route checks. Set LOCAL_DEV_INTERNAL_CALLBACK_SECRET or provide ${devVarsPath}.`
      );
    }
    const internalHeaders = buildInternalAuthHeaders(internalSecret);
    const sessionsBody = await assertWorkerJsonOk(
      fetchImpl,
      workerUrl,
      "/sessions",
      internalHeaders
    );
    stdout.push(`worker_sessions=ok bytes=${sessionsBody.length}`);
    const reposBody = await assertWorkerJsonOk(fetchImpl, workerUrl, "/repos", internalHeaders);
    stdout.push(`worker_repos=ok bytes=${reposBody.length}`);
    stdout.push(assertDaytonaCallbackUrl(devVars));
    stdout.push(await assertDaytonaAuthOk(fetchImpl, devVars));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const body = await assertHttpOk(fetchImpl, `${nextUrl}/`, `next page attempt ${attempt}`);
      if (FATAL_PAGE_TEXT.some((pattern) => pattern.test(body))) {
        throw new Error(`next page attempt ${attempt} rendered fatal text`);
      }
      stdout.push(`next_page_${attempt}=ok bytes=${body.length}`);
    }

    const browser = options.browserFactory
      ? await options.browserFactory()
      : await chromium.launch({ headless: true });
    try {
      const browserErrors = await checkBrowserPage(browser, `${nextUrl}/`);
      if (browserErrors.length > 0) {
        throw new Error(`browser smoke failed:\n${browserErrors.join("\n")}`);
      }
      stdout.push("browser_render=ok");
    } finally {
      await browser.close();
    }

    const newLog = readFileFrom(logPath, beforeLogOffset);
    const fatalLogLine = findFatalLogLine(newLog);
    if (fatalLogLine) {
      throw new Error(`next_dev_log=fatal ${fatalLogLine}`);
    }
    stdout.push("next_dev_log=ok");
    stdout.push("local_dev_smoke=ok");
    return { exitCode: 0, stdout: stdout.join("\n") + "\n", stderr: "" };
  } catch (error) {
    stderr.push(error instanceof Error ? error.message : String(error));
    return {
      exitCode: 1,
      stdout: stdout.join("\n") + (stdout.length ? "\n" : ""),
      stderr: stderr.join("\n") + "\n",
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runLocalDevSmoke();
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode);
}
