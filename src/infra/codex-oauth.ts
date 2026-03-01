/**
 * Codex OAuth — Device Code flow for OpenAI Codex authentication.
 *
 * Handles token acquisition, storage, and automatic refresh.
 * Tokens are stored at the path provided by the caller (from config authDir).
 *
 * Uses the headless-friendly device code flow instead of browser-based PKCE,
 * matching the Codex CLI Rust implementation.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getLogger } from "./logger.ts";

const logger = getLogger("codex_oauth");

// ── OAuth constants (from Codex CLI Rust source) ──
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const VERIFY_URL = "https://auth.openai.com/codex/device";

// Token refresh buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Maximum wait time for device code polling (15 minutes)
const POLL_MAX_WAIT_MS = 15 * 60 * 1000;

/** Stored OAuth credentials. */
export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms
  accountId: string;
}

// ── Token storage ──

/** Load stored credentials from disk. Returns null if not found or invalid. */
export function loadCredentials(
  credPath: string,
): CodexCredentials | null {
  if (!existsSync(credPath)) return null;
  try {
    const content = readFileSync(credPath, "utf-8");
    const creds = JSON.parse(content) as CodexCredentials;
    if (!creds.accessToken || !creds.refreshToken) return null;
    return creds;
  } catch {
    return null;
  }
}

/** Save credentials to disk. */
export function saveCredentials(
  creds: CodexCredentials,
  credPath: string,
): void {
  writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf-8");
  logger.info("codex_credentials_saved");
}

/**
 * Validate that credentials look usable:
 * - accessToken is a decodable JWT (3 parts, valid base64 payload)
 * - accessToken has expected claim structure
 * - Not expired
 *
 * Returns false if token is corrupted/fake — caller should re-auth.
 */
export function validateCredentials(creds: CodexCredentials): boolean {
  // Check expiry
  if (Date.now() >= creds.expiresAt) return false;

  // Check accessToken is a valid JWT with 3 parts
  const parts = creds.accessToken.split(".");
  if (parts.length < 3) return false;

  // Check payload is valid base64 JSON
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf-8"),
    );
    // Must have the OpenAI auth claim or at least iss/aud
    if (!payload || typeof payload !== "object") return false;
    if (!payload["iss"] && !payload["https://api.openai.com/auth"]) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Verify a Codex access token by calling the usage endpoint (read-only, no quota cost).
 * Returns true if the token is accepted, false if rejected (401/403/network error).
 */
export async function verifyToken(
  accessToken: string,
  accountId: string,
  baseURL: string = "https://chatgpt.com/backend-api",
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const response = await fetch(`${baseURL}/wham/usage`, {
      method: "GET",
      headers,
    });

    if (response.ok) return true;

    logger.warn(
      { status: response.status },
      "codex_token_verification_failed",
    );
    return false;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "codex_token_verification_error",
    );
    return false;
  }
}

// ── Account ID extraction ──

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

// ── Token refresh ──

/** Refresh the access token using the refresh token. */
export async function refreshToken(
  creds: CodexCredentials,
  credPath: string,
): Promise<CodexCredentials> {
  logger.info("codex_token_refreshing");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: creds.refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  const newCreds: CodexCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS,
    accountId: creds.accountId,
  };

  // Try to extract accountId from id_token if available
  const extractedAccountId = data.id_token
    ? extractAccountId(data.id_token)
    : null;
  if (extractedAccountId) {
    newCreds.accountId = extractedAccountId;
  }

  saveCredentials(newCreds, credPath);
  logger.info("codex_token_refreshed");
  return newCreds;
}

/** Get valid credentials, refreshing if needed. */
export async function getValidCredentials(
  credPath: string,
): Promise<CodexCredentials | null> {
  let creds = loadCredentials(credPath);
  if (!creds) return null;

  if (Date.now() >= creds.expiresAt) {
    try {
      creds = await refreshToken(creds, credPath);
    } catch (err) {
      logger.error({ error: err }, "codex_token_refresh_failed");
      return null;
    }
  }

  return creds;
}

// ── Device Code OAuth flow ──

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

/**
 * Run the device code OAuth flow for Codex authentication.
 *
 * This is a headless-friendly flow:
 * 1. Request a device code from the server
 * 2. Display the code and verification URL to the user
 * 3. Poll until the user completes authentication in their browser
 * 4. Exchange the authorization code for tokens
 */
export async function loginDeviceCode(credPath: string): Promise<CodexCredentials> {
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

  // Step 2: Display instructions to user (console.log, NOT logger — user must see this)
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

  // Step 6: Build credentials and save
  const creds: CodexCredentials = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000 - REFRESH_BUFFER_MS,
    accountId,
  };

  saveCredentials(creds, credPath);
  logger.info({ accountId }, "codex_device_code_login_success");
  return creds;
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
