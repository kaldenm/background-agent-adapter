/**
 * Session Server — creates sessions, broadcasts events, tracks who's connected.
 *
 * Events come in from the agent, events go out to every browser watching.
 * It creates sessions, knows who's connected, and catches up latecomers.
 *
 * Interface (4 methods):
 *   createSession()    — create a session
 *   emit()             — event came in from agent, broadcast to everyone watching
 *   meta()             — session state + replay data for latecomers
 *   registerTrigger()  — "when X happens in this session, tell someone"
 */

// ─── Session creation + prompting ───────────────────────────────────────

export {
  createSession,
  promptSession,
  type CreateSessionOptions,
  type CreateSessionResult,
} from "./create-session";

// ─── Trigger subscriptions ──────────────────────────────────────────────
// "When something happens in session X, tell someone."
// One system for all notifications

export interface TriggerSubscription {
  /** Which session to watch */
  watchSessionId: string;

  /** What event to watch for */
  onEvent: "status_change" | "execution_complete" | "error";

  /** Who to notify */
  notify:
    | { type: "session"; sessionId: string }
    | { type: "callback"; url: string; secret?: string };
}

// ─── Session Server class ───────────────────────────────────────────────

import type { Logger } from "../logger";
import type { ClientInfo, ServerMessage, SandboxEvent, SessionState } from "../types";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { PresenceService } from "./presence-service";
import type { ParticipantService } from "./participant-service";
import type { SessionRepository } from "./repository";
import type { MessageService } from "./services/message.service";
import type { ParticipantRow } from "./types";
import { hashToken } from "../auth/crypto";
import { getAvatarUrl } from "./participant-service";
import { resolveScmProviderFromEnv } from "../source-control";

const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type SandboxSpawnErrorState = {
  last_spawn_error?: string | null;
};

export interface SessionServerDeps {
  wsManager: SessionWebSocketManager;
  presenceService: PresenceService;
  participantService: ParticipantService;
  repository: SessionRepository;
  messageService: MessageService;
  log: Logger;
  env: { SCM_PROVIDER?: string };
  getSessionState: (sandbox?: unknown) => Promise<SessionState>;
  getSandbox: () => unknown;
}

export class SessionServer {
  private triggers: TriggerSubscription[] = [];

  constructor(private readonly deps: SessionServerDeps) {}

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC INTERFACE — the 4 things you can ask the session server to do
  // ═══════════════════════════════════════════════════════════════════════

  /** Event came in from the agent. Broadcast to everyone watching. */
  emit(event: SandboxEvent): void {
    this.broadcast({ type: "sandbox_event", event } as ServerMessage);
  }

  /** Catch up a latecomer — authenticate, register, send everything they missed. */
  async meta(ws: WebSocket, data: { token: string; clientId: string }): Promise<void> {
    // Authenticate
    const participant = await this.authenticate(data.token);
    if (!participant) {
      ws.close(4001, "Invalid or expired token");
      return;
    }

    // Register in the registry
    const _clientInfo = this.register(ws, participant, data.clientId);

    // Build meta-state and send it
    const sandbox = this.deps.getSandbox();
    const state = await this.deps.getSessionState(sandbox);
    const artifacts = this.deps.messageService.listArtifacts();
    const replay = this.replay();

    const scmProvider = resolveScmProviderFromEnv(this.deps.env.SCM_PROVIDER);

    this.sendOne(ws, {
      type: "subscribed",
      sessionId: state.id,
      state,
      artifacts: artifacts.artifacts,
      participantId: participant.id,
      participant: {
        participantId: participant.id,
        name: participant.scm_name || participant.scm_login || participant.user_id,
        avatar: getAvatarUrl(participant.scm_login, scmProvider),
      },
      replay,
      spawnError: (sandbox as SandboxSpawnErrorState | null)?.last_spawn_error ?? null,
    } as ServerMessage);

    this.deps.presenceService.sendPresence(ws);
    this.deps.presenceService.broadcastPresence();
  }

