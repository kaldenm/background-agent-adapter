/**
 * Publish scope guard.
 *
 * This intentionally does not run inside check:publish. It is a pre-staging
 * safety check for local worktrees that may contain tracked scratch/audit notes.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRATCH_DOC_PATTERNS = [
  /^context\.md$/,
  /^end-of-day-recap\.md$/,
  /^full-auth-audit\.md$/,
  /^pi-error-behavior-audit\.md$/,
  /^investigation-\d+-.+\.md$/,
  /^step\d+-review\.md$/,
  /^docs\/skill-outputs\//,
];

export function findScratchDocs(paths: string[]): string[] {
  return paths.filter((filePath) => SCRATCH_DOC_PATTERNS.some((pattern) => pattern.test(filePath)));
}

function gitChangedTrackedFiles(): string[] {
  const working = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
  return Array.from(
    new Set(
      [...working.split(/\r?\n/), ...staged.split(/\r?\n/)]
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ).sort();
}

export function buildScopeReport(paths: string[]): { ok: boolean; message: string } {
  const scratchDocs = findScratchDocs(paths);
  if (scratchDocs.length === 0) {
    return {
      ok: true,
      message: "Publish scope ok: no tracked scratch/audit docs are modified or staged.",
    };
  }

  return {
    ok: false,
    message: [
      "Publish scope warning: tracked scratch/audit docs are modified or staged.",
      "Do not use `git add -A` unless these are intentionally public:",
      ...scratchDocs.map((filePath) => `- ${filePath}`),
    ].join("\n"),
  };
}

export function runPublishScopeCheck(paths = gitChangedTrackedFiles()): number {
  const report = buildScopeReport(paths);
  const write = report.ok ? console.log : console.error;
  write(report.message);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(runPublishScopeCheck());
}
