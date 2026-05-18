import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionInternalPaths } from "./contracts";

describe("session internal endpoint contracts", () => {
  it("uses contract constants in internal route wiring and router for known endpoints", () => {
    const routerSource = readFileSync(new URL("../router.ts", import.meta.url), "utf8");
    const routesSource = readFileSync(new URL("./http/routes.ts", import.meta.url), "utf8");
    const durableObjectSource = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

    // Note: 'init' is not listed here — session init is handled by the scheduler
    // via create-session.ts, not directly by the router.
    const routerEndpointKeys: Array<keyof typeof SessionInternalPaths> = [
      "verifySandboxToken",
      "state",
      "prompt",
      "stop",
      "createMediaArtifact",
      "events",
      "artifacts",
      "participants",
      "messages",
      "createPr",
      "openaiTokenRefresh",
      "wsToken",
      "archive",
      "unarchive",
      "spawnContext",
      "childSessionUpdate",
      "childSummary",
      "cancel",
      "updateTitle",
    ];

    for (const endpointKey of routerEndpointKeys) {
      expect(routerSource).toContain(`SessionInternalPaths.${endpointKey}`);
    }

    for (const endpointKey of Object.keys(SessionInternalPaths) as Array<
      keyof typeof SessionInternalPaths
    >) {
      expect(routesSource).toContain(`SessionInternalPaths.${endpointKey}`);
    }

    expect(durableObjectSource).toContain("createSessionInternalRoutes");
    // The router must use SessionInternalPaths constants for session DO calls,
    // not raw "/internal/..." URLs. The scheduler dispatch URL is an exception
    // (it targets the scheduler DO, not a session DO).
    const sessionInternalUrlPattern = /stub\.fetch\(["']http:\/\/internal\/internal\//;
    const routerWithoutSchedulerDispatch = routerSource.replace(
      /\/\/ Forward.*handleSchedulerDispatch[\s\S]*?^\}/m,
      ""
    );
    // Check no raw session-internal URLs outside the scheduler dispatch handler
    for (const line of routerWithoutSchedulerDispatch.split("\n")) {
      if (
        line.includes('"http://internal/internal/') &&
        !line.includes("/internal/dispatch")
      ) {
        expect.unreachable(
          `Raw session-internal URL found in router (use SessionInternalPaths instead): ${line.trim()}`
        );
      }
    }
    expect(routesSource).not.toContain('"/internal/');
    expect(routesSource).not.toContain("'/internal/");
  });
});
