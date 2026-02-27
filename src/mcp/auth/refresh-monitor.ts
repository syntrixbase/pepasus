/**
 * Token Refresh Monitor — proactive background refresh for MCP OAuth tokens.
 *
 * Periodically checks tracked servers' tokens and:
 *   - Refreshes tokens that are about to expire (within 5 minutes)
 *   - Emits events for expired, expiring, refreshed, and failed tokens
 *   - Isolates event handler errors so one bad handler can't crash the monitor
 *
 * Usage:
 *   const monitor = new TokenRefreshMonitor(tokenStore);
 *   monitor.track("my-server", config);
 *   monitor.onEvent((e) => console.log(e));
 *   // ... later:
 *   monitor.stop();
 */

import { getLogger } from "../../infra/logger.ts";
import { TokenStore } from "./token-store.ts";
import { refreshToken } from "./provider-factory.ts";
import type { DeviceCodeAuthConfig } from "./types.ts";

const log = getLogger("mcp.auth.refresh-monitor");

/** Tokens expiring within this window trigger a proactive refresh. */
const REFRESH_THRESHOLD_MS = 300_000; // 5 minutes

// ── Public Types ──

export interface AuthEvent {
  type: "auth:expiring_soon" | "auth:expired" | "auth:refresh_failed" | "auth:refreshed";
  server: string;
  message: string;
}

export type AuthEventHandler = (event: AuthEvent) => void;

// ── Monitor ──

export class TokenRefreshMonitor {
  private readonly tokenStore: TokenStore;
  private readonly tracked = new Map<string, DeviceCodeAuthConfig>();
  private readonly handlers: AuthEventHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param tokenStore       Filesystem-backed token persistence
   * @param checkIntervalMs  How often to run the check cycle (default: 60s)
   */
  constructor(tokenStore: TokenStore, checkIntervalMs = 60_000) {
    this.tokenStore = tokenStore;
    this.timer = setInterval(() => {
      this.checkOnce().catch((err) => {
        log.error({ err }, "Unhandled error in refresh monitor check cycle");
      });
    }, checkIntervalMs);
  }

  /** Register a server to monitor for token expiry. */
  track(serverName: string, config: DeviceCodeAuthConfig): void {
    this.tracked.set(serverName, config);
    log.debug({ serverName }, "Now tracking server for token refresh");
  }

  /** Stop monitoring a server. */
  untrack(serverName: string): void {
    this.tracked.delete(serverName);
    log.debug({ serverName }, "Stopped tracking server for token refresh");
  }

  /** Register an event handler. */
  onEvent(handler: AuthEventHandler): void {
    this.handlers.push(handler);
  }

  /** Stop the periodic timer. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one check cycle across all tracked servers.
   * Public so tests can call it directly without waiting for the interval.
   */
  async checkOnce(): Promise<void> {
    for (const [serverName, config] of this.tracked) {
      try {
        await this.checkServer(serverName, config);
      } catch (err) {
        log.error({ serverName, err }, "Unexpected error checking server token");
      }
    }
  }

  // ── Private ──

  private async checkServer(serverName: string, config: DeviceCodeAuthConfig): Promise<void> {
    const token = this.tokenStore.load(serverName);

    if (!token) {
      log.debug({ serverName }, "No stored token — skipping");
      return;
    }

    if (token.expiresAt == null) {
      log.debug({ serverName }, "Token has no expiresAt — skipping");
      return;
    }

    const msUntilExpiry = token.expiresAt - Date.now();

    // Already expired
    if (msUntilExpiry <= 0) {
      log.error({ serverName }, "Token has expired");
      this.emit({
        type: "auth:expired",
        server: serverName,
        message: `Token for "${serverName}" has expired`,
      });
      return;
    }

    // Expiring soon — within threshold
    if (msUntilExpiry <= REFRESH_THRESHOLD_MS) {
      if (token.refreshToken) {
        // Attempt proactive refresh
        try {
          const refreshed = await refreshToken(serverName, config, token.refreshToken);
          this.tokenStore.save(serverName, refreshed);
          log.info({ serverName }, "Token proactively refreshed");
          this.emit({
            type: "auth:refreshed",
            server: serverName,
            message: `Token for "${serverName}" was refreshed successfully`,
          });
        } catch (err) {
          log.error({ serverName, err }, "Token refresh failed");
          this.emit({
            type: "auth:refresh_failed",
            server: serverName,
            message: `Token refresh failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else {
        // No refresh token available — just warn
        log.warn({ serverName }, "Token expiring soon but no refresh_token available");
        this.emit({
          type: "auth:expiring_soon",
          server: serverName,
          message: `Token for "${serverName}" is expiring soon and has no refresh_token`,
        });
      }
      return;
    }

    // Not expiring soon — no action needed
  }

  /** Emit an event to all handlers, isolating errors. */
  private emit(event: AuthEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        log.warn({ err, eventType: event.type }, "Event handler threw — ignoring");
      }
    }
  }
}
