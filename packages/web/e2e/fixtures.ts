import type { Page, Route } from "@playwright/test";

type MockSession = {
  id: string;
  title: string;
  repoOwner: string;
  repoName: string;
  status: string;
  updatedAt: number;
  createdAt: number;
  model?: string;
  branch?: string | null;
};

const activeSession: MockSession = {
  id: "session-e2e-active",
  title: "Fix the flaky checkout flow",
  repoOwner: "acme",
  repoName: "web-app",
  status: "active",
  updatedAt: 1_781_546_000_000,
  createdAt: 1_781_545_900_000,
  model: "anthropic/claude-sonnet-4-20250514",
  branch: "main",
};

const archivedSession: MockSession = {
  id: "session-e2e-archived",
  title: "Archived cleanup target",
  repoOwner: "acme",
  repoName: "web-app",
  status: "archived",
  updatedAt: 1_781_545_800_000,
  createdAt: 1_781_545_700_000,
  model: "anthropic/claude-sonnet-4-20250514",
  branch: "main",
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function mockUnauthenticatedApp(page: Page) {
  await page.route("**/api/auth/session", (route) => json(route, {}));
}

export async function mockSessionWebSocketWithAgentReply(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sessionState = {
      id: "session-e2e-active",
      title: "Fix the flaky checkout flow",
      repoOwner: "acme",
      repoName: "web-app",
      baseBranch: "main",
      branchName: "main",
      status: "active",
      sandboxStatus: "ready",
      messageCount: 2,
      createdAt: 1_781_545_900,
      model: "anthropic/claude-sonnet-4-20250514",
      isProcessing: false,
      totalCost: 0.01,
    };

    class MockSessionWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = MockSessionWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        window.setTimeout(() => {
          this.readyState = MockSessionWebSocket.OPEN;
          const event = new Event("open");
          this.onopen?.(event);
          this.dispatchEvent(event);
        }, 0);
      }

      send(payload: string) {
        const message = JSON.parse(payload) as { type?: string };
        if (message.type !== "subscribe") return;

        window.setTimeout(() => {
          const event = new MessageEvent("message", {
            data: JSON.stringify({
              type: "subscribed",
              sessionId: "session-e2e-active",
              state: sessionState,
              artifacts: [],
              participantId: "participant-e2e",
              participant: { participantId: "participant-e2e", name: "E2E User" },
              replay: {
                events: [
                  {
                    type: "user_message",
                    content: "Fix the checkout retry bug",
                    timestamp: 1_781_545_910,
                    author: { participantId: "participant-e2e", name: "E2E User" },
                  },
                  {
                    type: "token",
                    content: "I found the retry handler and added a failing regression test.",
                    messageId: "message-e2e-assistant",
                    sandboxId: "sandbox-e2e",
                    timestamp: 1_781_545_920,
                  },
                  {
                    type: "execution_complete",
                    messageId: "message-e2e-assistant",
                    sandboxId: "sandbox-e2e",
                    success: true,
                    timestamp: 1_781_545_930,
                  },
                ],
                hasMore: false,
                cursor: null,
              },
            }),
          });
          this.onmessage?.(event);
          this.dispatchEvent(event);
        }, 0);
      }

      close() {
        this.readyState = MockSessionWebSocket.CLOSED;
        const event = new Event("close") as CloseEvent;
        this.onclose?.(event);
        this.dispatchEvent(event);
      }
    }

    Object.assign(MockSessionWebSocket, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    });

    window.WebSocket = function WebSocket(url: string | URL, protocols?: string | string[]) {
      const wsUrl = String(url);
      if (wsUrl.includes("/sessions/session-e2e-active/ws")) {
        return new MockSessionWebSocket(wsUrl) as unknown as WebSocket;
      }
      return new NativeWebSocket(url, protocols);
    } as unknown as typeof WebSocket;

    Object.assign(window.WebSocket, {
      CONNECTING: NativeWebSocket.CONNECTING,
      OPEN: NativeWebSocket.OPEN,
      CLOSING: NativeWebSocket.CLOSING,
      CLOSED: NativeWebSocket.CLOSED,
      prototype: NativeWebSocket.prototype,
    });
  });

  await page.route("**/api/sessions/session-e2e-active/ws-token", (route) =>
    json(route, { token: "ws-token-e2e" })
  );
}

