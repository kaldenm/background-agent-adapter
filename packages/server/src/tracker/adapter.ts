/**
 * Tracker Adapter — the interface for polling external trackers.
 *
 * The scheduler calls fetchCandidateIssues() on every tick to ask:
 * "what's new in the world?" Each adapter knows how to talk to one
 * tracker (GitHub, Linear, etc.) and return a normalized list of issues.
 *
 * The scheduler decides what to do with them — check if they're already
 * being worked on, check concurrency limits, dispatch new ones.
 */

export interface TrackerIssue {
  /** Unique ID from the tracker (e.g., "github:owner/repo#42") */
  id: string;

  /** Human-readable title */
  title: string;

  /** Repo this issue belongs to */
  repoOwner: string;
  repoName: string;

  /** Where this came from */
  source: "github" | "linear";

  /** The prompt to send to the agent */
  prompt: string;

  /** Who triggered this (for attribution) */
  authorId: string;

  /** Extra metadata the adapter wants to pass through */
  meta?: Record<string, unknown>;
}

export type IssueState = "open" | "closed" | "merged" | "cancelled" | "unknown";

export interface TrackerAdapter {
  /** Which tracker this adapter talks to */
  kind: string;

  /** "What's new?" — called every tick */
  fetchCandidateIssues(): Promise<TrackerIssue[]>;

  /** "What changed?" — check status of things we're already working on */
  fetchIssueStatesByIds(ids: string[]): Promise<Record<string, IssueState>>;
}
