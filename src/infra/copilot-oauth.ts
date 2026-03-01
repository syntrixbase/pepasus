/**
 * Copilot OAuth — GitHub Device Code flow + Copilot Token Exchange.
 *
 * Two-step authentication:
 * 1. GitHub OAuth Device Flow → persistent github_token (stored on disk)
 * 2. Copilot Token Exchange → short-lived copilot_token (auto-refreshed)
 *
 * The copilot_token is OpenAI-compatible, used with createOpenAICompatibleModel.
 * Token format: semicolon-separated key=value pairs containing proxy-ep for baseURL.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getLogger } from "./logger.ts";

const logger = getLogger("copilot_oauth");

// ── Constants ──
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";

// Token refresh buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Maximum wait time for device code polling (15 minutes)
const POLL_MAX_WAIT_MS = 15 * 60 * 1000;

/** Stored Copilot credentials. */
export interface CopilotCredentials {
  githubToken: string;      // persistent GitHub access token
  copilotToken: string;     // short-lived Copilot API token
  copilotExpiresAt: number; // Unix ms
  baseURL: string;          // derived from token's proxy-ep
}

// ── Token storage ──

/** Load stored credentials from disk. Returns null if not found or invalid. */
export function loadCredentials(
  credPath: string,
): CopilotCredentials | null {
  if (!existsSync(credPath)) return null;
  try {
    const content = readFileSync(credPath, "utf-8");
    const creds = JSON.parse(content) as CopilotCredentials;
    if (!creds.githubToken || !creds.copilotToken) return null;
    return creds;
  } catch {
    return null;
  }
}

/** Save credentials to disk. */
export function saveCredentials(
  credPath: string,
  creds: CopilotCredentials,
): void {
  writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf-8");
  logger.info("copilot_credentials_saved");
}

// ── Copilot Base URL derivation ──

/**
 * Extract proxy-ep from a Copilot token and derive the API base URL.
 *
 * Token format: "tid=xxx;exp=123;sku=yyy;proxy-ep=proxy.individual.githubcopilot.com"
 * Replace leading "proxy." with "api." for the baseURL.
 * Returns DEFAULT_COPILOT_BASE_URL if proxy-ep is not found.
 */
export function deriveCopilotBaseURL(token: string): string {
  const parts = token.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === "proxy-ep" && value) {
      const host = value.startsWith("proxy.")
        ? "api." + value.slice("proxy.".length)
        : value;
      return `https://${host}`;
    }
  }
  return DEFAULT_COPILOT_BASE_URL;
}

// ── Copilot Token Exchange ──

/** Response from the Copilot token endpoint. */
interface CopilotTokenResponse {
  token: string;
  expires_at: number; // Unix seconds
}

/**
 * Exchange a GitHub access token for a short-lived Copilot API token.
 * Returns the copilot token, expiry (Unix ms), and derived base URL.
 */
