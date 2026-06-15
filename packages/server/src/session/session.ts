/**
 * Session — owns all state and real-time communication for a single session.
 *
 * Each session gets its own instance with:
 * - SQLite database for persistent state
 * - WebSocket connections with hibernation support
 * - Prompt queue and event streaming
 */

import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import { timingSafeEqual } from "@open-inspect/shared";
import { hashToken, decryptToken } from "../auth/crypto";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import { SessionIndexStore } from "../db/session-index";
import type { GitPushSpec } from "../source-control";
import { DEFAULT_MODEL, isValidReasoningEffort } from "../utils/models";
import type {
  Env,
  ClientInfo,
  ClientMessage,
  ServerMessage,
  SandboxEvent,
  SessionState,
  SessionStatus,
  SandboxStatus,
} from "../types";
import type { SessionRow, ArtifactRow, SandboxRow } from "./types";
import { SessionRepository } from "./repository";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { createSessionInternalRoutes } from "./http/routes";
import { createServices, type SessionServices } from "./create-services";

/** Statuses that indicate a session is finished — metrics are synced to D1 on these transitions. */
const TERMINAL_STATUSES: SessionStatus[] = ["completed", "failed", "cancelled"];

export class Session extends DurableObject<Env> {
  private sql: SqlStorage;
  private repository: SessionRepository;
  private initialized = false;
  private log: Logger;
  // All services (lazily initialized via createServices)
  private _services: SessionServices | null = null;

