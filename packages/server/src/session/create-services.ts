/**
 * Service factory — constructs all session services in dependency order.
 *
 * Extracted from Session class to separate wiring/plumbing from domain logic.
 * Session calls createServices() once; the returned object replaces 17 lazy getters.
 */

import { generateId, hashToken, encryptToken } from "../auth/crypto";
import { getGitHubAppConfig, getCachedInstallationToken } from "../auth/github-app";
import { createModalClient } from "../sandbox/client";
import { createDaytonaRestClient } from "../sandbox/daytona-rest-client";
import { createModalProvider } from "../sandbox/providers/modal-provider";
import { createDaytonaProvider } from "../sandbox/providers/daytona-provider";
import { resolveSandboxBackendName } from "../sandbox/provider-name";
import type { Logger } from "../logger";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager as LifecycleWebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
  type RepoImageLookup,
  type McpServerLookup,
} from "../sandbox/lifecycle/manager";
import { RepoImageStore } from "../db/repo-images";
import { McpServerStore } from "../db/mcp-servers";
import { DEFAULT_EXECUTION_TIMEOUT_MS } from "../sandbox/lifecycle/decisions";
import {
  createSourceControlProvider as createSourceControlProviderImpl,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type GitPushSpec,
} from "../source-control";
import { DEFAULT_MODEL } from "../utils/models";
import type { Env, ServerMessage, SandboxEvent, SessionState, SessionStatus } from "../types";
import type { SessionRow, ArtifactRow, SandboxRow } from "./types";
import type { SessionRepository } from "./repository";
import { createKvCacheStore } from "@open-inspect/shared";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { SessionPullRequestService } from "./pull-request-service";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { AnthropicTokenRefreshService } from "./anthropic-token-refresh-service";
import { ParticipantService } from "./participant-service";
import { SessionServer } from "./session-server";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import { CallbackNotificationService } from "./callback-notification-service";
import { DOFetcherAdapter } from "../scheduler/do-fetcher-adapter";
import { PresenceService } from "./presence-service";
import { SessionMessageQueue } from "./message-queue";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import { createMessagesHandler, type MessagesHandler } from "./http/handlers/messages.handler";
import {
  createChildSessionsHandler,
  type ChildSessionsHandler,
} from "./http/handlers/child-sessions.handler";
import { createSandboxHandler, type SandboxHandler } from "./http/handlers/sandbox.handler";
import { createWsTokenHandler, type WsTokenHandler } from "./http/handlers/ws-token.handler";
import {
  createSessionLifecycleHandler,
  type SessionLifecycleHandler,
} from "./http/handlers/session-lifecycle.handler";
import {
  createPullRequestHandler,
  type PullRequestHandler,
} from "./http/handlers/pull-request.handler";
import {
  createParticipantsHandler,
  type ParticipantsHandler,
} from "./http/handlers/participants.handler";
import { MessageService } from "./services/message.service";
import { createAlarmHandler, type AlarmHandler } from "./alarm/handler";

/** Timeout for WebSocket authentication (in milliseconds). */
const WS_AUTH_TIMEOUT_MS = 30000;

// ─── Dependencies the Session class provides ───────────────────────────

export interface SessionCoreDeps {
  // Platform primitives
  ctx: DurableObjectState;
  env: Env;
  log: Logger;
  repository: SessionRepository;

  // Session-level state readers
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getSessionState: (sandbox?: SandboxRow | null) => Promise<SessionState>;
  getPublicSessionId: (session?: SessionRow | null) => string;
  getIsProcessing: () => boolean;
  getUserEnvVars: () => Promise<Record<string, string> | undefined>;
  ensureRepoId: (session: SessionRow) => Promise<number>;

