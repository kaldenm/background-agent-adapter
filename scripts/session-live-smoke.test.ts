import assert from "node:assert/strict";
import test from "node:test";
import { runSessionLiveSmoke } from "./session-live-smoke.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.({});
  }

  emitMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const env = {
  OPEN_INSPECT_BASE_URL: "https://open-inspect.test",
  OPEN_INSPECT_WS_URL: "wss://open-inspect.test",
  OPEN_INSPECT_COOKIE: "next-auth.session-token=fake-secret-cookie",
  OPEN_INSPECT_SMOKE_REPO: "owner/repo",
};

test("fails closed when no logged-in auth is provided", async () => {
  const result = await runSessionLiveSmoke({
    env: {
      OPEN_INSPECT_BASE_URL: "https://open-inspect.test",
      OPEN_INSPECT_SMOKE_REPO: "owner/repo",
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /OPEN_INSPECT_COOKIE/);
});

test("creates an authenticated session, observes completion over websocket, and deletes it", async () => {
  FakeWebSocket.instances = [];
  const calls: Array<{ url: string; method: string; body?: unknown; cookie?: string }> = [];
  let deleted = false;

  const resultPromise = runSessionLiveSmoke({
    env,
    sleep: async () => undefined,
    now: (() => {
      let current = 1_000;
      return () => (current += 500);
    })(),
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        cookie: (init?.headers as Record<string, string> | undefined)?.Cookie,
      });

      if (url === "https://open-inspect.test/api/sessions" && init?.method === "POST") {
        return jsonResponse(201, { sessionId: "session-smoke", status: "created" });
      }
      if (
        url === "https://open-inspect.test/api/sessions/session-smoke/ws-token" &&
        init?.method === "POST"
      ) {
        return jsonResponse(200, { token: "ws-token-123" });
      }
      if (
        url === "https://open-inspect.test/api/sessions/session-smoke" &&
        init?.method === "DELETE"
      ) {
        deleted = true;
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(500, { error: `unexpected ${init?.method ?? "GET"} ${url}` });
    },
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  });

  while (FakeWebSocket.instances.length === 0) {
    await Promise.resolve();
  }

  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, "wss://open-inspect.test/sessions/session-smoke/ws");
  ws.emitOpen();
  ws.emitMessage({
    type: "subscribed",
    sessionId: "session-smoke",
    state: { id: "session-smoke" },
    artifacts: [],
    participantId: "participant-1",
  });
  ws.emitMessage({ type: "sandbox_ready" });
  ws.emitMessage({
    type: "sandbox_event",
    event: {
      type: "token",
      content: "OPEN_INSPECT_SMOKE_OK",
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 1,
    },
  });
  ws.emitMessage({
    type: "sandbox_event",
    event: {
      type: "execution_complete",
      success: true,
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 2,
    },
  });

  const result = await resultPromise;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /session_create=ok id=session-smoke/);
  assert.match(result.stdout ?? "", /ws_subscribed=ok/);
  assert.match(result.stdout ?? "", /session_live_smoke=ok/);
  assert.doesNotMatch(result.stdout ?? "", /fake-secret-cookie/);
  assert.equal(deleted, true);

  const createCall = calls.find((call) => call.url === "https://open-inspect.test/api/sessions");
  assert.equal(createCall?.cookie, env.OPEN_INSPECT_COOKIE);
  assert.deepEqual(createCall?.body, {
    repoOwner: "owner",
    repoName: "repo",
    title: "Daytona live smoke 1970-01-01T00:00:01.500Z",
    prompt: "Reply with exactly OPEN_INSPECT_SMOKE_OK. Do not create files or make changes.",
  });

  const sentSubscribe = JSON.parse(ws.sent[0]);
  assert.equal(sentSubscribe.type, "subscribe");
  assert.equal(sentSubscribe.token, "ws-token-123");
});

test("redacts auth material from failed deployed API responses", async () => {
  const result = await runSessionLiveSmoke({
    env,
    fetchImpl: async () => jsonResponse(401, { error: `bad ${env.OPEN_INSPECT_COOKIE}` }),
  });

  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.stderr ?? "", /fake-secret-cookie/);
  assert.match(result.stderr ?? "", /<redacted>/);
});
