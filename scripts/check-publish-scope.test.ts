import assert from "node:assert/strict";
import test from "node:test";
import { buildScopeReport, findScratchDocs } from "./check-publish-scope.ts";

test("finds tracked scratch and audit docs that should not be blanket-published", () => {
  assert.deepEqual(
    findScratchDocs([
      "context.md",
      "docs/skill-outputs/qa-plans/plan.md",
      "investigation-1-stale-sandbox.md",
      "step2-review.md",
      "packages/web/src/app.tsx",
    ]),
    [
      "context.md",
      "docs/skill-outputs/qa-plans/plan.md",
      "investigation-1-stale-sandbox.md",
      "step2-review.md",
    ]
  );
});

test("does not flag ordinary publish files", () => {
  const report = buildScopeReport([
    "package.json",
    "scripts/check-daytona-auth.ts",
    "packages/web/e2e/user-workflows.spec.ts",
  ]);

  assert.equal(report.ok, true);
  assert.match(report.message, /Publish scope ok/);
});

test("returns an actionable warning for modified scratch docs", () => {
  const report = buildScopeReport(["full-auth-audit.md", "packages/server/src/router.ts"]);

  assert.equal(report.ok, false);
  assert.match(report.message, /tracked scratch\/audit docs/);
  assert.match(report.message, /full-auth-audit\.md/);
  assert.match(report.message, /git add -A/);
});
