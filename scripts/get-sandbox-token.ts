#!/usr/bin/env bun
/**
 * Get a separate OAuth token for the sandbox.
 *
 * This does the same thing as `pi /login` but instead of saving to
 * ~/.pi/agent/auth.json (which your laptop Pi uses), it just prints
 * the token so you can paste it into the web UI secrets page.
 *
 * Usage: bun scripts/get-sandbox-token.ts
 *
 * It opens your browser, you authorize, and it prints the refresh token.
 * Paste that into ANTHROPIC_OAUTH_TOKEN in the web UI.
 */

import { createServer } from "node:http";

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PORT = 53693; // Different port from Pi's normal login (53692) so they don't conflict
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

// PKCE challenge generation
async function generatePKCE() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { verifier, challenge };
}

async function main() {
  const { verifier, challenge } = await generatePKCE();

  // Start callback server
  const { promise, resolve } = Promise.withResolvers<{ code: string; state: string }>();

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error || !code || !state) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Auth failed</h1><p>Check the terminal.</p>");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Done!</h1><p>Go back to the terminal to get your token.</p>");
    resolve({ code, state });
  });

  server.listen(PORT, "127.0.0.1");

  // Build auth URL and open browser
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  const authUrl = `${AUTHORIZE_URL}?${params}`;

  console.log("\n🔑 Opening browser to authorize a SEPARATE token for the sandbox...\n");
  console.log("If the browser doesn't open, go to:");
  console.log(authUrl);
  console.log();

  // Open browser
  Bun.spawn(["open", authUrl]);

  // Wait for callback
  const { code, state } = await promise;
  server.close();

  // Exchange code for tokens
  console.log("Exchanging code for tokens...");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Token exchange failed: ${response.status} ${body}`);
    process.exit(1);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  console.log("\n✅ Got a separate token for the sandbox!\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Paste this into ANTHROPIC_OAUTH_TOKEN in the web UI:\n");
  console.log(data.refresh_token);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\nThis is independent from your laptop's Pi token.");
  console.log("They won't interfere with each other.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
