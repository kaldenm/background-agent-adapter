// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { DataControlsSettings } from "./data-controls-settings";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const archivedSessionsKey = "/api/sessions?status=archived&limit=20&offset=0";

function createArchivedSession() {
  return {
    id: "session-1",
    title: "Archived Session",
    repoOwner: "open-inspect",
    repoName: "background-agents",
    status: "archived",
    createdAt: 1000,
    updatedAt: 2000,
  };
}

function renderDataControls() {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: {
          [archivedSessionsKey]: {
            sessions: [createArchivedSession()],
          },
        },
        dedupingInterval: 0,
        revalidateOnFocus: false,
      }}
    >
      <DataControlsSettings />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DataControlsSettings delete archived sessions", () => {
  it("deletes an archived session after confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1" && init?.method === "DELETE") {
        return Response.json({ status: "deleted", sessionId: "session-1" });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderDataControls();

    expect(await screen.findByText("Archived Session")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(screen.queryByText("Archived Session")).not.toBeInTheDocument();
    });
  });

  it("restores an archived session when delete fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1" && init?.method === "DELETE") {
        return Response.json({ error: "Failed to delete session" }, { status: 500 });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderDataControls();

    expect(await screen.findByText("Archived Session")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1", { method: "DELETE" });
    });
    expect(screen.getByText("Archived Session")).toBeInTheDocument();
  });
});