export async function mockSessionWebSocketWithDaytonaFailure(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sessionState = {
      id: "session-e2e-active",
      title: "Fix the flaky checkout flow",
      repoOwner: "acme",
      repoName: "web-app",
      baseBranch: "main",
      branchName: "main",
      status: "active",
      sandboxStatus: "failed",
      messageCount: 0,
      createdAt: 1_781_545_900,
      model: "anthropic/claude-sonnet-4-20250514",
      isProcessing: false,
      totalCost: 0,
    };

    class MockFailedSandboxWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = MockFailedSandboxWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        window.setTimeout(() => {
          this.readyState = MockFailedSandboxWebSocket.OPEN;
          const event = new Event("open");
          this.onopen?.(event);
          this.dispatchEvent(event);
        }, 0);
      }

      send(payload: string) {
        const message = JSON.parse(payload) as { type?: string };
        if (message.type !== "subscribe") return;

        window.setTimeout(() => {
          const event = new MessageEvent("message", {
            data: JSON.stringify({
              type: "subscribed",
              sessionId: "session-e2e-active",
              state: sessionState,
              artifacts: [],
              participantId: "participant-e2e",
              participant: { participantId: "participant-e2e", name: "E2E User" },
              replay: {
                events: [],
                hasMore: false,
                cursor: null,
              },
              spawnError:
                'Failed to create Daytona sandbox: {"path":"/api/sandbox","statusCode":401,"error":"Unauthorized","message":"Invalid credentials"}',
            }),
          });
          this.onmessage?.(event);
          this.dispatchEvent(event);
        }, 0);
      }

      close() {
        this.readyState = MockFailedSandboxWebSocket.CLOSED;
        const event = new Event("close") as CloseEvent;
        this.onclose?.(event);
        this.dispatchEvent(event);
      }
    }

    Object.assign(MockFailedSandboxWebSocket, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    });

    window.WebSocket = function WebSocket(url: string | URL, protocols?: string | string[]) {
      const wsUrl = String(url);
      if (wsUrl.includes("/sessions/session-e2e-active/ws")) {
        return new MockFailedSandboxWebSocket(wsUrl) as unknown as WebSocket;
      }
      return new NativeWebSocket(url, protocols);
    } as unknown as typeof WebSocket;

    Object.assign(window.WebSocket, {
      CONNECTING: NativeWebSocket.CONNECTING,
      OPEN: NativeWebSocket.OPEN,
      CLOSING: NativeWebSocket.CLOSING,
      CLOSED: NativeWebSocket.CLOSED,
      prototype: NativeWebSocket.prototype,
    });
  });

  await page.route("**/api/sessions/session-e2e-active/ws-token", (route) =>
    json(route, { token: "ws-token-e2e" })
  );
}

export async function mockAuthenticatedApp(page: Page) {
  let anthropicConnected = false;
  let anthropicApiKeySaved = false;
  let deletedArchivedSession = false;

  await page.route("**/api/auth/session", (route) =>
    json(route, {
      user: {
        id: "user-e2e",
        name: "E2E User",
        email: "e2e@example.com",
        image: null,
      },
      expires: "2099-01-01T00:00:00.000Z",
    })
  );

  await page.route("**/api/repos", (route) =>
    json(route, {
      repos: [
        {
          id: 12345,
          fullName: "acme/web-app",
          owner: "acme",
          name: "web-app",
          description: "Mocked repository for browser E2E tests",
          private: true,
          defaultBranch: "main",
        },
      ],
    })
  );

  await page.route("**/api/repos/acme/web-app/branches", (route) =>
    json(route, { branches: [{ name: "main" }, { name: "feature/e2e" }] })
  );

  await page.route("**/api/model-preferences", (route) =>
    json(route, {
      enabledModels: ["anthropic/claude-sonnet-4-20250514"],
    })
  );

  await page.route("**/api/sessions?status=archived&limit=20&offset=0", (route) =>
    json(route, {
      sessions: deletedArchivedSession ? [] : [archivedSession],
      hasMore: false,
    })
  );

  await page.route("**/api/sessions?limit=50&offset=0", (route) =>
    json(route, {
      sessions: [activeSession],
      hasMore: false,
    })
  );

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") {
      return json(route, { sessionId: "session-e2e-new", status: "created" }, 201);
    }
    return json(route, { sessions: [activeSession], hasMore: false });
  });

  await page.route("**/api/sessions/session-e2e-new/prompt", (route) =>
    json(route, { success: true })
  );

  await page.route("**/api/sessions/session-e2e-active/archive", (route) =>
    json(route, { success: true })
  );

  await page.route("**/api/sessions/session-e2e-active/children", (route) =>
    json(route, { children: [] })
  );

  await page.route("**/api/sessions/session-e2e-archived", (route) => {
    if (route.request().method() === "DELETE") {
      deletedArchivedSession = true;
      return json(route, { success: true, sandboxCleanup: { attempted: false } });
    }
    return json(route, archivedSession);
  });

  await page.route("**/api/secrets", async (route) => {
    if (route.request().method() === "PUT") {
      const body = (await route.request().postDataJSON()) as {
        secrets?: Record<string, string>;
      };
      if (body.secrets?.ANTHROPIC_API_KEY) {
        anthropicApiKeySaved = true;
      }
      return json(route, { success: true });
    }

    const secrets = [];
    if (anthropicApiKeySaved) secrets.push({ key: "ANTHROPIC_API_KEY" });
    if (anthropicConnected) secrets.push({ key: "ANTHROPIC_OAUTH_TOKEN" });
    return json(route, { secrets });
  });

  await page.route("**/api/auth/anthropic/exchange", (route) => {
    anthropicConnected = true;
    return json(route, { success: true });
  });
}