  // Mutation callbacks
  broadcast: (message: ServerMessage) => void;
  safeSend: (ws: WebSocket, message: string | object) => boolean;
  updateSandboxStatus: (status: string) => void;
  updateLastActivity: (timestamp: number) => void;
  transitionSessionStatus: (status: SessionStatus) => Promise<boolean>;
  reconcileSessionStatusAfterExecution: (success: boolean) => Promise<void>;
  scheduleInactivityCheck: () => Promise<void>;
  triggerSnapshot: (reason: string) => Promise<void>;
  spawnSandbox: () => Promise<void>;
  stopExecution: (options?: { suppressStatusReconcile?: boolean }) => Promise<void>;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  pushBranchToRemote: (
    branchName: string,
    pushSpec: GitPushSpec
  ) => Promise<{ success: true } | { success: false; error: string }>;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
  isValidSandboxToken: (token: string | null, sandbox: SandboxRow | null) => Promise<boolean>;
}

// ─── The services object returned by createServices ────────────────────

export interface SessionServices {
  wsManager: SessionWebSocketManager;
  lifecycleManager: SandboxLifecycleManager;
  sourceControlProvider: SourceControlProvider;
  participantService: ParticipantService;
  callbackService: CallbackNotificationService;
  presenceService: PresenceService;
  messageQueue: SessionMessageQueue;
  messageService: MessageService;
  messagesHandler: MessagesHandler;
  childSessionsHandler: ChildSessionsHandler;
  sandboxHandler: SandboxHandler;
  wsTokenHandler: WsTokenHandler;
  sessionLifecycleHandler: SessionLifecycleHandler;
  pullRequestHandler: PullRequestHandler;
  participantsHandler: ParticipantsHandler;
  alarmHandler: AlarmHandler;
  sessionServer: SessionServer;
  sandboxEventProcessor: SessionSandboxEventProcessor;
  executionTimeoutMs: number;
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createServices(deps: SessionCoreDeps): SessionServices {
  const { ctx, env, log, repository } = deps;
  const servicesRef = {} as SessionServices;

  // ── Layer 0: Leaf services (no service deps) ────────────────────────

  const wsManager: SessionWebSocketManager = new SessionWebSocketManagerImpl(ctx, repository, log, {
    authTimeoutMs: WS_AUTH_TIMEOUT_MS,
  });

  const sourceControlProvider = createSourceControlProviderImpl({
    provider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    github: {
      appConfig: getGitHubAppConfig(env) ?? undefined,
      cacheStore: createKvCacheStore(env.REPOS_CACHE),
    },
  });

  const userScmTokenStore =
    env.DB && env.TOKEN_ENCRYPTION_KEY
      ? new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY)
      : null;

  const participantService = new ParticipantService({
    repository,
    env,
    log,
    generateId: () => generateId(),
    userScmTokenStore,
  });

  const schedulerCallback = env.SCHEDULER
    ? new DOFetcherAdapter(env.SCHEDULER, "global-scheduler")
    : undefined;

  const callbackService = new CallbackNotificationService({
    repository,
    env: { ...env, SCHEDULER_CALLBACK: schedulerCallback },
    log,
    getSessionId: () => {
      const session = deps.getSession();
      return session?.session_name || session?.id || ctx.id.toString();
    },
  });

  const participantsHandler: ParticipantsHandler = createParticipantsHandler({ repository });

  // ── Layer 1: Services that depend on layer-0 services ───────────────

  const executionTimeoutMs = parseInt(
    env.EXECUTION_TIMEOUT_MS || String(DEFAULT_EXECUTION_TIMEOUT_MS),
    10
  );

  const presenceService: PresenceService = new PresenceService({
    getAuthenticatedClients: () => wsManager.getAuthenticatedClients(),
    // getClientInfo uses sessionServer which hasn't been created yet —
    // but this is a callback so it's fine: it runs later, not now.
    getClientInfo: (ws) => sessionServer.getClientInfo(ws),
    broadcast: (msg) => deps.broadcast(msg),
    send: (ws, msg) => deps.safeSend(ws, msg),
    getSandboxSocket: () => wsManager.getSandboxSocket(),
    isSpawning: () => lifecycleManager.isSpawning(),
    spawnSandbox: () => deps.spawnSandbox(),
    log,
  });

