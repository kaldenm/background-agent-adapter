/**
 * Shared session creation.
 *
 * One function to create a session. Used by:
 * - Router (web UI, bots)
 * - Scheduler (automations)
 * - Child spawn (agent sub-tasks)
 *
 * Handles: ID generation, D1 index write, SessionDO init.
 * D1 write happens first — if it fails, no sandbox gets spawned.
 */

import type { SpawnSource, SandboxSettings } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import type { Env } from "../types";

export interface CreateSessionOptions {
  // --- required: every session needs these ---
  repoOwner: string;
  repoName: string;
  userId: string;
  spawnSource: SpawnSource;

  // --- optional: pass what you have ---
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  repoId?: number | null;
  defaultBranch?: string | null;
  branch?: string | null;

  // SCM identity — router/bots pass these, scheduler doesn't
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmToken?: string | null;
  scmTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
  scmUserId?: string | null;

  // parent — only child spawn
  parentSessionId?: string | null;
  spawnDepth?: number;

  // automation — only scheduler
  automationId?: string | null;
  automationRunId?: string | null;

  // sandbox config — router and child spawn
  codeServerEnabled?: boolean;
  sandboxSettings?: SandboxSettings | null;
}

export interface CreateSessionResult {
  sessionId: string;
}

/**
 * Create a session: write to D1 index, then init the SessionDO.
 *
 * D1 first — if D1 fails, no sandbox gets spawned (safe).
 * Returns the generated session ID.
 */
export async function createSession(
  env: Env,
  options: CreateSessionOptions
): Promise<CreateSessionResult> {
  const sessionId = generateId();
  const now = Date.now();

  // 1. Write to D1 index first (fail before any sandbox can spawn)
  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.create({
    id: sessionId,
    title: options.title ?? null,
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    model: options.model ?? "claude-sonnet-4-20250514",
    reasoningEffort: options.reasoningEffort ?? null,
    baseBranch: options.branch ?? options.defaultBranch ?? "main",
    status: "created",
    parentSessionId: options.parentSessionId ?? null,
    spawnSource: options.spawnSource,
    spawnDepth: options.spawnDepth ?? 0,
    automationId: options.automationId ?? null,
    automationRunId: options.automationRunId ?? null,
    scmLogin: options.scmLogin ?? null,
    userId: options.userId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  // 2. Init the SessionDO
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const initResponse = await stub.fetch("http://internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionName: sessionId,
      repoOwner: options.repoOwner,
      repoName: options.repoName,
      repoId: options.repoId ?? undefined,
      defaultBranch: options.defaultBranch ?? undefined,
      branch: options.branch ?? undefined,
      title: options.title ?? undefined,
      model: options.model ?? undefined,
      reasoningEffort: options.reasoningEffort ?? undefined,
      userId: options.userId,
      scmLogin: options.scmLogin ?? undefined,
      scmName: options.scmName ?? undefined,
      scmEmail: options.scmEmail ?? undefined,
      scmToken: options.scmToken ?? undefined,
      scmTokenEncrypted: options.scmTokenEncrypted ?? undefined,
      scmRefreshTokenEncrypted: options.scmRefreshTokenEncrypted ?? undefined,
      scmTokenExpiresAt: options.scmTokenExpiresAt ?? undefined,
      scmUserId: options.scmUserId ?? undefined,
      parentSessionId: options.parentSessionId ?? undefined,
      spawnSource: options.spawnSource,
      spawnDepth: options.spawnDepth ?? 0,
      codeServerEnabled: options.codeServerEnabled ?? undefined,
      sandboxSettings: options.sandboxSettings ?? undefined,
    }),
  });

  if (!initResponse.ok) {
    throw new Error(`Session init failed with status ${initResponse.status}`);
  }

  return { sessionId };
}

/**
 * Send a prompt to an existing session.
 */
export async function promptSession(
  env: Env,
  sessionId: string,
  options: {
    content: string;
    authorId: string;
    source?: string;
    callbackContext?: Record<string, unknown>;
  }
): Promise<void> {
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  const promptResponse = await stub.fetch("http://internal/internal/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: options.content,
      authorId: options.authorId,
      source: options.source ?? "user",
      callbackContext: options.callbackContext,
    }),
  });

  if (!promptResponse.ok) {
    throw new Error(`Prompt enqueue failed with status ${promptResponse.status}`);
  }
}
