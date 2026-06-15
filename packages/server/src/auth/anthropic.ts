/**
 * Anthropic OAuth token refresh utilities.
 *
 * Anthropic uses rotating refresh tokens — each refresh returns a NEW
 * refresh token and invalidates the old one. The new refresh token MUST
 * be persisted or future refreshes will fail (the user has to re-link).
 */

const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export class AnthropicTokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
  }
}

/**
 * Refresh an Anthropic OAuth access token using a refresh token.
 *
 * IMPORTANT: Anthropic rotates refresh tokens on every refresh. The caller
 * MUST persist the new `refresh_token` from the response, otherwise the
 * next refresh attempt will fail with 401 (old token revoked).
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<AnthropicTokenResponse> {
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AnthropicTokenRefreshError(
      `Anthropic token refresh failed: ${response.status}`,
      response.status,
      body
    );
  }

  return response.json() as Promise<AnthropicTokenResponse>;
}
