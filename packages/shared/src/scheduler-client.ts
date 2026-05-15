/**
 * Scheduler client — shared by all bots.
 *
 * Bots are messengers, not actors. They submit dispatch requests to the
 * scheduler, which is the single source of truth for what runs.
 */

export interface SchedulerDispatchRequest {
  session: {
    repoOwner: string;
    repoName: string;
    userId: string;
    spawnSource: string;
    title?: string;
    model?: string;
    reasoningEffort?: string | null;
    branch?: string;
    scmLogin?: string;
    scmName?: string;
    scmEmail?: string;
    scmUserId?: string;
    scmToken?: string;
    scmRefreshToken?: string;
    scmTokenExpiresAt?: number;
  };
  prompt: {
    content: string;
    authorId: string;
    source?: string;
    callbackContext?: Record<string, unknown>;
  };
}

export interface SchedulerDispatchResult {
  sessionId: string;
  status: string;
}

/**
 * Submit a work request to the scheduler.
 * All session creation must go through here — the scheduler is the single door.
 */
export async function dispatchToScheduler(
  controlPlane: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  headers: Record<string, string>,
  request: SchedulerDispatchRequest
): Promise<SchedulerDispatchResult> {
  const response = await controlPlane.fetch("https://internal/scheduler/dispatch", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Scheduler dispatch failed: ${response.status} ${body}`);
  }

  return (await response.json()) as SchedulerDispatchResult;
}
