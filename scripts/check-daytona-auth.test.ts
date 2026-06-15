import assert from "node:assert/strict";
import test from "node:test";
import { runDaytonaAuthProbe } from "./check-daytona-auth.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("reports global credential rejection when read-only Daytona probes all return 401", async () => {
  const calls: string[] = [];

  const result = await runDaytonaAuthProbe({
    args: ["--env", "missing.env"],
    cwd: "/tmp",
    env: {
      DAYTONA_API_URL: "https://daytona.test/api",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base-snapshot",
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(401, { message: "Invalid credentials" });
    },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, [
    "https://daytona.test/api/sandbox",
    "https://daytona.test/api/organizations",
    "https://daytona.test/api/regions",
    "https://daytona.test/api/snapshots",
  ]);
  assert.match(result.stderr ?? "", /GET \/sandbox status=401 message=Invalid credentials/);
  assert.match(
    result.stderr ?? "",
    /read-only diagnostics=\/organizations:401:Invalid credentials/
  );
  assert.match(result.stderr ?? "", /credential_scope=global_rejection/);
  assert.match(result.stderr ?? "", /api_key=<present>/);
});

test("sends organization header and returns runtime warnings for missing optional runtime config", async () => {
  let capturedHeaders: HeadersInit | undefined;

  const result = await runDaytonaAuthProbe({
    args: ["--env", "missing.env"],
    cwd: "/tmp",
    env: {
      DAYTONA_API_URL: "https://daytona.test/api/",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_ORGANIZATION_ID: "org-123",
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = init?.headers;
      return jsonResponse(200, { data: [] });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capturedHeaders, {
    Authorization: "Bearer daytona-key",
    "X-Daytona-Organization-ID": "org-123",
  });
  assert.match(result.stdout ?? "", /Daytona auth ok: GET \/sandbox status=200/);
  assert.doesNotMatch(result.stdout ?? "", /DAYTONA_ORGANIZATION_ID is not set/);
  assert.match(result.stdout ?? "", /DAYTONA_TARGET is not set/);
  assert.match(result.stdout ?? "", /DAYTONA_BASE_SNAPSHOT is not set/);
});