export async function exchangeCopilotToken(
  githubToken: string,
): Promise<{ copilotToken: string; expiresAt: number; baseURL: string }> {
  logger.info("copilot_token_exchanging");

  const response = await fetch(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Copilot token exchange failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as CopilotTokenResponse;

  const baseURL = deriveCopilotBaseURL(data.token);
  const expiresAt = data.expires_at * 1000; // Convert to Unix ms

  logger.info("copilot_token_exchanged");
  return { copilotToken: data.token, expiresAt, baseURL };
}

// ── Credential retrieval with auto-refresh ──

/**
 * Get valid Copilot credentials, auto-refreshing the copilot token if expired.
 * Uses the stored persistent github_token to exchange for a new copilot token.
 * Returns null if no credentials are stored.
 */
export async function getValidCopilotCredentials(
  credPath: string,
): Promise<CopilotCredentials | null> {
  const creds = loadCredentials(credPath);
  if (!creds) return null;

  // Check if copilot token is still valid (with 5min buffer)
  if (Date.now() < creds.copilotExpiresAt - REFRESH_BUFFER_MS) {
    return creds;
  }

  // Token expired or about to expire — refresh using github token
  try {
    logger.info("copilot_token_refreshing");
    const fresh = await exchangeCopilotToken(creds.githubToken);
    const newCreds: CopilotCredentials = {
      githubToken: creds.githubToken,
      copilotToken: fresh.copilotToken,
      copilotExpiresAt: fresh.expiresAt,
      baseURL: fresh.baseURL,
    };
    saveCredentials(credPath, newCreds);
    logger.info("copilot_token_refreshed");
    return newCreds;
  } catch (err) {
    logger.error({ error: err }, "copilot_token_refresh_failed");
    return null;
  }
}

// ── Device Code OAuth flow ──

/** Response from the GitHub device code endpoint. */
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

/**
 * Run the GitHub device code OAuth flow + Copilot token exchange.
 *
 * This is a headless-friendly flow:
 * 1. Request device code from GitHub
 * 2. Display code and URL for user to visit
 * 3. Poll until user completes authentication
 * 4. Exchange GitHub token for Copilot token
 * 5. Save all credentials
 */
export async function loginCopilot(
  credPath: string,
): Promise<CopilotCredentials> {
  // Step 1: Request device code
  const codeResponse = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!codeResponse.ok) {
    const text = await codeResponse.text();
    throw new Error(
      `Device code request failed (${codeResponse.status}): ${text}`,
    );
  }

  const codeData = (await codeResponse.json()) as DeviceCodeResponse;

  // Step 2: Display instructions to user (console.log, NOT logger — user must see this)
  console.log(
    `\nVisit ${codeData.verification_uri} and enter code: ${codeData.user_code}`,
  );
  console.log("(expires in 15 minutes)\n");

  // Step 3: Poll for access token
  const githubToken = await pollForGitHubToken(
    codeData.device_code,
    codeData.interval,
  );

  // Step 4: Exchange for Copilot token
  const { copilotToken, expiresAt, baseURL } =
    await exchangeCopilotToken(githubToken);

  // Step 5: Save all credentials
  const creds: CopilotCredentials = {
    githubToken,
    copilotToken,
    copilotExpiresAt: expiresAt,
    baseURL,
  };

  saveCredentials(credPath, creds);
  logger.info("copilot_device_code_login_success");
  return creds;
}

/** Response from the GitHub access token polling endpoint. */
interface GitHubAccessTokenResponse {
  access_token?: string;
  error?: string;
  interval?: number;
}

/**
 * Poll the GitHub access token endpoint until the user completes authentication
 * or the maximum wait time is exceeded.
 */
async function pollForGitHubToken(
  deviceCode: string,
  intervalSeconds: number,
): Promise<string> {
  const startTime = Date.now();
  let interval = intervalSeconds;

  while (Date.now() - startTime < POLL_MAX_WAIT_MS) {
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub token polling failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as GitHubAccessTokenResponse;

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === "authorization_pending") {
      // User hasn't completed auth yet — wait and retry
      const sleepMs = (data.interval ?? interval) * 1000;
      const elapsed = Date.now() - startTime;
      const remaining = POLL_MAX_WAIT_MS - elapsed;
      const waitMs = Math.min(sleepMs, remaining);
      if (waitMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (data.error === "slow_down") {
      // Server asks us to slow down — increase interval
      interval = (data.interval ?? interval + 5);
      const sleepMs = interval * 1000;
      const elapsed = Date.now() - startTime;
      const remaining = POLL_MAX_WAIT_MS - elapsed;
      const waitMs = Math.min(sleepMs, remaining);
      if (waitMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (data.error === "expired_token") {
      throw new Error("Device code expired — please try again");
    }

    if (data.error === "access_denied") {
      throw new Error("User denied access");
    }

    // Unknown error
    throw new Error(
      `GitHub OAuth error: ${data.error ?? "unknown"}`,
    );
  }

  throw new Error("Device auth timed out after 15 minutes");
}