  const messageQueue: SessionMessageQueue = new SessionMessageQueue({
    env,
    ctx,
    log,
    repository,
    wsManager,
    participantService,
    callbackService,
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    getClientInfo: (ws) => sessionServer.getClientInfo(ws),
    validateReasoningEffort: (model, effort) => deps.validateReasoningEffort(model, effort),
    getSession: () => deps.getSession(),
    updateLastActivity: (timestamp) => deps.updateLastActivity(timestamp),
    spawnSandbox: () => deps.spawnSandbox(),
    broadcast: (message) => deps.broadcast(message),
    setSessionStatus: async (status) => {
      await deps.transitionSessionStatus(status);
    },
    reconcileSessionStatusAfterExecution: async (success) => {
      await deps.reconcileSessionStatusAfterExecution(success);
    },
    scheduleExecutionTimeout: async (startedAtMs: number) => {
      const deadline = startedAtMs + executionTimeoutMs;
      const currentAlarm = await ctx.storage.getAlarm();
      if (!currentAlarm || deadline < currentAlarm) {
        await ctx.storage.setAlarm(deadline);
      }
    },
  });

  const sandboxEventProcessor = new SessionSandboxEventProcessor({
    ctx,
    log,
    repository,
    callbackService,
    wsManager,
    broadcast: (message) => deps.broadcast(message),
    getIsProcessing: () => deps.getIsProcessing(),
    triggerSnapshot: (reason) => deps.triggerSnapshot(reason),
    reconcileSessionStatusAfterExecution: async (success) => {
      await deps.reconcileSessionStatusAfterExecution(success);
    },
    updateLastActivity: (timestamp) => deps.updateLastActivity(timestamp),
    scheduleInactivityCheck: () => deps.scheduleInactivityCheck(),
    processMessageQueue: () => messageQueue.processMessageQueue(),
  });

  // ── Layer 2: Services that depend on layer-1 services ───────────────

  const messageService: MessageService = new MessageService({
    repository,
    messageQueue,
    stopExecution: () => deps.stopExecution(),
    parseArtifactMetadata: (artifact) => deps.parseArtifactMetadata(artifact),
  });

  const lifecycleManager = createLifecycleManager(deps, wsManager, messageQueue);

  const alarmHandler: AlarmHandler = createAlarmHandler({
    repository,
    messageQueue,
    lifecycleManager,
    executionTimeoutMs,
    now: () => Date.now(),
    getLog: () => log,
  });

  // ── Layer 3: HTTP handlers and session server ───────────────────────

  const messagesHandler: MessagesHandler = createMessagesHandler({
    messageService,
    getLog: () => log,
  });

  const childSessionsHandler: ChildSessionsHandler = createChildSessionsHandler({
    repository,
    getSession: () => deps.getSession(),
    getSandbox: () => deps.getSandbox(),
    getPublicSessionId: (session) => deps.getPublicSessionId(session),
    broadcast: (message) => deps.broadcast(message),
  });

