import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright";
import { runLocalDevSmoke } from "./local-dev-smoke.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "open-inspect-local-dev-smoke-"));
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function fakeBrowser(bodyText = "Open Inspect"): Browser {
  const page = {
    on() {},
    async goto() {
      return { status: () => 200 };
    },
    locator() {
      return {
        async innerText() {
          return bodyText;
        },
      };
    },
  };

  const context = {
    async newPage() {
      return page;
    },
    async close() {},
  };

  return {
    async newContext() {
      return context;
    },
    async close() {},
  } as unknown as Browser;
}

test("fails before probing servers when shared dist is missing", async () => {
  const dir = tempDir();
  const result = await runLocalDevSmoke({
    sharedDistPath: path.join(dir, "missing.js"),
    logPath: path.join(dir, "next.log"),
    internalSecret: "secret",
    fetchImpl: async () => textResponse(200, "ok"),
    browserFactory: async () => fakeBrowser(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /missing\.js is missing/i);
});

test("passes when worker, repeated page loads, browser render, and log are healthy", async () => {
  const dir = tempDir();
  const sharedDistPath = path.join(dir, "index.js");
  const logPath = path.join(dir, "next.log");
  fs.writeFileSync(sharedDistPath, "export {};\n");
  fs.writeFileSync(logPath, "");

  const result = await runLocalDevSmoke({
    sharedDistPath,
    logPath,
    internalSecret: "secret",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.endsWith("/health")) {
        return textResponse(200, '{"status":"healthy"}');
      }
      if (href.endsWith("/sessions")) {
        return textResponse(200, '{"sessions":[],"total":0,"hasMore":false}');
      }
      if (href.endsWith("/repos")) {
        return textResponse(200, '{"repos":[]}');
      }
      return textResponse(200, "<html><body>Open Inspect</body></html>");
    },
    browserFactory: async () => fakeBrowser(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /browser_render=ok/);
  assert.match(result.stdout, /local_dev_smoke=ok/);
});

test("fails when new Next dev log output contains the module-resolution failure", async () => {
  const dir = tempDir();
  const sharedDistPath = path.join(dir, "index.js");
  const logPath = path.join(dir, "next.log");
  fs.writeFileSync(sharedDistPath, "export {};\n");
  fs.writeFileSync(logPath, "old clean log\n");

  const result = await runLocalDevSmoke({
    sharedDistPath,
    logPath,
    internalSecret: "secret",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/health")) {
        return textResponse(200, '{"status":"healthy"}');
      }
      if (String(url).endsWith("/sessions")) {
        return textResponse(200, '{"sessions":[],"total":0,"hasMore":false}');
      }
      if (String(url).endsWith("/repos")) {
        return textResponse(200, '{"repos":[]}');
      }
      fs.appendFileSync(logPath, "Module not found: Can't resolve '@open-inspect/shared'\n");
      return textResponse(200, "<html><body>Open Inspect</body></html>");
    },
    browserFactory: async () => fakeBrowser(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /next_dev_log=fatal/);
  assert.match(result.stderr, /@open-inspect\/shared/);
});

test("fails when local Worker repo listing is broken", async () => {
  const dir = tempDir();
  const sharedDistPath = path.join(dir, "index.js");
  const logPath = path.join(dir, "next.log");
  fs.writeFileSync(sharedDistPath, "export {};\n");
  fs.writeFileSync(logPath, "");

  const result = await runLocalDevSmoke({
    sharedDistPath,
    logPath,
    internalSecret: "secret",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.endsWith("/health")) {
        return textResponse(200, '{"status":"healthy"}');
      }
      if (href.endsWith("/sessions")) {
        return textResponse(200, '{"sessions":[],"total":0,"hasMore":false}');
      }
      if (href.endsWith("/repos")) {
        return textResponse(500, '{"error":"SCM provider not configured"}');
      }
      return textResponse(200, "<html><body>Open Inspect</body></html>");
    },
    browserFactory: async () => fakeBrowser(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /worker \/repos returned 500/);
  assert.match(result.stderr, /SCM provider not configured/);
});

test("fails when Daytona rejects the configured local API key", async () => {
  const dir = tempDir();
  const sharedDistPath = path.join(dir, "index.js");
  const logPath = path.join(dir, "next.log");
  const devVarsPath = path.join(dir, ".dev.vars");
  fs.writeFileSync(sharedDistPath, "export {};\n");
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(
    devVarsPath,
    [
      'INTERNAL_CALLBACK_SECRET="secret"',
      'SANDBOX_PROVIDER="daytona"',
      'WORKER_URL="https://worker.example.test"',
      'DAYTONA_API_URL="https://daytona.test/api"',
      'DAYTONA_API_KEY="bad-key"',
    ].join("\n")
  );

  const result = await runLocalDevSmoke({
    sharedDistPath,
    logPath,
    devVarsPath,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.endsWith("/health")) {
        return textResponse(200, '{"status":"healthy"}');
      }
      if (href.endsWith("/sessions")) {
        return textResponse(200, '{"sessions":[],"total":0,"hasMore":false}');
      }
      if (href.endsWith("/repos")) {
        return textResponse(200, '{"repos":[]}');
      }
      if (href === "https://daytona.test/api/sandbox") {
        return textResponse(401, '{"message":"Invalid credentials"}');
      }
      return textResponse(200, "<html><body>Open Inspect</body></html>");
    },
    browserFactory: async () => fakeBrowser(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /daytona_auth=failed status=401/);
  assert.match(result.stderr, /Invalid credentials/);
});

test("fails when Daytona callback URL points at localhost", async () => {
  const dir = tempDir();
  const sharedDistPath = path.join(dir, "index.js");
  const logPath = path.join(dir, "next.log");
  const devVarsPath = path.join(dir, ".dev.vars");
  fs.writeFileSync(sharedDistPath, "export {};\n");
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(
    devVarsPath,
    [
      'INTERNAL_CALLBACK_SECRET="secret"',
      'SANDBOX_PROVIDER="daytona"',
      'WORKER_URL="http://localhost:8787"',
      'DAYTONA_API_URL="https://daytona.test/api"',
      'DAYTONA_API_KEY="daytona-key"',
    ].join("\n")
  );

  const result = await runLocalDevSmoke({
    sharedDistPath,
    logPath,
    devVarsPath,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.endsWith("/health")) {
        return textResponse(200, '{"status":"healthy"}');
      }
      if (href.endsWith("/sessions")) {
        return textResponse(200, '{"sessions":[],"total":0,"hasMore":false}');
      }
      if (href.endsWith("/repos")) {
        return textResponse(200, '{"repos":[]}');
      }
      return textResponse(200, "<html><body>Open Inspect</body></html>");
    },
    browserFactory: async () => fakeBrowser(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /daytona_callback_url=failed/);
  assert.match(result.stderr, /localhost:8787/);
});