  // Internal HTTP route table (transport wiring only; handlers delegated to services).
  private readonly routes = createSessionInternalRoutes({
    init: (request) => this.services.sessionLifecycleHandler.init(request),
    state: () => this.services.sessionLifecycleHandler.getState(),
    prompt: (request) => this.services.messagesHandler.enqueuePrompt(request),
    stop: () => this.services.messagesHandler.stop(),
    sandboxEvent: (request) => this.services.sandboxHandler.sandboxEvent(request),
    createMediaArtifact: (request) => this.services.sandboxHandler.createMediaArtifact(request),
    listParticipants: () => this.services.participantsHandler.listParticipants(),
    addParticipant: (request) => this.services.sandboxHandler.addParticipant(request),
    listEvents: (_request, url) => this.services.messagesHandler.listEvents(url),
    listArtifacts: (_request, url) => this.services.messagesHandler.listArtifacts(url),
    listMessages: (_request, url) => this.services.messagesHandler.listMessages(url),
    createPr: (request) => this.services.pullRequestHandler.createPr(request),
    wsToken: (request) => this.services.wsTokenHandler.generateWsToken(request),
    updateTitle: (request) => this.services.sessionLifecycleHandler.updateTitle(request),
    archive: (request) => this.services.sessionLifecycleHandler.archive(request),
    unarchive: (request) => this.services.sessionLifecycleHandler.unarchive(request),
    verifySandboxToken: (request) => this.services.sandboxHandler.verifySandboxToken(request),
    openaiTokenRefresh: () => this.services.sandboxHandler.openaiTokenRefresh(),
    anthropicTokenRefresh: () => this.services.sandboxHandler.anthropicTokenRefresh(),
    anthropicTokenSyncBack: (request) =>
      this.services.sandboxHandler.anthropicTokenSyncBack(request),
    spawnContext: () => this.services.childSessionsHandler.getSpawnContext(),
    childSummary: () => this.services.childSessionsHandler.getChildSummary(),
    cancel: () => this.services.sessionLifecycleHandler.cancel(),
    childSessionUpdate: (request) => this.services.childSessionsHandler.childSessionUpdate(request),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.repository = new SessionRepository(this.sql);
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
    // Note: session_id context is set in ensureInitialized() once DB is ready
  }

  /**
   * All services, constructed lazily in dependency order.
   * Replaces 17 individual lazy getters.
   */
  private get services(): SessionServices {
    if (!this._services) {
      this._services = createServices({
        ctx: this.ctx,
        env: this.env,
        log: this.log,
        repository: this.repository,
        getSession: () => this.getSession(),
        getSandbox: () => this.getSandbox(),
        getSessionState: (sandbox) => this.getSessionState(sandbox),
        getPublicSessionId: (session) => this.getPublicSessionId(session),
        getIsProcessing: () => this.getIsProcessing(),
        getUserEnvVars: () => this.getUserEnvVars(),
        ensureRepoId: (session) => this.ensureRepoId(session),
        broadcast: (message) => this.broadcast(message),
        safeSend: (ws, message) => this.safeSend(ws, message),
        updateSandboxStatus: (status) => this.updateSandboxStatus(status),
        updateLastActivity: (timestamp) => this.updateLastActivity(timestamp),
        transitionSessionStatus: (status) => this.transitionSessionStatus(status),
        reconcileSessionStatusAfterExecution: (success) =>
          this.reconcileSessionStatusAfterExecution(success),
        scheduleInactivityCheck: () => this.scheduleInactivityCheck(),
        triggerSnapshot: (reason) => this.triggerSnapshot(reason),
        spawnSandbox: () => this.spawnSandbox(),
        stopExecution: (options) => this.stopExecution(options),
        processSandboxEvent: (event) => this.processSandboxEvent(event),
        pushBranchToRemote: (branchName, pushSpec) => this.pushBranchToRemote(branchName, pushSpec),
        validateReasoningEffort: (model, effort) => this.validateReasoningEffort(model, effort),
        parseArtifactMetadata: (artifact) => this.parseArtifactMetadata(artifact),
        isValidSandboxToken: (token, sandbox) => this.isValidSandboxToken(token, sandbox),
      });
    }
    return this._services;
  }

  /**
   * Safely send a message over a WebSocket.
   */
  private safeSend(ws: WebSocket, message: string | object): boolean {
    return this.services.wsManager.send(ws, message);
  }

  /**
   * Initialize the session with required data.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    initSchema(this.sql);
    this.initialized = true;
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();
    this.log = createLogger(
      "session-do",
      { session_id: sessionId },
      parseLogLevel(this.env.LOG_LEVEL)
    );
    this.services.wsManager.enableAutoPingPong();
  }

  /**
   * Handle incoming HTTP requests.
   */
  async fetch(request: Request): Promise<Response> {
    const fetchStart = performance.now();

    this.ensureInitialized();
    const initMs = performance.now() - fetchStart;

    const originalLogger = this.log;

    // Extract correlation headers and create a request-scoped logger
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    if (traceId || requestId) {
      const correlationCtx: Record<string, unknown> = {};
      if (traceId) correlationCtx.trace_id = traceId;
      if (requestId) correlationCtx.request_id = requestId;
      this.log = originalLogger.child(correlationCtx);
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // WebSocket upgrade (special case - header-based, not path-based)
      if (request.headers.get("Upgrade") === "websocket") {
        return this.handleWebSocketUpgrade(request, url);
      }

      // Match route from table
      const route = this.routes.find((r) => r.path === path && r.method === request.method);

      if (route) {
        const handlerStart = performance.now();
        let status = 500;
        let outcome: "success" | "error" = "error";
        try {
          const response = await route.handler(request, url);
          status = response.status;
          outcome = status >= 500 ? "error" : "success";
          return response;
        } catch (e) {
          status = 500;
          outcome = "error";
          throw e;
        } finally {
          const handlerMs = performance.now() - handlerStart;
          const totalMs = performance.now() - fetchStart;
          this.log.info("do.request", {
            event: "do.request",
            http_method: request.method,
            http_path: path,
            http_status: status,
            duration_ms: Math.round(totalMs * 100) / 100,
            init_ms: Math.round(initMs * 100) / 100,
            handler_ms: Math.round(handlerMs * 100) / 100,
            outcome,
          });
        }
      }

      return new Response("Not Found", { status: 404 });
    } finally {
      this.log = originalLogger;
    }
  }

  /**
   * Handle WebSocket upgrade request.
   */
  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    this.log.debug("WebSocket upgrade requested");
    const isSandbox = url.searchParams.get("type") === "sandbox";

    // Validate sandbox authentication
    if (isSandbox) {
      const wsStartTime = Date.now();
      const authHeader = request.headers.get("Authorization");
      const sandboxId = request.headers.get("X-Sandbox-ID");
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      // Get expected values from DB
      const sandbox = this.getSandbox();
      const expectedSandboxId = sandbox?.modal_sandbox_id;

      // Reject connection if sandbox should be stopped (prevents reconnection after inactivity timeout)
      if (sandbox?.status === "stopped" || sandbox?.status === "stale") {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "rejected",
          reject_reason: "sandbox_stopped",
          sandbox_status: sandbox.status,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Sandbox is stopped", { status: 410 });
      }

      // Validate sandbox ID first (catches stale sandboxes reconnecting after restore)
      if (expectedSandboxId && sandboxId !== expectedSandboxId) {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "sandbox_id_mismatch",
          expected_sandbox_id: expectedSandboxId,
          sandbox_id: sandboxId,
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Forbidden: Wrong sandbox ID", { status: 403 });
      }

      // Validate auth token
      const tokenMatches = await this.isValidSandboxToken(providedToken, sandbox);
      if (!tokenMatches) {
        this.log.warn("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "auth_failed",
          reject_reason: "token_mismatch",
          duration_ms: Date.now() - wsStartTime,
        });
        return new Response("Unauthorized: Invalid auth token", { status: 401 });
      }

      // Auth passed — continue to WebSocket accept below
      // The success ws.connect event is emitted after the WebSocket is accepted
    }

