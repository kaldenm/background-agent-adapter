import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { serverFetch } from "@/lib/server";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { code: string; verifier: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { code, verifier } = body;
  if (!code || !verifier) {
    return NextResponse.json({ error: "Missing code or verifier" }, { status: 400 });
  }

  // The code may arrive as "code#state" from the console callback page
  const [authCode, state] = code.includes("#") ? code.split("#", 2) : [code, verifier];

  // Exchange authorization code for tokens
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authCode,
        state,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  } catch (error) {
    console.error("Anthropic token exchange network error:", error);
    return NextResponse.json(
      { error: "Failed to reach Anthropic's token endpoint" },
      { status: 502 }
    );
  }

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error(`Anthropic token exchange failed: ${tokenResponse.status} ${errorBody}`);
    return NextResponse.json(
      {
        error: "Token exchange failed. The authorization code may have expired — please try again.",
      },
      { status: 400 }
    );
  }

  let tokenData: { access_token: string; refresh_token: string; expires_in: number };
  try {
    tokenData = await tokenResponse.json();
  } catch {
    return NextResponse.json({ error: "Invalid response from Anthropic" }, { status: 502 });
  }

  if (!tokenData.refresh_token) {
    return NextResponse.json(
      { error: "No refresh token received from Anthropic" },
      { status: 502 }
    );
  }

  // Save refresh token as a global secret
  try {
    const saveResponse = await serverFetch("/secrets", {
      method: "PUT",
      body: JSON.stringify({
        secrets: {
          ANTHROPIC_OAUTH_TOKEN: tokenData.refresh_token,
          ANTHROPIC_OAUTH_ACCESS_TOKEN: "",
          ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
        },
      }),
    });

    if (!saveResponse.ok) {
      const data = await saveResponse.json();
      console.error("Failed to save Anthropic token:", data);
      return NextResponse.json(
        { error: "Token exchanged but failed to save. Please try again." },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Failed to save Anthropic token:", error);
    return NextResponse.json(
      { error: "Token exchanged but failed to save. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
