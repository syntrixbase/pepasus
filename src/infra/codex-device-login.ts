/**
 * Codex Device Code Login — headless-friendly OAuth for OpenAI Codex.
 *
 * Extracted from the original codex-oauth.ts device code flow.
 * Works in terminals without a browser callback server (unlike pi-ai's
 * loginOpenAICodex which uses PKCE + local HTTP server).
 *
 * Returns pi-ai's OAuthCredentials format { access, refresh, expires }
 * with accountId as an extra field (needed for Codex API calls).
 */
import type { OAuthCredentials } from "@mariozechner/pi-ai";

// ── OAuth constants (from Codex CLI Rust source) ──
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const VERIFY_URL = "https://auth.openai.com/codex/device";

// Maximum wait time for device code polling (15 minutes)
const POLL_MAX_WAIT_MS = 15 * 60 * 1000;

// Token refresh buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Response from the device code user-code request. */
interface DeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval: number | string;
}

/** Response from the device code token polling endpoint. */
interface DeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
  code_challenge: string;
}

/** Response from the token exchange endpoint. */
interface TokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

/** Extract accountId from JWT id_token (decode payload without verification). */
function extractAccountId(idToken: string): string | null {
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf-8"),
    );
    return (
      payload["https://api.openai.com/auth"]?.["chatgpt_account_id"] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Poll the device token endpoint until the user completes authentication
 * or the maximum wait time is exceeded.
 */
async function pollForToken(
  deviceAuthId: string,
  userCode: string,
  intervalSeconds: number,
): Promise<DeviceTokenResponse> {
  const startTime = Date.now();
  const intervalMs = intervalSeconds * 1000;

  while (Date.now() - startTime < POLL_MAX_WAIT_MS) {
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    if (response.ok) {
      return (await response.json()) as DeviceTokenResponse;
    }

    if (response.status === 403 || response.status === 404) {
      // User hasn't completed auth yet — wait and retry
      const elapsed = Date.now() - startTime;
      const remaining = POLL_MAX_WAIT_MS - elapsed;
      const sleepMs = Math.min(intervalMs, remaining);
      if (sleepMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      continue;
    }

    // Unexpected status
    const text = await response.text();
    throw new Error(
      `Device auth polling failed (${response.status}): ${text}`,
    );
  }

  throw new Error("Device auth timed out after 15 minutes");
}

/**
 * Run the Codex device code OAuth flow.
 *
 * Headless-friendly flow:
 * 1. Request a device code from the server
 * 2. Display the code and verification URL to the user
 * 3. Poll until the user completes authentication in their browser
 * 4. Exchange the authorization code for tokens
 *
 * @returns OAuthCredentials with accountId as extra field
 */
export async function loginCodexDeviceCode(): Promise<OAuthCredentials> {
  // Step 1: Request device code
  const codeResponse = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!codeResponse.ok) {
    const text = await codeResponse.text();
    throw new Error(
      `Device code request failed (${codeResponse.status}): ${text}`,
    );
  }

  const codeData = (await codeResponse.json()) as DeviceCodeResponse;
  const interval =
    typeof codeData.interval === "string"
      ? parseInt(codeData.interval, 10)
      : codeData.interval;

  // Step 2: Display instructions to user
  console.log(`\nOpen ${VERIFY_URL}`);
  console.log(`Enter code: ${codeData.user_code}`);
  console.log("(expires in 15 minutes)\n");

  // Step 3: Poll for token
  const { authorization_code, code_verifier } = await pollForToken(
    codeData.device_auth_id,
    codeData.user_code,
    interval,
  );

  // Step 4: Exchange authorization code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: authorization_code,
    code_verifier: code_verifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  });

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(
      `Token exchange failed (${tokenResponse.status}): ${text}`,
    );
  }

  const tokenData = (await tokenResponse.json()) as TokenExchangeResponse;

  // Step 5: Extract accountId from id_token (NOT access_token)
  const accountId = tokenData.id_token
    ? (extractAccountId(tokenData.id_token) ?? "")
    : "";

  // Step 6: Build credentials in pi-ai OAuthCredentials format
  const creds: OAuthCredentials = {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + tokenData.expires_in * 1000 - REFRESH_BUFFER_MS,
    accountId,
  };

  return creds;
}