    try {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const sandboxId = request.headers.get("X-Sandbox-ID");

      if (isSandbox) {
        const { replaced } = this.services.wsManager.acceptAndSetSandboxSocket(
          server,
          sandboxId ?? undefined
        );

        // Notify manager that sandbox connected so it can reset the spawning flag
        this.services.lifecycleManager.onSandboxConnected();
        this.updateSandboxStatus("ready");
        this.broadcast({ type: "sandbox_status", status: "ready" });

        // Set initial activity timestamp and schedule inactivity check
        // IMPORTANT: Must await to ensure alarm is scheduled before returning
        const now = Date.now();
        this.updateLastActivity(now);
        await this.scheduleInactivityCheck();

        this.log.info("ws.connect", {
          event: "ws.connect",
          ws_type: "sandbox",
          outcome: "success",
          sandbox_id: sandboxId,
          replaced_existing: replaced,
          duration_ms: Date.now() - now,
        });

        // Process any pending messages now that sandbox is connected
        this.processMessageQueue();
      } else {
        const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        this.services.wsManager.acceptClientSocket(server, wsId);
        this.ctx.waitUntil(this.services.wsManager.enforceAuthTimeout(server, wsId));
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      this.log.error("WebSocket upgrade failed", {
        error: error instanceof Error ? error : String(error),
      });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureInitialized();
    if (typeof message !== "string") return;

    const { kind } = this.services.wsManager.classify(ws);
    if (kind === "sandbox") {
      await this.handleSandboxMessage(ws, message);
    } else {
      await this.handleClientMessage(ws, message);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.ensureInitialized();
    const { kind } = this.services.wsManager.classify(ws);

    try {
      if (kind === "sandbox") {
        const wasActive = this.services.wsManager.clearSandboxSocketIfMatch(ws);
        if (!wasActive) {
          // sandboxWs points to a different socket — this close is for a replaced connection.
          this.log.debug("Ignoring close for replaced sandbox socket", { code });
          return;
        }

        const isNormalClose = code === 1000 || code === 1001;
        if (isNormalClose) {
          this.updateSandboxStatus("stopped");
        } else {
          // Abnormal close (e.g., 1006): leave status unchanged so the bridge can reconnect.
          // Schedule a heartbeat check to detect truly dead sandboxes.
          this.log.warn("Sandbox WebSocket abnormal close", {
            event: "sandbox.abnormal_close",
            code,
            reason,
          });
          await this.services.lifecycleManager.scheduleDisconnectCheck();
        }
      } else {
        const client = this.services.wsManager.removeClient(ws);
        if (client) {
          this.broadcast({ type: "presence_leave", userId: client.userId });
        }
      }
    } finally {
      // Reciprocate the peer close to complete the WebSocket close handshake.
      this.services.wsManager.close(ws, code, reason);
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.ensureInitialized();
    this.log.error("WebSocket error", { error });
    ws.close(1011, "Internal error");
  }

  /**
   * Durable Object alarm handler.
   *
   * Checks for stuck processing messages (defense-in-depth execution timeout)
   * BEFORE delegating to the lifecycle manager for inactivity and heartbeat
   * monitoring. This ensures stuck messages are failed even when the sandbox
   * is already dead and handleAlarm() returns early.
   */
  async alarm(): Promise<void> {
    this.ensureInitialized();
    await this.services.alarmHandler.handle();
  }

  /**
   * Update the last activity timestamp.
   * Delegates to the lifecycle manager.
   */
  private updateLastActivity(timestamp: number): void {
    this.services.lifecycleManager.updateLastActivity(timestamp);
  }

  /**
   * Schedule the inactivity check alarm.
   * Delegates to the lifecycle manager.
   */
  private async scheduleInactivityCheck(): Promise<void> {
    await this.services.lifecycleManager.scheduleInactivityCheck();
  }

  /**
   * Trigger a filesystem snapshot of the sandbox.
   * Delegates to the lifecycle manager.
   */
  private async triggerSnapshot(reason: string): Promise<void> {
    await this.services.lifecycleManager.triggerSnapshot(reason);
  }

  /**
   * Handle messages from sandbox.
   */
  private async handleSandboxMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const event = JSON.parse(message) as SandboxEvent;
      await this.processSandboxEvent(event);
    } catch (e) {
      this.log.error("Error processing sandbox message", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  /**
   * Handle messages from clients.
   */
  private async handleClientMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const data = JSON.parse(message) as ClientMessage;

      switch (data.type) {
        case "ping":
          this.safeSend(ws, { type: "pong", timestamp: Date.now() });
          break;

        case "subscribe":
          await this.handleSubscribe(ws, data);
          break;

        case "prompt":
          await this.handlePromptMessage(ws, data);
          break;

        case "stop":
          await this.stopExecution();
          break;

        case "typing":
          await this.services.presenceService.handleTyping();
          break;

        case "fetch_history":
          this.handleFetchHistory(ws, data);
          break;

        case "presence":
          this.services.presenceService.updatePresence(ws, data);
          break;
      }
    } catch (e) {
      this.log.error("Error processing client message", {
        error: e instanceof Error ? e : String(e),
      });
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Failed to process message",
      });
    }
  }

