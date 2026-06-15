import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/server", () => ({
  serverFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { serverFetch } from "@/lib/server";
import { DELETE } from "./route";

describe("session delete API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function deleteRequest(id = "session-1") {
    return DELETE(new Request(`http://localhost/api/sessions/${id}`) as never, {
      params: Promise.resolve({ id }),
    });
  }

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await deleteRequest();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it("proxies an authenticated delete to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(serverFetch).mockResolvedValue(
      Response.json({
        status: "deleted",
        sessionId: "session-1",
        sandboxCleanup: { provider: null, status: "not_configured", deletedIds: [] },
      })
    );

    const response = await deleteRequest();

    expect(serverFetch).toHaveBeenCalledWith("/sessions/session-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "deleted",
      sessionId: "session-1",
      sandboxCleanup: { provider: null, status: "not_configured", deletedIds: [] },
    });
  });

  it("preserves control plane delete failures", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(serverFetch).mockResolvedValue(
      Response.json({ error: "Session not found" }, { status: 404 })
    );

    const response = await deleteRequest();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });

  it("returns 500 when the control plane request throws", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(serverFetch).mockRejectedValue(new Error("boom"));

    const response = await deleteRequest();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to delete session" });
  });
});