  const sandboxHandler: SandboxHandler = createSandboxHandler({
    repository,
    processSandboxEvent: (event) => deps.processSandboxEvent(event),
    getSandbox: () => deps.getSandbox(),
    isValidSandboxToken: (token, sandbox) => deps.isValidSandboxToken(token, sandbox),
    getSession: () => deps.getSession(),
    refreshOpenAIToken: async (session) => {
      const service = new OpenAITokenRefreshService(
        env.DB!,
        env.REPO_SECRETS_ENCRYPTION_KEY!,
        (sessionRow) => deps.ensureRepoId(sessionRow),
        log
      );
      return service.refresh(session);
    },
    refreshAnthropicToken: async (session) => {
      const service = new AnthropicTokenRefreshService(
        env.DB!,
        env.REPO_SECRETS_ENCRYPTION_KEY!,
        (sessionRow) => deps.ensureRepoId(sessionRow),
        log
      );
      return service.refresh(session);
    },
    persistRotatedAnthropicToken: async (session, newRefreshToken) => {
      const service = new AnthropicTokenRefreshService(
        env.DB!,
        env.REPO_SECRETS_ENCRYPTION_KEY!,
        (sessionRow) => deps.ensureRepoId(sessionRow),
        log
      );
      return service.persistRotatedToken(session, newRefreshToken);
    },
    isOpenAISecretsConfigured: () => Boolean(env.DB && env.REPO_SECRETS_ENCRYPTION_KEY),
    broadcast: (message) => deps.broadcast(message),
    generateId: () => generateId(),
    now: () => Date.now(),
    getLog: () => log,
  });

  const wsTokenHandler: WsTokenHandler = createWsTokenHandler({
    repository,
    getParticipantByUserId: (userId) => participantService.getByUserId(userId),
    generateId: (bytes) => generateId(bytes),
    hashToken: (token) => hashToken(token),
    now: () => Date.now(),
    getLog: () => log,
  });

  const sessionLifecycleHandler: SessionLifecycleHandler = createSessionLifecycleHandler({
    repository,
    getDurableObjectId: () => ctx.id.toString(),
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    encryptToken: async (token, encryptionKey) => encryptToken(token, encryptionKey),
    validateReasoningEffort: (model, effort) => deps.validateReasoningEffort(model, effort),
    generateId: (bytes) => generateId(bytes),
    now: () => Date.now(),
    scheduleWarmSandbox: () => ctx.waitUntil(lifecycleManager.warmSandbox()),
    getLog: () => log,
    getSession: () => deps.getSession(),
    getSandbox: () => deps.getSandbox(),
    getPublicSessionId: (session) => deps.getPublicSessionId(session),
    getParticipantByUserId: (userId) => participantService.getByUserId(userId),
    transitionSessionStatus: (status) => deps.transitionSessionStatus(status),
    stopExecution: (options) => deps.stopExecution(options),
    getSandboxSocket: () => wsManager.getSandboxSocket(),
    sendToSandbox: (ws, message) => wsManager.send(ws, message),
    updateSandboxStatus: (status) => deps.updateSandboxStatus(status),
    broadcast: (message) => deps.broadcast(message),
  });

  const pullRequestHandler: PullRequestHandler = createPullRequestHandler({
    getSession: () => deps.getSession(),
    getPromptingParticipantForPR: () => participantService.getPromptingParticipantForPR(),
    resolveAuthForPR: (participant) => participantService.resolveAuthForPR(participant),
    getSessionUrl: (session) => {
      const sessionId = session.session_name || session.id;
      const webAppUrl = env.WEB_APP_URL || env.WORKER_URL || "";
      return webAppUrl + "/session/" + sessionId;
    },
    createPullRequest: async (input) => {
      const pullRequestService = new SessionPullRequestService({
        repository,
        sourceControlProvider: servicesRef.sourceControlProvider,
        log,
        generateId: () => generateId(),
        pushBranchToRemote: (headBranch, pushSpec) => deps.pushBranchToRemote(headBranch, pushSpec),
        broadcastSessionBranch: (branchName) => {
          deps.broadcast({ type: "session_branch", branchName });
        },
        broadcastArtifactCreated: (artifact) => {
          deps.broadcast({ type: "artifact_created", artifact });
        },
      });
      return pullRequestService.createPullRequest(input);
    },
  });

  const sessionServer: SessionServer = new SessionServer({
    wsManager,
    presenceService,
    participantService,
    repository,
    messageService,
    log,
    env,
    getSessionState: (sandbox) => deps.getSessionState(sandbox as SandboxRow | null | undefined),
    getSandbox: () => deps.getSandbox(),
  });

