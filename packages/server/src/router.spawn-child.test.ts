import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { generateInternalToken } from "./auth/internal";
import { SessionIndexStore } from "./db/session-index";

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

describe("handleSpawnChild scheduler dispatch", () => {
  const parentId = "parent-session-1";

  const spawnContext = {
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: "main",
    owner: {
      userId: "user-1",
      scmLogin: "acmedev",
      scmName: "Acme Dev",
      scmEmail: "dev@acme.test",
      scmAccessTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
      scmTokenExpiresAt: null,
      scmUserId: null,
    },
  };

  const makeStore = (parentUserId: string | null = null) => ({
    get: vi.fn().mockResolvedValue({ userId: parentUserId }),
    getSpawnDepth: vi.fn().mockResolvedValue(0),
    countActiveChildren: vi.fn().mockResolvedValue(0),
    countTotalChildren: vi.fn().mockResolvedValue(0),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createSchedulerFetch(
    responseBody: Record<string, unknown> = { sessionId: "child-session-1", status: "created" },
    status = 201
  ) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify(responseBody), {
          status,
          headers: { "Content-Type": "application/json" },
        })
    );
  }

  async function makeRequest(env: Record<string, unknown>): Promise<Response> {
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET as string);

    return handleRequest(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: "Child task", prompt: "Do the thing" }),
      }),
      env as never
    );
  }

  function createEnv(schedulerFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    return {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: (id: string) => (id === parentId ? parentStub : { fetch: vi.fn() }),
      },
      SCHEDULER: {
        idFromName: (_name: string) => "scheduler-do-id",
        get: () => ({ fetch: schedulerFetch }),
      },
    };
  }

  it("returns 201 when scheduler dispatch succeeds", async () => {
    const store = makeStore("canonical-user-123");
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const schedulerFetch = createSchedulerFetch();
    const response = await makeRequest(createEnv(schedulerFetch));

    expect(response.status).toBe(201);
    const payload = await response.json<{ sessionId: string; status: string }>();
    expect(payload.sessionId).toBe("child-session-1");
    expect(payload.status).toBe("created");

    // Verify scheduler was called with correct payload
    expect(schedulerFetch).toHaveBeenCalledOnce();
    const [url, init] = schedulerFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://internal/internal/dispatch");

    const dispatchBody = JSON.parse(init.body as string);
    expect(dispatchBody.session.repoOwner).toBe("acme");
    expect(dispatchBody.session.repoName).toBe("web-app");
    expect(dispatchBody.session.parentSessionId).toBe(parentId);
    expect(dispatchBody.session.spawnSource).toBe("agent");
    expect(dispatchBody.session.spawnDepth).toBe(1);
    expect(dispatchBody.session.userId).toBe("canonical-user-123");
    expect(dispatchBody.prompt.content).toBe("Do the thing");
    expect(dispatchBody.prompt.source).toBe("agent");
  });

  it("returns 400 when child specifies an invalid model", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const schedulerFetch = createSchedulerFetch();
    const env = createEnv(schedulerFetch);

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET as string);

    const response = await handleRequest(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "Child task",
          prompt: "Do the thing",
          model: "not-a-real-model",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(400);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain('Invalid model "not-a-real-model"');
    expect(payload.error).toContain("Valid models:");
    // Scheduler should NOT have been called
    expect(schedulerFetch).not.toHaveBeenCalled();
  });

  it("returns 400 when child specifies an empty-string model", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const schedulerFetch = createSchedulerFetch();
    const env = createEnv(schedulerFetch);

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET as string);

    const response = await handleRequest(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "Child task",
          prompt: "Do the thing",
          model: "",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(400);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain('Invalid model ""');
    expect(schedulerFetch).not.toHaveBeenCalled();
  });

  it("returns 500 when scheduler dispatch fails", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const schedulerFetch = createSchedulerFetch({ error: "internal" }, 500);
    const response = await makeRequest(createEnv(schedulerFetch));

    expect(response.status).toBe(500);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toBe("Failed to create child session");
  });

  it("returns 503 when scheduler is not configured", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const env = createEnv(vi.fn());
    delete env.SCHEDULER;

    const response = await makeRequest(env);
    expect(response.status).toBe(503);
  });
});
