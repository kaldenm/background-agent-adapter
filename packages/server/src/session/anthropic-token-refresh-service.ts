/**
 * Anthropic OAuth token refresh service.
 *
 * Mirrors OpenAITokenRefreshService but handles Anthropic's rotating refresh
 * tokens. Every refresh returns a NEW refresh token — the old one is revoked.
 * This service persists the rotated token back to D1 so the next sandbox
 * gets a valid token.
 *
 * Without this service, the first sandbox to refresh the token invalidates
 * the stored copy, and every subsequent sandbox fails auth (the user has to
 * re-link Claude each time).
 */

import { refreshAnthropicToken, AnthropicTokenRefreshError } from "../auth/anthropic";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const ANTHROPIC_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

type AnthropicTokenState =
  | { type: "cached"; accessToken: string; expiresIn: number }
  | { type: "refresh"; refreshToken: string; source: "repo" | "global"; repoId: number };

export type AnthropicTokenRefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresIn?: number }
  | { ok: false; status: number; error: string };

export class AnthropicTokenRefreshService {
  constructor(
    private readonly db: Env["DB"],
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {}

  async refresh(session: SessionRow): Promise<AnthropicTokenRefreshResult> {
    const readTokenState = () => this.readTokenState(session);

    let tokenState: AnthropicTokenState | null;
    try {
      tokenState = await readTokenState();
    } catch (e) {
      this.log.error("Failed to read Anthropic token state from secrets", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }

    if (!tokenState) {
      return { ok: false, status: 404, error: "ANTHROPIC_OAUTH_TOKEN not configured" };
    }

    if (tokenState.type === "cached") {
      // We still need the refresh token for the sandbox to use later,
      // so re-read it from secrets
      const secrets = await this.readRawSecrets(session);
      const refreshToken = secrets?.ANTHROPIC_OAUTH_TOKEN;
      if (!refreshToken) {
        return { ok: false, status: 404, error: "ANTHROPIC_OAUTH_TOKEN not configured" };
      }
      return {
        ok: true,
        accessToken: tokenState.accessToken,
        refreshToken,
        expiresIn: tokenState.expiresIn,
      };
    }

    try {
      return await this.attemptRefresh(tokenState, session);
    } catch (e) {
      if (e instanceof AnthropicTokenRefreshError && e.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState, session);
      }

      this.log.error("Anthropic token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "Anthropic token refresh failed" };
    }
  }

  /**
   * Persist a rotated refresh token sent back from the sandbox.
   *
   * Called when the sandbox (Pi) refreshes the token internally and
   * reports the new refresh token back via the sync-back endpoint.
   */
  async persistRotatedToken(
    session: SessionRow,
    newRefreshToken: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const repoId = await this.ensureRepoId(session);

      // Check repo secrets first, then global
      const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
      const repoSecrets = await repoStore.getDecryptedSecrets(repoId);

      if (repoSecrets.ANTHROPIC_OAUTH_TOKEN) {
        await repoStore.setSecrets(repoId, session.repo_owner, session.repo_name, {
          ANTHROPIC_OAUTH_TOKEN: newRefreshToken,
          // Clear cached access token — it's from the old refresh token
          ANTHROPIC_OAUTH_ACCESS_TOKEN: "",
          ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
        });
        this.log.info("Anthropic refresh token rotated (repo secrets)");
        return { ok: true };
      }

      // Fall back to global secrets
      const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
      await globalStore.setSecrets({
        ANTHROPIC_OAUTH_TOKEN: newRefreshToken,
        ANTHROPIC_OAUTH_ACCESS_TOKEN: "",
        ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
      });
      this.log.info("Anthropic refresh token rotated (global secrets)");
      return { ok: true };
    } catch (e) {
      this.log.error("Failed to persist rotated Anthropic token", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, error: "Failed to persist rotated token" };
    }
  }

  private getTokenStateFromSecrets(
    secrets: Record<string, string>,
    source: "repo" | "global",
    repoId: number
  ): AnthropicTokenState | null {
    if (!secrets.ANTHROPIC_OAUTH_TOKEN) {
      return null;
    }

    const cachedToken = secrets.ANTHROPIC_OAUTH_ACCESS_TOKEN;
    const expiresAt = parseInt(secrets.ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();

    if (cachedToken && expiresAt - now > ANTHROPIC_TOKEN_REFRESH_BUFFER_MS) {
      return {
        type: "cached",
        accessToken: cachedToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
      };
    }

    return {
      type: "refresh",
      refreshToken: secrets.ANTHROPIC_OAUTH_TOKEN,
      source,
      repoId,
    };
  }

  private async readTokenState(session: SessionRow): Promise<AnthropicTokenState | null> {
    const repoId = await this.ensureRepoId(session);

    const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
    const repoSecrets = await repoStore.getDecryptedSecrets(repoId);
    const repoState = this.getTokenStateFromSecrets(repoSecrets, "repo", repoId);
    if (repoState) {
      return repoState;
    }

    const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();
    return this.getTokenStateFromSecrets(globalSecrets, "global", repoId);
  }

  private async readRawSecrets(session: SessionRow): Promise<Record<string, string> | null> {
    const repoId = await this.ensureRepoId(session);

    const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
    const repoSecrets = await repoStore.getDecryptedSecrets(repoId);
    if (repoSecrets.ANTHROPIC_OAUTH_TOKEN) return repoSecrets;

    const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();
    if (globalSecrets.ANTHROPIC_OAUTH_TOKEN) return globalSecrets;

    return null;
  }

  private async attemptRefresh(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    session: SessionRow
  ): Promise<AnthropicTokenRefreshResult> {
    const tokens = await refreshAnthropicToken(tokenState.refreshToken);
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    // CRITICAL: Persist the rotated refresh token back to D1.
    // Without this, the old refresh token is now revoked and the next
    // sandbox will fail auth.
    try {
      const secretsToWrite: Record<string, string> = {
        ANTHROPIC_OAUTH_TOKEN: tokens.refresh_token,
        ANTHROPIC_OAUTH_ACCESS_TOKEN: tokens.access_token,
        ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
      };

      if (tokenState.source === "repo") {
        const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
        await repoStore.setSecrets(
          tokenState.repoId,
          session.repo_owner,
          session.repo_name,
          secretsToWrite
        );
      } else {
        const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
        await globalStore.setSecrets(secretsToWrite);
      }

      this.log.info("Anthropic tokens rotated and cached", {
        source: tokenState.source,
      });
    } catch (e) {
      this.log.error("Failed to store rotated Anthropic tokens", {
        error: e instanceof Error ? e.message : String(e),
      });
      // Still return the tokens — sandbox can use them this once even if
      // persistence failed. But next sandbox will be broken.
    }

    return {
      ok: true,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    };
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    readTokenState: () => Promise<AnthropicTokenState | null>,
    session: SessionRow
  ): Promise<AnthropicTokenRefreshResult> {
    this.log.warn("Anthropic refresh got 401, checking for concurrent rotation", {
      source: tokenState.source,
    });

    // Wait briefly for a concurrent refresh to land
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const reread = await readTokenState();

      if (reread?.type === "cached") {
        this.log.info("Using cached access token from concurrent rotation");
        const secrets = await this.readRawSecrets(session);
        return {
          ok: true,
          accessToken: reread.accessToken,
          refreshToken: secrets?.ANTHROPIC_OAUTH_TOKEN || "",
          expiresIn: reread.expiresIn,
        };
      }

      if (reread?.type === "refresh" && reread.refreshToken !== tokenState.refreshToken) {
        this.log.info("Detected concurrent token rotation, retrying");
        return this.attemptRefresh(reread, session);
      }
    } catch (retryErr) {
      this.log.error("Retry after 401 also failed", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return {
      ok: false,
      status: 401,
      error:
        "Anthropic token refresh failed: unauthorized. The Claude integration may need to be re-linked.",
    };
  }
}
