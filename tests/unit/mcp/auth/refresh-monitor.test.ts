/**
 * Unit tests for TokenRefreshMonitor.
 *
 * Covers: auto-refresh when expiring soon, skip when not expiring, emit
 * auth:expiring_soon when no refresh_token, emit auth:expired, untrack,
 * and event handler error isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TokenStore } from "../../../../src/mcp/auth/token-store.ts";
import type {
  DeviceCodeAuthConfig,
  StoredToken,
} from "../../../../src/mcp/auth/types.ts";
import {
  TokenRefreshMonitor,
  type AuthEvent,
} from "../../../../src/mcp/auth/refresh-monitor.ts";

// ── Helpers ──

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rm-test-"));
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const DEFAULT_CONFIG: DeviceCodeAuthConfig = {
  type: "device_code",
  clientId: "test-client",
  deviceAuthorizationUrl: "https://auth.example.com/device/code",
  tokenUrl: "https://auth.example.com/token",
  pollIntervalSeconds: 5,
  timeoutSeconds: 300,
};

function makeToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: "test_access_token",
    tokenType: "Bearer",
    obtainedAt: Date.now() - 1000,
    authType: "device_code",
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Tests ──

describe("TokenRefreshMonitor", () => {
  let tmpDir: string;
  let tokenStore: TokenStore;
  let monitor: TokenRefreshMonitor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = makeTempDir();
    tokenStore = new TokenStore(tmpDir);
    originalFetch = globalThis.fetch;
    // Use a very large interval so the timer never fires during tests.
    // We call checkOnce() manually.
    monitor = new TokenRefreshMonitor(tokenStore, 999_999_999);
  });

  afterEach(() => {
    monitor.stop();
    globalThis.fetch = originalFetch;
    cleanDir(tmpDir);
  });

  // ── 1. Refresh when expiring within 5 minutes ──

  it("should refresh token when expiring within 5 minutes and has refresh_token", async () => {
    const expiringToken = makeToken({
      accessToken: "old_access",
      refreshToken: "my_refresh_token",
      expiresAt: Date.now() + 120_000, // 2 minutes from now — within threshold
    });
    tokenStore.save("server-a", expiringToken);
    monitor.track("server-a", DEFAULT_CONFIG);

    globalThis.fetch = (async () => {
      return jsonResponse({
        access_token: "refreshed_access",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "new_refresh_token",
      });
    }) as unknown as typeof globalThis.fetch;

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    // Verify token was updated in store
    const stored = tokenStore.load("server-a");
    expect(stored).not.toBeNull();
    expect(stored!.accessToken).toBe("refreshed_access");
    expect(stored!.refreshToken).toBe("new_refresh_token");

    // Verify event emitted
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("auth:refreshed");
    expect(events[0]!.server).toBe("server-a");
  }, { timeout: 10_000 });

  // ── 2. No refresh when not expiring soon ──

  it("should NOT call fetch when token is not expiring soon", async () => {
    const healthyToken = makeToken({
      expiresAt: Date.now() + 3600_000, // 1 hour — well outside threshold
      refreshToken: "some_refresh",
    });
    tokenStore.save("server-b", healthyToken);
    monitor.track("server-b", DEFAULT_CONFIG);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    expect(fetchCalled).toBe(false);
    expect(events).toHaveLength(0);
  }, { timeout: 10_000 });

  // ── 3. Emit auth:expiring_soon when no refresh_token ──

  it("should emit auth:expiring_soon when token is expiring but has no refresh_token", async () => {
    const expiringNoRefresh = makeToken({
      expiresAt: Date.now() + 120_000, // 2 minutes — within threshold
      // no refreshToken
    });
    tokenStore.save("server-c", expiringNoRefresh);
    monitor.track("server-c", DEFAULT_CONFIG);

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("auth:expiring_soon");
    expect(events[0]!.server).toBe("server-c");
  }, { timeout: 10_000 });

  // ── 4. Emit auth:expired when token already expired ──

  it("should emit auth:expired when token is already expired", async () => {
    const expiredToken = makeToken({
      expiresAt: Date.now() - 5000, // expired 5 seconds ago
      refreshToken: "stale_refresh",
    });
    tokenStore.save("server-d", expiredToken);
    monitor.track("server-d", DEFAULT_CONFIG);

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("auth:expired");
    expect(events[0]!.server).toBe("server-d");
  }, { timeout: 10_000 });

  // ── 5. untrack removes server from monitoring ──

  it("should not check untracked servers", async () => {
    const expiringToken = makeToken({
      expiresAt: Date.now() + 120_000,
      refreshToken: "some_refresh",
    });
    tokenStore.save("server-e", expiringToken);
    monitor.track("server-e", DEFAULT_CONFIG);
    monitor.untrack("server-e");

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    expect(fetchCalled).toBe(false);
    expect(events).toHaveLength(0);
  }, { timeout: 10_000 });

  // ── 6. Event handler errors don't crash monitor ──

  it("should isolate event handler errors and continue operating", async () => {
    const expiringToken = makeToken({
      expiresAt: Date.now() + 120_000,
      refreshToken: "refresh_val",
    });
    tokenStore.save("server-f", expiringToken);
    monitor.track("server-f", DEFAULT_CONFIG);

    globalThis.fetch = (async () => {
      return jsonResponse({
        access_token: "new_token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as unknown as typeof globalThis.fetch;

    // First handler throws
    monitor.onEvent(() => {
      throw new Error("Handler exploded");
    });

    // Second handler should still receive the event
    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    // Should not throw
    await monitor.checkOnce();

    // Second handler still received the event
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("auth:refreshed");
  }, { timeout: 10_000 });

  // ── 7. Emit auth:refresh_failed when refresh request fails ──

  it("should emit auth:refresh_failed when refresh request fails", async () => {
    const expiringToken = makeToken({
      expiresAt: Date.now() + 120_000,
      refreshToken: "bad_refresh",
    });
    tokenStore.save("server-g", expiringToken);
    monitor.track("server-g", DEFAULT_CONFIG);

    globalThis.fetch = (async () => {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }) as unknown as typeof globalThis.fetch;

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("auth:refresh_failed");
    expect(events[0]!.server).toBe("server-g");
  }, { timeout: 10_000 });

  // ── 8. Skip tokens with no expiresAt ──

  it("should skip tokens that have no expiresAt", async () => {
    const noExpiryToken = makeToken({
      expiresAt: undefined,
    });
    tokenStore.save("server-h", noExpiryToken);
    monitor.track("server-h", DEFAULT_CONFIG);

    const events: AuthEvent[] = [];
    monitor.onEvent((e) => events.push(e));

    await monitor.checkOnce();

    expect(events).toHaveLength(0);
  }, { timeout: 10_000 });
});
