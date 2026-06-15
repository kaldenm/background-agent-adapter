import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";

const { mockDelete } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
}));

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(() => ({
    delete: mockDelete,
  })),
}));

describe("handleDeleteSession", () => {
  const secret = "test-internal-secret";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockDelete.mockResolvedValue(undefined);
  });

  function createEnv(overrides: Record<string, unknown> = {}) {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };

    const sessionFetch = vi.fn(async () => Response.json({ status: "cancelled" }));

    return {
      INTERNAL_CALLBACK_SECRET: secret,
      SCM_PROVIDER: "github",
      DB: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: sessionFetch }),
      },
      ...overrides,
    };
  }

  async function deleteSession(env: Record<string, unknown>, sessionId = "session-1") {
    const token = await generateInternalToken(secret);

    return handleRequest(
      new Request(`https://test.local/sessions/${sessionId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env as never
    );
  }

  it("deletes the session index and reports no sandbox cleanup when Daytona is not configured", async () => {
    const response = await deleteSession(createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "deleted",
      sessionId: "session-1",
      sandboxCleanup: {
        provider: null,
        status: "not_configured",
        deletedIds: [],
      },
    });
    expect(mockDelete).toHaveBeenCalledWith("session-1");
  });

  it("deletes Daytona sandboxes matching the session label and reports their IDs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://daytona.test/sandbox" && !init?.method) {
        return Response.json({
          items: [
            { id: "sandbox-match", labels: { openinspect_session_id: "session-1" } },
            { id: "sandbox-other", labels: { openinspect_session_id: "other-session" } },
          ],
        });
      }

      if (url === "https://daytona.test/sandbox/sandbox-match" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await deleteSession(
      createEnv({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_API_URL: "https://daytona.test",
        DAYTONA_API_KEY: "daytona-key",
        DAYTONA_ORGANIZATION_ID: "org-123",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "deleted",
      sessionId: "session-1",
      sandboxCleanup: {
        provider: "daytona",
        status: "deleted",
        deletedIds: ["sandbox-match"],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://daytona.test/sandbox", {
      headers: {
        Authorization: "Bearer daytona-key",
        "X-Daytona-Organization-ID": "org-123",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://daytona.test/sandbox/sandbox-match", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer daytona-key",
        "X-Daytona-Organization-ID": "org-123",
      },
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://daytona.test/sandbox/sandbox-other",
      expect.anything()
    );
    expect(mockDelete).toHaveBeenCalledWith("session-1");
  });

  it("still deletes the session index and reports failed sandbox cleanup when Daytona fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://daytona.test/sandbox") {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await deleteSession(
      createEnv({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_API_URL: "https://daytona.test",
        DAYTONA_API_KEY: "daytona-key",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "deleted",
      sessionId: "session-1",
      sandboxCleanup: {
        provider: "daytona",
        status: "failed",
        deletedIds: [],
        error: "Failed to list Daytona sandboxes: 503",
      },
    });
    expect(mockDelete).toHaveBeenCalledWith("session-1");
  });
});