  /** Register: "when this event happens in this session, tell someone." */
  registerTrigger(trigger: TriggerSubscription): void {
    this.triggers.push(trigger);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL — how it does those things
  // ═══════════════════════════════════════════════════════════════════════

  /** Send to ALL connected, authenticated clients. */
  private broadcast(message: ServerMessage): void {
    this.deps.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.deps.wsManager.send(ws, message);
    });
  }

  /** Send to ONE client. */
  private sendOne(ws: WebSocket, message: string | object): boolean {
    return this.deps.wsManager.send(ws, message);
  }

  /** Validate a token and return the participant, or null. */
  private async authenticate(token: string): Promise<ParticipantRow | null> {
    if (!token) {
      this.deps.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "no_token",
      });
      return null;
    }

    const tokenHash = await hashToken(token);
    const participant = this.deps.participantService.getByWsTokenHash(tokenHash);

    if (!participant) {
      this.deps.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "invalid_token",
      });
      return null;
    }

    if (
      participant.ws_token_created_at === null ||
      Date.now() - participant.ws_token_created_at > WS_TOKEN_TTL_MS
    ) {
      this.deps.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "client",
        outcome: "auth_failed",
        reject_reason: "token_expired",
        participant_id: participant.id,
        user_id: participant.user_id,
      });
      return null;
    }

    this.deps.log.info("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "success",
      participant_id: participant.id,
      user_id: participant.user_id,
    });

    return participant;
  }

  /** Add a client to the registry. */
  private register(ws: WebSocket, participant: ParticipantRow, clientId: string): ClientInfo {
    const scmProvider = resolveScmProviderFromEnv(this.deps.env.SCM_PROVIDER);

    const clientInfo: ClientInfo = {
      participantId: participant.id,
      userId: participant.user_id,
      name: participant.scm_name || participant.scm_login || participant.user_id,
      avatar: getAvatarUrl(participant.scm_login, scmProvider),
      status: "active",
      lastSeen: Date.now(),
      clientId,
      ws,
    };

    this.deps.wsManager.setClient(ws, clientInfo);

    const parsed = this.deps.wsManager.classify(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      this.deps.wsManager.persistClientMapping(parsed.wsId, participant.id, clientId);
    }

    return clientInfo;
  }

  /** Get last 500 events for replay. */
  replay(): {
    events: SandboxEvent[];
    hasMore: boolean;
    cursor: { timestamp: number; id: string } | null;
  } {
    const REPLAY_LIMIT = 500;
    const rows = this.deps.repository.getEventsForReplay(REPLAY_LIMIT);
    const hasMore = rows.length >= REPLAY_LIMIT;

    const events: SandboxEvent[] = [];
    for (const row of rows) {
      try {
        events.push(JSON.parse(row.data));
      } catch {
        // Skip malformed
      }
    }

    const cursor = rows.length > 0 ? { timestamp: rows[0].created_at, id: rows[0].id } : null;

    return { events, hasMore, cursor };
  }

  /** Look up a connected client, recovering from hibernation if needed. */
  getClientInfo(ws: WebSocket): ClientInfo | null {
    const cached = this.deps.wsManager.getClient(ws);
    if (cached) return cached;

    const mapping = this.deps.wsManager.recoverClientMapping(ws);
    if (!mapping) {
      this.deps.log.warn("No client mapping found after hibernation, closing WebSocket");
      this.deps.wsManager.close(ws, 4002, "Session expired, please reconnect");
      return null;
    }

    this.deps.log.info("Recovered client info from DB", { user_id: mapping.user_id });
    const clientInfo: ClientInfo = {
      participantId: mapping.participant_id,
      userId: mapping.user_id,
      name: mapping.scm_name || mapping.scm_login || mapping.user_id,
      avatar: getAvatarUrl(
        mapping.scm_login,
        resolveScmProviderFromEnv(this.deps.env.SCM_PROVIDER)
      ),
      status: "active",
      lastSeen: Date.now(),
      clientId: mapping.client_id || `client-${Date.now()}`,
      ws,
    };

    this.deps.wsManager.setClient(ws, clientInfo);
    return clientInfo;
  }

  /** Fire all triggers matching this session + event. */
  async fireTriggers(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const matching = this.triggers.filter(
      (t) => t.watchSessionId === sessionId && t.onEvent === event
    );

    for (const trigger of matching) {
      try {
        if (trigger.notify.type === "session") {
          this.broadcast({ type: "child_session_update", ...payload } as ServerMessage);
        } else {
          await fetch(trigger.notify.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, event, ...payload }),
          });
        }
      } catch (e) {
        this.deps.log.error("Trigger failed", {
          event: "session_server.trigger_failed",
          watch_session: trigger.watchSessionId,
          trigger_event: trigger.onEvent,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}
