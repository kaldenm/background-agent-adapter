import assert from "node:assert/strict";
import test from "node:test";
import { runDaytonaLiveSmoke } from "./daytona-live-smoke.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body = ""): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(body, { status });
}

const env = {
  DAYTONA_API_URL: "https://daytona.test/api",
  DAYTONA_API_KEY: "fake-secret-for-redaction-test",
  DAYTONA_ORGANIZATION_ID: "org-123",
  DAYTONA_TARGET: "target-1",
  DAYTONA_BASE_SNAPSHOT: "operator-owned-snapshot",
};

test("refuses to create a sandbox without explicit live opt-in", async () => {
  const result = await runDaytonaLiveSmoke({
    args: ["--env", "missing.env"],
    cwd: "/tmp",
    env,
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Re-run with --create-sandbox/);
});

test("creates, inspects, stops, and deletes a disposable Daytona sandbox", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const toolboxResult = [
    "python=Python 3.12.1",
    "node=v22.1.0",
    "git=git version 2.40.1",
    "workspace=ok",
    "app_runtime=ok",
    "sandbox_runtime_import=ok",
    "agent_browser=ok",
    "code_server=ok",
  ].join("\n");

  const result = await runDaytonaLiveSmoke({
    args: ["--create-sandbox", "--env", "missing.env"],
    cwd: "/tmp",
    env,
    sleep: async () => undefined,
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (url === "https://daytona.test/api/sandbox" && (!init?.method || init.method === "GET")) {
        return jsonResponse(200, { items: [] });
      }
      if (url === "https://daytona.test/api/sandbox" && init?.method === "POST") {
        return jsonResponse(200, { id: "sandbox-live-smoke", state: "creating" });
      }
      if (url === "https://daytona.test/api/sandbox/sandbox-live-smoke") {
        if (init?.method === "DELETE") return textResponse(204);
        return jsonResponse(200, { id: "sandbox-live-smoke", state: "started" });
      }
      if (
        url === "https://proxy.app.daytona.io/toolbox/sandbox-live-smoke/process/execute" &&
        init?.method === "POST"
      ) {
        return jsonResponse(200, { result: toolboxResult });
      }
      if (
        url === "https://daytona.test/api/sandbox/sandbox-live-smoke/stop" &&
        init?.method === "POST"
      ) {
        return textResponse(200);
      }
      return jsonResponse(500, { message: `unexpected ${init?.method ?? "GET"} ${url}` });
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /auth_probe=ok/);
  assert.match(result.stdout ?? "", /snapshot_existence=proven_by_sandbox_create/);
  assert.match(result.stdout ?? "", /toolbox_runtime_checks=ok/);
  assert.doesNotMatch(result.stdout ?? "", /fake-secret-for-redaction-test/);

  const createCall = calls.find(
    (call) => call.url === "https://daytona.test/api/sandbox" && call.method === "POST"
  );
  assert.equal(
    (createCall?.body as { snapshot?: string } | undefined)?.snapshot,
    env.DAYTONA_BASE_SNAPSHOT
  );

  assert.ok(
    calls.some(
      (call) =>
        call.url === "https://daytona.test/api/sandbox/sandbox-live-smoke/stop" &&
        call.method === "POST"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url === "https://daytona.test/api/sandbox/sandbox-live-smoke" &&
        call.method === "DELETE"
    )
  );
});

test("retries cleanup when Daytona is still changing sandbox state", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let deleteAttempts = 0;
  let sleepCalls = 0;
  const toolboxResult = [
    "python=Python 3.12.1",
    "node=v22.1.0",
    "git=git version 2.40.1",
    "workspace=ok",
    "app_runtime=ok",
    "sandbox_runtime_import=ok",
    "agent_browser=ok",
    "code_server=ok",
  ].join("\n");

  const result = await runDaytonaLiveSmoke({
    args: ["--create-sandbox", "--env", "missing.env"],
    cwd: "/tmp",
    env,
    sleep: async () => {
      sleepCalls += 1;
    },
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });

      if (url === "https://daytona.test/api/sandbox" && (!init?.method || init.method === "GET")) {
        return jsonResponse(200, { items: [] });
      }
      if (url === "https://daytona.test/api/sandbox" && init?.method === "POST") {
        return jsonResponse(200, { id: "sandbox-live-smoke", state: "creating" });
      }
      if (url === "https://daytona.test/api/sandbox/sandbox-live-smoke") {
        if (init?.method === "DELETE") {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            return jsonResponse(409, { message: "Sandbox state change in progress" });
          }
          return textResponse(204);
        }
        return jsonResponse(200, { id: "sandbox-live-smoke", state: "started" });
      }
      if (
        url === "https://proxy.app.daytona.io/toolbox/sandbox-live-smoke/process/execute" &&
        init?.method === "POST"
      ) {
        return jsonResponse(200, { result: toolboxResult });
      }
      if (
        url === "https://daytona.test/api/sandbox/sandbox-live-smoke/stop" &&
        init?.method === "POST"
      ) {
        return textResponse(200);
      }
      return jsonResponse(500, { message: `unexpected ${init?.method ?? "GET"} ${url}` });
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(deleteAttempts, 2);
  assert.equal(sleepCalls, 1);
  assert.ok(
    calls.some(
      (call) =>
        call.url === "https://daytona.test/api/sandbox/sandbox-live-smoke" &&
        call.method === "DELETE"
    )
  );
});

test("redacts the API key if Daytona returns it in an error body", async () => {
  const result = await runDaytonaLiveSmoke({
    args: ["--create-sandbox", "--env", "missing.env"],
    cwd: "/tmp",
    env,
    fetchImpl: async () => jsonResponse(401, { message: `bad ${env.DAYTONA_API_KEY}` }),
  });

  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.stderr ?? "", /fake-secret-for-redaction-test/);
  assert.match(result.stderr ?? "", /<redacted>/);
});
