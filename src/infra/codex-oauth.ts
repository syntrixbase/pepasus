/**
 * Codex OAuth — PKCE flow for OpenAI Codex authentication.
 *
 * Handles token acquisition, storage, and automatic refresh.
 * Tokens are stored in {dataDir}/codex-auth.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { getLogger } from "./logger.ts";

const logger = getLogger("codex_oauth");

// ── OAuth endpoints (from OpenAI OIDC discovery) ──
const AUTHORIZE_URL = "https://auth.openai.com/authorize";
const TOKEN_URL = "https://auth0.openai.com/oauth/token";
const CALLBACK_PORT = 18199;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Token refresh buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Stored OAuth credentials. */
export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;  // Unix ms
  accountId: string;
}

/** Configuration for Codex OAuth. */
export interface CodexOAuthConfig {
  clientId: string;
  audience?: string;
  scope?: string;
  dataDir: string;
}

function credentialsPath(dataDir: string): string {
  return path.join(dataDir, "codex-auth.json");
}

// ── PKCE helpers ──

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ── Token storage ──

/** Load stored credentials from disk. Returns null if not found or expired. */
export function loadCredentials(dataDir: string): CodexCredentials | null {
  const filePath = credentialsPath(dataDir);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const creds = JSON.parse(content) as CodexCredentials;
    if (!creds.accessToken || !creds.refreshToken) return null;
    return creds;
  } catch {
    return null;
  }
}

/** Save credentials to disk. */
export function saveCredentials(dataDir: string, creds: CodexCredentials): void {
  const filePath = credentialsPath(dataDir);
  writeFileSync(filePath, JSON.stringify(creds, null, 2), "utf-8");
  logger.info("codex_credentials_saved");
}

// ── Token refresh ──

/** Refresh the access token using the refresh token. */
export async function refreshToken(
  config: CodexOAuthConfig,
  creds: CodexCredentials,
): Promise<CodexCredentials> {
  logger.info("codex_token_refreshing");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
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

  const data = await response.json() as {
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

  // Try to extract accountId from new token if available
  const extractedAccountId = extractAccountId(data.access_token);
  if (extractedAccountId) {
    newCreds.accountId = extractedAccountId;
  }

  saveCredentials(config.dataDir, newCreds);
  logger.info("codex_token_refreshed");
  return newCreds;
}

/** Get valid credentials, refreshing if needed. */
export async function getValidCredentials(
  config: CodexOAuthConfig,
): Promise<CodexCredentials | null> {
  let creds = loadCredentials(config.dataDir);
  if (!creds) return null;

  if (Date.now() >= creds.expiresAt) {
    try {
      creds = await refreshToken(config, creds);
    } catch (err) {
      logger.error({ error: err }, "codex_token_refresh_failed");
      return null;
    }
  }

  return creds;
}

// ── Account ID extraction ──

/** Extract accountId from JWT access token (decode payload without verification). */
function extractAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf-8"),
    );
    return payload["https://api.openai.com/auth"]?.["user_id"]
      ?? payload["sub"]
      ?? null;
  } catch {
    return null;
  }
}

// ── PKCE OAuth flow ──

/** Run the full PKCE OAuth flow. Opens browser, waits for callback. */
export async function loginCodexOAuth(
  config: CodexOAuthConfig,
): Promise<CodexCredentials> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  // Build authorize URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (config.audience) params.set("audience", config.audience);
  if (config.scope) params.set("scope", config.scope);

  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  // Wait for callback
  const code = await waitForCallback(authorizeUrl, state);

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  const accountId = extractAccountId(data.access_token) ?? "";

  const creds: CodexCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS,
    accountId,
  };

  saveCredentials(config.dataDir, creds);
  logger.info({ accountId }, "codex_oauth_login_success");
  return creds;
}

/** Start a local HTTP server, open browser, and wait for the OAuth callback. */
async function waitForCallback(authorizeUrl: string, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://127.0.0.1:${CALLBACK_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authentication Failed</h1><p>You can close this window.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Invalid callback</h1><p>State mismatch or missing code.</p>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Authentication Successful</h1><p>You can close this window and return to Pegasus.</p>");
      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      logger.info({ url: authorizeUrl }, "codex_oauth_open_browser");
      // Open browser — cross-platform
      const { exec } = require("child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} "${authorizeUrl}"`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timeout (5 minutes)"));
    }, 5 * 60 * 1000);
  });
}
