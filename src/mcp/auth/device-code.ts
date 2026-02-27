/**
 * RFC 8628 Device Authorization Grant — Device Code Flow.
 *
 * Implements the full device code flow for interactive MCP server authentication:
 *   1. Request device + user codes from the authorization server
 *   2. Display verification URI and user code to the operator
 *   3. Poll the token endpoint until the user authorizes (or error/timeout)
 *
 * The polling algorithm follows RFC 8628 §3.5:
 *   - Default interval from server response or config fallback
 *   - `slow_down` → increase interval by 5 seconds
 *   - `authorization_pending` → retry after interval
 *   - `expired_token` / `access_denied` → terminal errors
 *   - Network errors during polling are transient — log and retry
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 */

import { getLogger } from "../../infra/logger.ts";
import type {
  DeviceCodeAuthConfig,
  DeviceAuthorizationResponse,
  StoredToken,
} from "./types.ts";

const logger = getLogger("mcp.auth.device-code");

// ── Error ──

export type DeviceCodeAuthErrorCode = "expired" | "denied" | "network" | "timeout";

/**
 * Error thrown when the device code flow fails terminally.
 * The `code` property indicates the failure reason.
 */
export class DeviceCodeAuthError extends Error {
  override readonly name = "DeviceCodeAuthError";
  readonly code: DeviceCodeAuthErrorCode;

  constructor(code: DeviceCodeAuthErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ── Device Code Flow ──

/**
 * Execute the full RFC 8628 device authorization grant flow.
 *
 * @param serverName  Human-readable server name (for logging / display)
 * @param config      DeviceCodeAuthConfig with URLs, client credentials, and timing
 * @returns           A StoredToken ready for persistence
 * @throws            DeviceCodeAuthError on terminal failure
 */
export async function executeDeviceCodeFlow(
  serverName: string,
  config: DeviceCodeAuthConfig,
): Promise<StoredToken> {
  // ── Step 1: Request device authorization ──
  const deviceAuth = await requestDeviceAuthorization(config);

  // ── Step 2: Display verification info to the user ──
  displayUserPrompt(serverName, deviceAuth);

  // ── Step 3: Poll for token ──
  return pollForToken(config, deviceAuth);
}

// ── Internal helpers ──

/**
 * POST to the device authorization endpoint to obtain device_code + user_code.
 */
async function requestDeviceAuthorization(
  config: DeviceCodeAuthConfig,
): Promise<DeviceAuthorizationResponse> {
  const params = new URLSearchParams();
  params.set("client_id", config.clientId);
  if (config.clientSecret) {
    params.set("client_secret", config.clientSecret);
  }
  if (config.scope) {
    params.set("scope", config.scope);
  }

  let response: Response;
  try {
    response = await fetch(config.deviceAuthorizationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
  } catch (err) {
    logger.error({ err }, "Device authorization request failed (network)");
    throw new DeviceCodeAuthError(
      "network",
      `Failed to reach device authorization endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error(
      { status: response.status, body: text },
      "Device authorization endpoint returned error",
    );
    throw new DeviceCodeAuthError(
      "network",
      `Device authorization request failed with HTTP ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthorizationResponse;
}

/**
 * Print a visual banner so the operator knows where to authorize.
 */
function displayUserPrompt(
  serverName: string,
  deviceAuth: DeviceAuthorizationResponse,
): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         MCP Server Authentication Required      ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Server:  ${serverName}`);
  console.log(`║  URL:     ${deviceAuth.verification_uri}`);
  console.log(`║  Code:    ${deviceAuth.user_code}`);
  if (deviceAuth.verification_uri_complete) {
    console.log(`║  Direct:  ${deviceAuth.verification_uri_complete}`);
  }
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");

  logger.info(
    {
      serverName,
      verificationUri: deviceAuth.verification_uri,
      userCode: deviceAuth.user_code,
    },
    "Device code flow: waiting for user authorization",
  );
}

/**
 * Poll the token endpoint until the user authorizes, or a terminal error occurs.
 *
 * Implements RFC 8628 §3.5 polling semantics:
 * - `authorization_pending` → wait and retry
 * - `slow_down` → increase interval by 5000ms, then retry
 * - `expired_token` → throw expired
 * - `access_denied` → throw denied
 * - Network errors → log warning and retry
 * - Deadline exceeded → throw timeout
 */
async function pollForToken(
  config: DeviceCodeAuthConfig,
  deviceAuth: DeviceAuthorizationResponse,
): Promise<StoredToken> {
  // Interval: prefer server-provided, fall back to config
  let intervalMs =
    (deviceAuth.interval ?? config.pollIntervalSeconds) * 1000;

  // Deadline: minimum of config timeout and server expires_in
  const effectiveTimeoutMs =
    Math.min(config.timeoutSeconds, deviceAuth.expires_in) * 1000;
  const deadline = Date.now() + effectiveTimeoutMs;

  while (Date.now() < deadline) {
    // Wait before polling
    await sleep(intervalMs);

    // Check deadline after sleeping (may have expired during sleep)
    if (Date.now() >= deadline) {
      break;
    }

    let response: Response;
    try {
      response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceAuth.device_code,
          client_id: config.clientId,
        }).toString(),
      });
    } catch (err) {
      // Transient network error — log and continue polling
      logger.warn(
        { err },
        "Transient network error during token polling, will retry",
      );
      continue;
    }

    // Parse the response body
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      logger.warn("Failed to parse token response JSON, will retry");
      continue;
    }

    // Success — token granted
    if (response.ok && body.access_token) {
      const now = Date.now();
      const token: StoredToken = {
        accessToken: body.access_token as string,
        tokenType: (body.token_type as string) ?? "Bearer",
        obtainedAt: now,
        authType: "device_code",
      };

      if (body.refresh_token) {
        token.refreshToken = body.refresh_token as string;
      }

      if (body.scope) {
        token.scope = body.scope as string;
      }

      if (typeof body.expires_in === "number") {
        token.expiresAt = now + (body.expires_in as number) * 1000;
      }

      logger.info("Device code flow completed — token obtained");
      return token;
    }

    // OAuth error responses (RFC 8628 §3.5)
    const error = body.error as string | undefined;

    switch (error) {
      case "authorization_pending":
        // Expected — user hasn't authorized yet, continue polling
        continue;

      case "slow_down":
        // RFC 8628 §3.5: increase interval by 5 seconds
        intervalMs += 5000;
        logger.info({ newIntervalMs: intervalMs }, "Received slow_down, increasing poll interval");
        continue;

      case "expired_token":
        throw new DeviceCodeAuthError(
          "expired",
          "Device code expired before user authorized",
        );

      case "access_denied":
        throw new DeviceCodeAuthError(
          "denied",
          "User denied the authorization request",
        );

      default:
        // Unknown error — log and continue (treat as transient)
        logger.warn({ error, status: response.status }, "Unexpected token response, will retry");
        continue;
    }
  }

  // Deadline exceeded
  throw new DeviceCodeAuthError(
    "timeout",
    `Device code flow timed out after ${config.timeoutSeconds}s`,
  );
}

/** Promise-based sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
