import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { generateInstallationToken, postReaction, checkSenderPermission } from "./github-auth";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { buildInternalAuthHeaders } from "./utils/internal";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { dispatchToScheduler } from "@open-inspect/shared";

export type HandlerResult =
  | { outcome: "processed"; session_id: string; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

async function getAuthHeaders(env: Env, traceId: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
}

function stripMention(body: string, botUsername: string): string {
  return body.replace(new RegExp(`@${botUsername}\\s*`, "gi"), "").trim();
}

// ─── Gating ────────────────────────────────────────────────────────────────

type GatingResult =
  | {
      allowed: true;
      ghToken: string;
      headers: Record<string, string>;
    }
  | {
      allowed: false;
      reason: string;
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<GatingResult> {
  const ghToken = await generateInstallationToken(env);

  if (config.requirePermissionCheck) {
    const hasPermission = await checkSenderPermission(ghToken, owner, repoName, senderLogin);
    if (!hasPermission) {
      log.debug("handler.permission_denied", {
        trace_id: traceId,
        sender: senderLogin,
        repo: repoFullName,
      });
      return { allowed: false, reason: "permission_denied" };
    }
  }

  const headers = await getAuthHeaders(env, traceId);
  return { allowed: true, ghToken, headers };
}

function fireAndForgetReaction(
  log: Logger,
  ghToken: string,
  url: string,
  meta: Record<string, unknown>
): void {
  postReaction(ghToken, url).catch((e) => {
    log.warn("reaction.failed", { ...meta, error: e instanceof Error ? e.message : String(e) });
  });
}

// ─── Handlers ──────────────────────────────────────────────────────────────
// Each handler receives a webhook, validates it, and submits a dispatch
// request to the scheduler. The scheduler creates the session.

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, requested_reviewer, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    return { outcome: "skipped", skip_reason: "not_requested" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };

  fireAndForgetReaction(
    log,
    gating.ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    { trace_id: traceId, repo: repoFullName, pull_number: pr.number }
  );

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const result = await dispatchToScheduler(env.CONTROL_PLANE, gating.headers, {
    session: {
      repoOwner: owner,
      repoName,
      userId: `github:${sender.id}`,
      spawnSource: "github",
      title: `GitHub: Review PR #${pr.number}`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      scmLogin: sender.login,
      scmUserId: String(sender.id),
    },
    prompt: { content: prompt, authorId: `github:${sender.id}`, source: "github" },
  });

  log.info("dispatch.succeeded", {
    trace_id: traceId,
    session_id: result.sessionId,
    action: "review",
  });
  return { outcome: "processed", session_id: result.sessionId, handler_action: "review" };
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) return { outcome: "skipped", skip_reason: "draft_pr" };
  if (pr.user.login === env.GITHUB_BOT_USERNAME)
    return { outcome: "skipped", skip_reason: "self_pr" };

  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName))
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  if (!config.autoReviewOnOpen) return { outcome: "skipped", skip_reason: "auto_review_disabled" };

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };

  fireAndForgetReaction(
    log,
    gating.ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    { trace_id: traceId, repo: repoFullName, pull_number: pr.number }
  );

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const result = await dispatchToScheduler(env.CONTROL_PLANE, gating.headers, {
    session: {
      repoOwner: owner,
      repoName,
      userId: `github:${sender.id}`,
      spawnSource: "github",
      title: `GitHub: Review PR #${pr.number}`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      scmLogin: sender.login,
      scmUserId: String(sender.id),
    },
    prompt: { content: prompt, authorId: `github:${sender.id}`, source: "github" },
  });

  log.info("dispatch.succeeded", {
    trace_id: traceId,
    session_id: result.sessionId,
    action: "auto_review",
  });
  return { outcome: "processed", session_id: result.sessionId, handler_action: "auto_review" };
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!issue.pull_request) return { outcome: "skipped", skip_reason: "not_a_pr" };
  if (!comment.body.toLowerCase().includes(`@${env.GITHUB_BOT_USERNAME.toLowerCase()}`))
    return { outcome: "skipped", skip_reason: "no_mention" };
  if (sender.login === env.GITHUB_BOT_USERNAME)
    return { outcome: "skipped", skip_reason: "self_comment" };

  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName))
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  fireAndForgetReaction(
    log,
    gating.ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${comment.id}/reactions`,
    { trace_id: traceId, repo: repoFullName, pull_number: issue.number }
  );

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: issue.number,
    title: issue.title,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    commentActionInstructions: config.commentActionInstructions,
  });

  const result = await dispatchToScheduler(env.CONTROL_PLANE, gating.headers, {
    session: {
      repoOwner: owner,
      repoName,
      userId: `github:${sender.id}`,
      spawnSource: "github",
      title: `GitHub: PR #${issue.number} comment`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      scmLogin: sender.login,
      scmUserId: String(sender.id),
    },
    prompt: { content: prompt, authorId: `github:${sender.id}`, source: "github" },
  });

  log.info("dispatch.succeeded", {
    trace_id: traceId,
    session_id: result.sessionId,
    action: "comment",
  });
  return { outcome: "processed", session_id: result.sessionId, handler_action: "comment" };
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!comment.body.toLowerCase().includes(`@${env.GITHUB_BOT_USERNAME.toLowerCase()}`))
    return { outcome: "skipped", skip_reason: "no_mention" };
  if (sender.login === env.GITHUB_BOT_USERNAME)
    return { outcome: "skipped", skip_reason: "self_comment" };

  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName))
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };

  const commentBody = stripMention(comment.body, env.GITHUB_BOT_USERNAME);

  fireAndForgetReaction(
    log,
    gating.ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/pulls/comments/${comment.id}/reactions`,
    { trace_id: traceId, repo: repoFullName, pull_number: pr.number }
  );

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    base: pr.base.ref,
    head: pr.head.ref,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    filePath: comment.path,
    diffHunk: comment.diff_hunk,
    commentId: comment.id,
    commentActionInstructions: config.commentActionInstructions,
  });

  const result = await dispatchToScheduler(env.CONTROL_PLANE, gating.headers, {
    session: {
      repoOwner: owner,
      repoName,
      userId: `github:${sender.id}`,
      spawnSource: "github",
      title: `GitHub: PR #${pr.number} review comment`,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      scmLogin: sender.login,
      scmUserId: String(sender.id),
    },
    prompt: { content: prompt, authorId: `github:${sender.id}`, source: "github" },
  });

  log.info("dispatch.succeeded", {
    trace_id: traceId,
    session_id: result.sessionId,
    action: "review_comment",
  });
  return { outcome: "processed", session_id: result.sessionId, handler_action: "review_comment" };
}
