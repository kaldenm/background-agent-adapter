import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";
import { resolveRepoOrError } from "./routes/shared";

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

vi.mock("./routes/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn(),
  };
});

describe("handleCreateSession scheduler dispatch", () => {
  const secret = "test-internal-secret";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      defaultBranch: "main",
    } as never);
  });

  async function createSessionRequest(
    env: Record<string, unknown>,
    bodyOverrides?: Record<string, unknown>
  ): Promise<Response> {
    const token = await generateInternalToken(secret);

    return handleRequest(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repoOwner: "Acme",
          repoName: "Web-App",
          title: "Test session",
          model: "anthropic/claude-sonnet-4-6",
          ...bodyOverrides,
        }),
      }),
      env as never
    );
  }

  function createSchedulerFetch(
    responseBody: Record<string, unknown> = { sessionId: "sched-session-1", status: "created" },
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

  function createEnv(schedulerFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };

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
        get: () => ({ fetch: vi.fn() }),
      },
      SCHEDULER: {
        idFromName: (_name: string) => "scheduler-do-id",
        get: () => ({ fetch: schedulerFetch }),
      },
    };
  }

  it("dispatches to the scheduler and returns the session ID", async () => {
    const schedulerFetch = createSchedulerFetch();
    const response = await createSessionRequest(createEnv(schedulerFetch));

    expect(response.status).toBe(201);
    const payload = await response.json<{ sessionId: string; status: string }>();
    expect(payload.sessionId).toBe("sched-session-1");
    expect(payload.status).toBe("created");

    // Verify scheduler was called
    expect(schedulerFetch).toHaveBeenCalledOnce();
    const [url, init] = schedulerFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://internal/internal/dispatch");

    // Verify dispatch payload
    const dispatchBody = JSON.parse(init.body as string);
    expect(dispatchBody.session.repoOwner).toBe("acme");
    expect(dispatchBody.session.repoName).toBe("web-app");
    expect(dispatchBody.session.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("returns 500 when scheduler dispatch fails", async () => {
    const schedulerFetch = createSchedulerFetch({ error: "internal" }, 500);
    const response = await createSessionRequest(createEnv(schedulerFetch));

    expect(response.status).toBe(500);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toBe("Failed to create session");
  });

  it("returns 503 when scheduler is not configured", async () => {
    const env = createEnv(vi.fn());
    delete env.SCHEDULER;

    const response = await createSessionRequest(env);
    expect(response.status).toBe(503);
  });

  it("sends prompt in dispatch payload when provided", async () => {
    const schedulerFetch = createSchedulerFetch();
    const response = await createSessionRequest(createEnv(schedulerFetch), {
      prompt: "Build the thing",
    });

    expect(response.status).toBe(201);
    const [, init2] = schedulerFetch.mock.calls[0] as unknown as [string, RequestInit];
    const dispatchBody = JSON.parse(init2.body as string);
    expect(dispatchBody.prompt).toBeDefined();
    expect(dispatchBody.prompt.content).toBe("Build the thing");
    expect(dispatchBody.prompt.source).toBe("user");
  });

  it("omits prompt from dispatch payload when not provided", async () => {
    const schedulerFetch = createSchedulerFetch();
    const response = await createSessionRequest(createEnv(schedulerFetch));

    expect(response.status).toBe(201);
    const [, init3] = schedulerFetch.mock.calls[0] as unknown as [string, RequestInit];
    const dispatchBody = JSON.parse(init3.body as string);
    expect(dispatchBody.prompt).toBeUndefined();
  });
});
