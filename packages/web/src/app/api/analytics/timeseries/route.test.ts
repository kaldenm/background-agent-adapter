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
import { GET } from "./route";

describe("analytics timeseries API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/analytics/timeseries?days=30") as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("forwards only the days query param", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(serverFetch).mockResolvedValue(Response.json({ series: [] }, { status: 200 }));

    const response = await GET(
      new Request("http://localhost/api/analytics/timeseries?trace=1&view=status&days=7") as never
    );

    expect(serverFetch).toHaveBeenCalledWith("/analytics/timeseries?days=7");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ series: [] });
  });

  it("passes through upstream error statuses", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(serverFetch).mockResolvedValue(
      Response.json({ error: "Bad request" }, { status: 400 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/timeseries?days=14") as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Bad request" });
  });
});