  /**
   * Handle client subscription — authenticate, register, send session state + replay.
   */
  private async handleSubscribe(
    ws: WebSocket,
    data: { token: string; clientId: string }
  ): Promise<void> {
    await this.services.sessionServer.meta(ws, data);
  }

  /**
   * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
   */
  private getClientInfo(ws: WebSocket): ClientInfo | null {
    return this.services.sessionServer.getClientInfo(ws);
  }

  /**
   * Handle prompt message from client.
   */
  private async handlePromptMessage(
    ws: WebSocket,
    data: {
      content: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: Array<{ type: string; name: string; url?: string; content?: string }>;
    }
  ): Promise<void> {
    await this.services.messageQueue.handlePromptMessage(ws, data);
  }

  /**
   * Handle fetch_history request from client for paginated history loading.
   */
  private handleFetchHistory(
    ws: WebSocket,
    data: { cursor?: { timestamp: number; id: string }; limit?: number }
  ): void {
    const client = this.getClientInfo(ws);
    if (!client) {
      this.safeSend(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    // Validate cursor
    if (
      !data.cursor ||
      typeof data.cursor.timestamp !== "number" ||
      typeof data.cursor.id !== "string"
    ) {
      this.safeSend(ws, {
        type: "error",
        code: "INVALID_CURSOR",
        message: "Invalid cursor",
      });
      return;
    }

    // Rate limit: reject if < 200ms since last fetch
    const now = Date.now();
    if (client.lastFetchHistoryAt && now - client.lastFetchHistoryAt < 200) {
      this.safeSend(ws, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many requests",
      });
      return;
    }
    client.lastFetchHistoryAt = now;

    const rawLimit = typeof data.limit === "number" ? data.limit : 200;
    const limit = Math.max(1, Math.min(rawLimit, 500));
    const page = this.repository.getEventsHistoryPage(data.cursor.timestamp, data.cursor.id, limit);

    const items: SandboxEvent[] = [];
    for (const event of page.events) {
      try {
        items.push(JSON.parse(event.data));
      } catch {
        // Skip malformed events
      }
    }

    // Compute new cursor from oldest item in the page
    const oldestEvent = page.events.length > 0 ? page.events[0] : null;

    this.safeSend(ws, {
      type: "history_page",
      items,
      hasMore: page.hasMore,
      cursor: oldestEvent ? { timestamp: oldestEvent.created_at, id: oldestEvent.id } : null,
    } as ServerMessage);
  }

  /**
   * Process sandbox event.
   */
  private async processSandboxEvent(event: SandboxEvent): Promise<void> {
    await this.services.sandboxEventProcessor.processSandboxEvent(event);
  }

  /**
   * Push a branch to remote via the sandbox.
   * Sends push command to sandbox and waits for completion or error.
   *
   * @returns Success result or error message
   */
  private async pushBranchToRemote(
    branchName: string,
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    return await this.services.sandboxEventProcessor.pushBranchToRemote(branchName, pushSpec);
  }

  /**
   * Warm sandbox proactively.
   * Delegates to the lifecycle manager.
   */
  private async warmSandbox(): Promise<void> {
    await this.services.lifecycleManager.warmSandbox();
  }

  /**
   * Process message queue.
   */
  private async processMessageQueue(): Promise<void> {
    await this.services.messageQueue.processMessageQueue();
  }

  /**
   * Spawn a sandbox via Modal.
   * Delegates to the lifecycle manager.
   */
  private async spawnSandbox(): Promise<void> {
    await this.services.lifecycleManager.spawnSandbox();
  }

  /**
   * Stop current execution.
   * Marks the processing message as failed, upserts synthetic execution_complete,
   * broadcasts synthetic execution_complete
   * so all clients flush buffered tokens, and forwards stop to the sandbox.
   */
  private async stopExecution(options?: { suppressStatusReconcile?: boolean }): Promise<void> {
    await this.services.messageQueue.stopExecution(options);
  }

  /**
   * Broadcast message to all authenticated clients.
   */
  private broadcast(message: ServerMessage): void {
    this.services.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.services.wsManager.send(ws, message);
    });
  }

  /**
   * Validate reasoning effort against a model's allowed values.
   * Returns the validated effort string or null if invalid/absent.
   */
  private validateReasoningEffort(model: string, effort: string | undefined): string | null {
    if (!effort) return null;
    if (isValidReasoningEffort(model, effort)) return effort;
    this.log.warn("Invalid reasoning effort for model, ignoring", {
      model,
      reasoning_effort: effort,
    });
    return null;
  }

  private getPublicSessionId(session?: SessionRow | null): string {
    const resolved = session ?? this.getSession();
    return resolved?.session_name || resolved?.id || this.ctx.id.toString();
  }

  private syncSessionIndexStatus(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): void {
    if (!this.env.DB) return;
    const sessionStore = new SessionIndexStore(this.env.DB);
    this.ctx.waitUntil(
      sessionStore.updateStatus(sessionId, status, updatedAt).catch((error) => {
        this.log.error("session_index.update_status.background_error", {
          session_id: sessionId,
          status,
          updated_at: updatedAt,
          error,
        });
      })
    );
  }

  private syncSessionMetrics(sessionId: string): void {
    if (!this.env.DB) return;

    const session = this.repository.getSession();
    if (!session) return;

    const messageCount = this.repository.getMessageCount();
    const activeDurationMs = this.repository.getActiveDurationMs();
    const artifacts = this.repository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    const sessionStore = new SessionIndexStore(this.env.DB);
    this.ctx.waitUntil(
      sessionStore
        .updateMetrics(sessionId, {
          totalCost: session.total_cost ?? 0,
          activeDurationMs,
          messageCount,
          prCount,
        })
        .catch((error) => {
          this.log.error("session_index.update_metrics.background_error", {
            session_id: sessionId,
            error,
          });
        })
    );
  }

  private async transitionSessionStatus(status: SessionStatus): Promise<boolean> {
    const session = this.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    if (session.status === status) {
      this.syncSessionIndexStatus(publicSessionId, status, session.updated_at);
      if (TERMINAL_STATUSES.includes(status)) {
        this.syncSessionMetrics(publicSessionId);
      }
      return false;
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    this.syncSessionIndexStatus(publicSessionId, status, updatedAt);

    this.broadcast({ type: "session_status", status });

    if (TERMINAL_STATUSES.includes(status)) {
      this.syncSessionMetrics(publicSessionId);
    }

    // Notify parent session (if this is a child) so its UI can refresh
    this.notifyParentOfStatusChange(session, publicSessionId, status);

    return true;
  }

  /**
   * Fire-and-forget notification to the parent session so its connected clients
   * can refresh the child-sessions list in real time.
   */
  private notifyParentOfStatusChange(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    status: SessionStatus
  ): void {
    const parentId = session.parent_session_id;
    if (!parentId || !this.env.SESSION) return;

    const parentDoId = this.env.SESSION.idFromName(parentId);
    const parentStub = this.env.SESSION.get(parentDoId);

    this.ctx.waitUntil(
      parentStub
        .fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId,
              status,
              title: session.title,
            }),
          })
        )
        .catch((error) => {
          this.log.error("notify_parent.failed", {
            parent_id: parentId,
            child_id: childSessionId,
            status,
            error,
          });
        })
    );
  }

  private async reconcileSessionStatusAfterExecution(success: boolean): Promise<void> {
    const pendingOrProcessing = this.repository.getPendingOrProcessingCount();
    const nextStatus: SessionStatus =
      pendingOrProcessing > 0 ? "active" : success ? "completed" : "failed";
    await this.transitionSessionStatus(nextStatus);
  }

  /**
   * Get current session state.
   * Accepts an optional pre-fetched sandbox row to avoid a redundant SQLite read.
   */
  private async getSessionState(sandbox?: SandboxRow | null): Promise<SessionState> {
    const session = this.getSession();
    sandbox ??= this.getSandbox();
    const messageCount = this.repository.getMessageCount();
    const isProcessing = this.getIsProcessing();

    // Decrypt code-server password if stored encrypted
    let codeServerPassword: string | null = sandbox?.code_server_password ?? null;
    if (codeServerPassword && this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      try {
        codeServerPassword = await decryptToken(
          codeServerPassword,
          this.env.REPO_SECRETS_ENCRYPTION_KEY
        );
      } catch {
        // Key mismatch or corruption — don't leak ciphertext to clients
        codeServerPassword = null;
      }
    }

    // Decrypt ttyd token if stored encrypted
    let ttydToken: string | null = sandbox?.ttyd_token ?? null;
    if (ttydToken && this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      try {
        ttydToken = await decryptToken(ttydToken, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      } catch {
        ttydToken = null;
      }
    }

    return {
      id: this.getPublicSessionId(session),
      title: session?.title ?? null,
      repoOwner: session?.repo_owner ?? "",
      repoName: session?.repo_name ?? "",
      baseBranch: session?.base_branch ?? "main",
      branchName: session?.branch_name ?? null,
      status: session?.status ?? "created",
      sandboxStatus: sandbox?.status ?? "pending",
      messageCount,
      createdAt: session?.created_at ?? Date.now(),
      model: session?.model ?? DEFAULT_MODEL,
      reasoningEffort: session?.reasoning_effort ?? undefined,
      isProcessing,
      parentSessionId: session?.parent_session_id ?? null,
      totalCost: session?.total_cost ?? 0,
      codeServerUrl: sandbox?.code_server_url ?? null,
      codeServerPassword,
      tunnelUrls: sandbox?.tunnel_urls ? this.safeParseTunnelUrls(sandbox.tunnel_urls) : null,
      ttydUrl: sandbox?.ttyd_url ?? null,
      ttydToken,
    };
  }

  /**
   * Check if any message is currently being processed.
   */
  private getIsProcessing(): boolean {
    return this.repository.getProcessingMessage() !== null;
  }

  private safeParseTunnelUrls(raw: string): Record<string, string> | null {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      this.log.warn("Invalid sandbox tunnel_urls JSON");
      return null;
    }
  }

  // Database helpers

  private getSession(): SessionRow | null {
    return this.repository.getSession();
  }

  private getSandbox(): SandboxRow | null {
    return this.repository.getSandbox();
  }

  private async ensureRepoId(session: SessionRow): Promise<number> {
    if (session.repo_id) {
      return session.repo_id;
    }

    const result = await this.services.sourceControlProvider.checkRepositoryAccess({
      owner: session.repo_owner,
      name: session.repo_name,
    });
    if (!result) {
      throw new Error("Repository is not accessible for the configured SCM provider");
    }

    this.repository.updateSessionRepoId(result.repoId);
    return result.repoId;
  }

  private async getUserEnvVars(): Promise<Record<string, string> | undefined> {
    const session = this.getSession();
    if (!session) {
      this.log.warn("Cannot load secrets: no session");
      return undefined;
    }

    if (!this.env.DB || !this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      this.log.debug("Secrets not configured, skipping", {
        has_db: !!this.env.DB,
        has_encryption_key: !!this.env.REPO_SECRETS_ENCRYPTION_KEY,
      });
      return undefined;
    }

    // Fail hard on secret loading — sandboxes must not silently lose secrets
    const globalStore = new GlobalSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
    const globalSecrets = await globalStore.getDecryptedSecrets();

    const repoId = await this.ensureRepoId(session);
    const repoStore = new RepoSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
    const repoSecrets = await repoStore.getDecryptedSecrets(repoId);

    // Merge: repo overrides global
    const { merged, totalBytes, exceedsLimit } = mergeSecrets(globalSecrets, repoSecrets);
    const globalCount = Object.keys(globalSecrets).length;
    const repoCount = Object.keys(repoSecrets).length;
    const mergedCount = Object.keys(merged).length;

    if (mergedCount > 0) {
      const logLevel = exceedsLimit ? "warn" : "info";
      this.log[logLevel]("Secrets merged for sandbox", {
        global_count: globalCount,
        repo_count: repoCount,
        merged_count: mergedCount,
        payload_bytes: totalBytes,
        exceeds_limit: exceedsLimit,
      });
    }

    return mergedCount === 0 ? undefined : merged;
  }

  /**
   * Verify a provided sandbox token against stored credentials.
   *
   * Preferred path uses auth_token_hash. Plaintext auth_token is only used
   * as a compatibility fallback for older rows.
   */
  private async isValidSandboxToken(
    token: string | null,
    sandbox: SandboxRow | null
  ): Promise<boolean> {
    if (!token || !sandbox) {
      return false;
    }

    if (sandbox.auth_token_hash) {
      const tokenHash = await hashToken(token);
      return timingSafeEqual(tokenHash, sandbox.auth_token_hash);
    }

    if (sandbox.auth_token) {
      return timingSafeEqual(token, sandbox.auth_token);
    }

    return false;
  }

  private updateSandboxStatus(status: string): void {
    this.repository.updateSandboxStatus(status as SandboxStatus);
  }

  // HTTP handlers

  private parseArtifactMetadata(
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ): Record<string, unknown> | null {
    if (!artifact.metadata) {
      return null;
    }

    try {
      return JSON.parse(artifact.metadata) as Record<string, unknown>;
    } catch (error) {
      this.log.warn("Invalid artifact metadata JSON", {
        artifact_id: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