  Object.assign(servicesRef, {
    wsManager,
    lifecycleManager,
    sourceControlProvider,
    participantService,
    callbackService,
    presenceService,
    messageQueue,
    messageService,
    messagesHandler,
    childSessionsHandler,
    sandboxHandler,
    wsTokenHandler,
    sessionLifecycleHandler,
    pullRequestHandler,
    participantsHandler: participantsHandler,
    alarmHandler,
    sessionServer,
    sandboxEventProcessor,
    executionTimeoutMs,
  });

  return servicesRef;
}

// ─── Lifecycle manager factory (large, kept separate for readability) ──

function createLifecycleManager(
  deps: SessionCoreDeps,
  wsManager: SessionWebSocketManager,
  messageQueue: SessionMessageQueue
): SandboxLifecycleManager {
  const { ctx, env, repository } = deps;
  const sandboxBackend = resolveSandboxBackendName(env.SANDBOX_PROVIDER);

  const provider =
    sandboxBackend === "daytona"
      ? (() => {
          if (!env.DAYTONA_API_URL || !env.DAYTONA_API_KEY || !env.DAYTONA_BASE_SNAPSHOT) {
            throw new Error(
              "DAYTONA_API_URL, DAYTONA_API_KEY, and DAYTONA_BASE_SNAPSHOT are required when SANDBOX_PROVIDER=daytona"
            );
          }

          const daytonaClient = createDaytonaRestClient({
            apiUrl: env.DAYTONA_API_URL,
            apiKey: env.DAYTONA_API_KEY,
            organizationId: env.DAYTONA_ORGANIZATION_ID,
            target: env.DAYTONA_TARGET,
            baseSnapshot: env.DAYTONA_BASE_SNAPSHOT,
            autoStopIntervalMinutes: parseInt(env.DAYTONA_AUTO_STOP_INTERVAL_MINUTES || "120", 10),
            autoArchiveIntervalMinutes: parseInt(
              env.DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES || "10080",
              10
            ),
          });

          const scmProvider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
          const appConfig = getGitHubAppConfig(env);

          const getCloneToken: () => Promise<string | null> =
            scmProvider === "gitlab"
              ? () => Promise.resolve(env.GITLAB_ACCESS_TOKEN ?? null)
              : appConfig
                ? () =>
                    getCachedInstallationToken(appConfig, {
                      cacheStore: createKvCacheStore(env.REPOS_CACHE),
                    })
                : () => Promise.resolve(null);

          return createDaytonaProvider(
            daytonaClient,
            {
              scmProvider,
              gitlabAccessToken: env.GITLAB_ACCESS_TOKEN,
              codeServerPasswordSecret: env.DAYTONA_API_KEY,
            },
            getCloneToken
          );
        })()
      : (() => {
          if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
            throw new Error(
              "MODAL_API_SECRET and MODAL_WORKSPACE are required when SANDBOX_PROVIDER=modal"
            );
          }

          const modalClient = createModalClient(env.MODAL_API_SECRET, env.MODAL_WORKSPACE);
          return createModalProvider(modalClient);
        })();

  const storage: SandboxStorage = {
    getSandbox: () => repository.getSandbox(),
    getSandboxWithCircuitBreaker: () => repository.getSandboxWithCircuitBreaker(),
    getSession: () => repository.getSession(),
    getUserEnvVars: () => deps.getUserEnvVars(),
    updateSandboxStatus: (status) => deps.updateSandboxStatus(status),
    updateSandboxForSpawn: (data) => repository.updateSandboxForSpawn(data),
    updateSandboxForResume: (data) => repository.updateSandboxForResume(data),
    updateSandboxModalObjectId: (id) => repository.updateSandboxModalObjectId(id),
    updateSandboxSnapshotImageId: (sandboxId, imageId) =>
      repository.updateSandboxSnapshotImageId(sandboxId, imageId),
    updateSandboxLastActivity: (timestamp) => repository.updateSandboxLastActivity(timestamp),
    incrementCircuitBreakerFailure: (timestamp) =>
      repository.incrementCircuitBreakerFailure(timestamp),
    resetCircuitBreaker: () => repository.resetCircuitBreaker(),
    setLastSpawnError: (error, timestamp) => repository.updateSandboxSpawnError(error, timestamp),
    updateSandboxCodeServer: async (url, password) => {
      const encrypted = env.REPO_SECRETS_ENCRYPTION_KEY
        ? await encryptToken(password, env.REPO_SECRETS_ENCRYPTION_KEY)
        : password;
      repository.updateSandboxCodeServer(url, encrypted);
    },
    clearSandboxCodeServer: () => repository.clearSandboxCodeServer(),
    clearSandboxCodeServerUrl: () => repository.clearSandboxCodeServerUrl(),
    updateSandboxTunnelUrls: (urls) => repository.updateSandboxTunnelUrls(urls),
    clearSandboxTunnelUrls: () => repository.clearSandboxTunnelUrls(),
    updateSandboxTtyd: async (url, token) => {
      const encrypted = env.REPO_SECRETS_ENCRYPTION_KEY
        ? await encryptToken(token, env.REPO_SECRETS_ENCRYPTION_KEY)
        : token;
      repository.updateSandboxTtyd(url, encrypted);
    },
    clearSandboxTtyd: () => repository.clearSandboxTtyd(),
  };

  const broadcaster: SandboxBroadcaster = {
    broadcast: (message) => deps.broadcast(message as ServerMessage),
  };

  const wsManagerAdapter: LifecycleWebSocketManager = {
    getSandboxWebSocket: () => wsManager.getSandboxSocket(),
    closeSandboxWebSocket: (code, reason) => {
      const ws = wsManager.getSandboxSocket();
      if (ws) {
        wsManager.close(ws, code, reason);
        wsManager.clearSandboxSocket();
      }
    },
    sendToSandbox: (message) => {
      const ws = wsManager.getSandboxSocket();
      return ws ? wsManager.send(ws, message) : false;
    },
    getConnectedClientCount: () => wsManager.getConnectedClientCount(),
  };

  const alarmScheduler: AlarmScheduler = {
    scheduleAlarm: async (timestamp) => {
      await ctx.storage.setAlarm(timestamp);
    },
  };

  const idGenerator: IdGenerator = { generateId: () => generateId() };

  const serverUrl =
    env.WORKER_URL || `https://open-inspect-server.${env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

  const session = repository.getSession();
  const sessionId = session?.session_name || session?.id || ctx.id.toString();

  let mcpServerLookup: McpServerLookup | undefined;
  if (env.DB) {
    const mcpStore = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
    mcpServerLookup = {
      getDecryptedForSession: (repoOwner, repoName) =>
        mcpStore.getDecryptedForSession(repoOwner, repoName),
    };
  }

  const config = {
    ...DEFAULT_LIFECYCLE_CONFIG,
    serverUrl,
    model: DEFAULT_MODEL,
    sessionId,
    inactivity: {
      ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
      timeoutMs: parseInt(env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10),
    },
    mcpServerLookup,
  };

  let repoImageLookup: RepoImageLookup | undefined;
  if (env.DB && sandboxBackend === "modal") {
    const repoImageStore = new RepoImageStore(env.DB);
    repoImageLookup = {
      getLatestReady: (repoOwner, repoName, baseBranch) =>
        repoImageStore.getLatestReady(repoOwner, repoName, baseBranch),
    };
  }

  return new SandboxLifecycleManager(
    provider,
    storage,
    broadcaster,
    wsManagerAdapter,
    alarmScheduler,
    idGenerator,
    config,
    { onSandboxTerminating: () => messageQueue.failStuckProcessingMessage() },
    repoImageLookup
  );
}
