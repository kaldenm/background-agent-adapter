import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { Env } from "../types";
import type { SessionRow } from "./types";
import { AnthropicTokenRefreshService } from "./anthropic-token-refresh-service";
import { AnthropicTokenRefreshError } from "../auth/anthropic";

// ---------------------------------------------------------------------------
// Shared mock state — survives vi.mock() hoisting
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  repoSecrets: new Map<number, Record<string, string>>(),
  globalSecrets: {} as Record<string, string>,
  refreshImpl: vi.fn(),
  repoWrites: [] as Array<{
    repoId: number;
    owner: string;
    name: string;
    secrets: Record<string, string>;
  }>,
  globalWrites: [] as Array<Record<string, string>>,
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../auth/anthropic", () => {
  class MockAnthropicTokenRefreshError extends Error {
    status: number;
    body: string;
    constructor(message: string, status: number, body: string) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  return {
    AnthropicTokenRefreshError: MockAnthropicTokenRefreshError,
    refreshAnthropicToken: (refreshToken: string) => mockState.refreshImpl(refreshToken),
  };
});

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
      return mockState.repoSecrets.get(repoId) ?? {};
    }

    async setSecrets(
      repoId: number,
      owner: string,
      name: string,
      secrets: Record<string, string>
    ): Promise<void> {
      mockState.repoWrites.push({ repoId, owner, name, secrets });
      const existing = mockState.repoSecrets.get(repoId) ?? {};
      mockState.repoSecrets.set(repoId, { ...existing, ...secrets });
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets(): Promise<Record<string, string>> {
      return mockState.globalSecrets;
    }

    async setSecrets(secrets: Record<string, string>): Promise<void> {
      mockState.globalWrites.push(secrets);
      mockState.globalSecrets = { ...mockState.globalSecrets, ...secrets };
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-name-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

function createService() {
  return new AnthropicTokenRefreshService(
    {} as Env["DB"],
    "enc-key",
    async () => 123,
    createLogger()
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnthropicTokenRefreshService", () => {
  beforeEach(() => {
    mockState.repoSecrets.clear();
    mockState.globalSecrets = {};
    mockState.repoWrites = [];
    mockState.globalWrites = [];
    mockState.refreshImpl.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Core refresh + persist ────────────────────────────────────────

  it("returns 404 when no ANTHROPIC_OAUTH_TOKEN in repo or global secrets", async () => {
    const result = await createService().refresh(createSession());

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "ANTHROPIC_OAUTH_TOKEN not configured",
    });
  });

  it("refreshes token from global secrets and persists the ROTATED refresh token back", async () => {
    // Simulate: user linked Claude, refresh token stored in global secrets
    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_TOKEN: "refresh-v1",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0", // expired
    };

    // Anthropic returns a NEW refresh token (rotation!)
    mockState.refreshImpl.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-v2", // ← this is the rotated token
      expires_in: 3600,
    });

    const result = await createService().refresh(createSession());

    // Service returns success
    expect(result).toEqual({
      ok: true,
      accessToken: "access-new",
      refreshToken: "refresh-v2",
      expiresIn: 3600,
    });

    // CRITICAL: the rotated refresh token was written back to global secrets
    expect(mockState.globalWrites).toHaveLength(1);
    expect(mockState.globalWrites[0].ANTHROPIC_OAUTH_TOKEN).toBe("refresh-v2");
    expect(mockState.globalWrites[0].ANTHROPIC_OAUTH_ACCESS_TOKEN).toBe("access-new");

    // The old token was used for the refresh call
    expect(mockState.refreshImpl).toHaveBeenCalledWith("refresh-v1");
  });

  it("refreshes token from repo secrets and persists back to repo secrets", async () => {
    mockState.repoSecrets.set(123, {
      ANTHROPIC_OAUTH_TOKEN: "repo-refresh-v1",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });

    mockState.refreshImpl.mockResolvedValue({
      access_token: "repo-access-new",
      refresh_token: "repo-refresh-v2",
      expires_in: 1800,
    });

    const result = await createService().refresh(createSession());

    expect(result).toEqual({
      ok: true,
      accessToken: "repo-access-new",
      refreshToken: "repo-refresh-v2",
      expiresIn: 1800,
    });

    // Written to repo secrets, not global
    expect(mockState.repoWrites).toHaveLength(1);
    expect(mockState.repoWrites[0].secrets.ANTHROPIC_OAUTH_TOKEN).toBe("repo-refresh-v2");
    expect(mockState.globalWrites).toHaveLength(0);
  });

  // ── Cached access token ───────────────────────────────────────────

  it("returns cached access token when still valid (no refresh call)", async () => {
    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_TOKEN: "refresh-v1",
      ANTHROPIC_OAUTH_ACCESS_TOKEN: "cached-access",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
    };

    const result = await createService().refresh(createSession());

    expect(result).toMatchObject({
      ok: true,
      accessToken: "cached-access",
      refreshToken: "refresh-v1",
    });
    // No refresh call made — used cached token
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
  });

  // ── The exact bug scenario ────────────────────────────────────────

  it("simulates the full two-sandbox rotation scenario", async () => {
    const service = createService;

    // Step 1: User links Claude → refresh_token_v1 in global secrets
    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_TOKEN: "refresh-v1",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };

    // Step 2: Sandbox 1 calls refresh → gets v2, service persists v2 to D1
    mockState.refreshImpl.mockResolvedValueOnce({
      access_token: "access-from-v1",
      refresh_token: "refresh-v2",
      expires_in: 3600,
    });

    const result1 = await service().refresh(createSession());
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error("unreachable");
    expect(result1.accessToken).toBe("access-from-v1");
    expect(result1.refreshToken).toBe("refresh-v2");

    // Verify D1 now has refresh-v2 (the rotated token)
    expect(mockState.globalSecrets.ANTHROPIC_OAUTH_TOKEN).toBe("refresh-v2");

    // Step 3: Sandbox 2 calls refresh → uses v2 (which is valid!)
    // Clear the cached access token to force a refresh
    mockState.globalSecrets.ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT = "0";
    mockState.globalSecrets.ANTHROPIC_OAUTH_ACCESS_TOKEN = "";

    mockState.refreshImpl.mockResolvedValueOnce({
      access_token: "access-from-v2",
      refresh_token: "refresh-v3",
      expires_in: 3600,
    });

    const result2 = await service().refresh(createSession());
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error("unreachable");
    expect(result2.accessToken).toBe("access-from-v2");
    expect(result2.refreshToken).toBe("refresh-v3");

    // The refresh was called with v2 (not the dead v1!)
    expect(mockState.refreshImpl).toHaveBeenLastCalledWith("refresh-v2");

    // D1 now has v3
    expect(mockState.globalSecrets.ANTHROPIC_OAUTH_TOKEN).toBe("refresh-v3");
  });

  // ── Sync-back from sandbox ────────────────────────────────────────

  it("persistRotatedToken writes new refresh token to global secrets", async () => {
    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_TOKEN: "old-refresh",
    };

    const result = await createService().persistRotatedToken(
      createSession(),
      "sandbox-rotated-refresh"
    );

    expect(result).toEqual({ ok: true });
    expect(mockState.globalWrites).toHaveLength(1);
    expect(mockState.globalWrites[0].ANTHROPIC_OAUTH_TOKEN).toBe("sandbox-rotated-refresh");
    // Cached access token should be cleared
    expect(mockState.globalWrites[0].ANTHROPIC_OAUTH_ACCESS_TOKEN).toBe("");
  });

  it("persistRotatedToken writes to repo secrets when token is stored there", async () => {
    mockState.repoSecrets.set(123, {
      ANTHROPIC_OAUTH_TOKEN: "repo-old-refresh",
    });

    const result = await createService().persistRotatedToken(
      createSession(),
      "repo-sandbox-rotated"
    );

    expect(result).toEqual({ ok: true });
    expect(mockState.repoWrites).toHaveLength(1);
    expect(mockState.repoWrites[0].secrets.ANTHROPIC_OAUTH_TOKEN).toBe("repo-sandbox-rotated");
    expect(mockState.globalWrites).toHaveLength(0); // NOT written to global
  });

  // ── 401 handling (concurrent rotation) ────────────────────────────

  it("retries with updated token when refresh gets 401 from concurrent rotation", async () => {
    vi.useFakeTimers();

    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_TOKEN: "refresh-stale",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };

    // First refresh fails with 401 (another sandbox already rotated)
    mockState.refreshImpl.mockImplementationOnce(async () => {
      // Simulate: another sandbox rotated the token concurrently
      mockState.globalSecrets = {
        ANTHROPIC_OAUTH_TOKEN: "refresh-concurrent",
        ANTHROPIC_OAUTH_ACCESS_TOKEN: "access-concurrent",
        ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      };
      throw new AnthropicTokenRefreshError("unauthorized", 401, "unauthorized");
    });

    const promise = createService().refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toMatchObject({
      ok: true,
      accessToken: "access-concurrent",
      refreshToken: "refresh-concurrent",
    });
  });

  it("returns 401 error when refresh token is truly revoked (no concurrent rotation)", async () => {
    vi.useFakeTimers();

    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_TOKEN: "refresh-dead",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };

    mockState.refreshImpl.mockRejectedValue(
      new AnthropicTokenRefreshError("unauthorized", 401, "unauthorized")
    );

    const promise = createService().refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({
      ok: false,
      status: 401,
      error:
        "Anthropic token refresh failed: unauthorized. The Claude integration may need to be re-linked.",
    });
  });
});
