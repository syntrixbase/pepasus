/**
 * Unit tests for Codex OAuth — credential storage, token refresh, PKCE helpers,
 * and the full OAuth login flow.
 *
 * Tests that interact with external services (OAuth flow, token endpoint)
 * use a local Bun.serve mock server and mock global fetch.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import {
  loadCredentials,
  saveCredentials,
  refreshToken,
  getValidCredentials,
  loginCodexOAuth,
} from "../../src/infra/codex-oauth.ts";
import type { CodexCredentials } from "../../src/infra/codex-oauth.ts";
import { rm, mkdir, rename } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

const testDir = "/tmp/pegasus-test-codex-oauth";
const testFile = join(testDir, "codex.json");

// ── Mock Server ─────────────────────────────────────

type RequestHandler = (req: Request) => Response | Promise<Response>;

interface MockServer {
  server: ReturnType<typeof Bun.serve>;
  baseURL: string;
  setHandler: (handler: RequestHandler) => void;
  lastRequestBody: () => string | undefined;
}

function createMockServer(port: number): MockServer {
  let handler: RequestHandler = () => new Response("not configured", { status: 500 });
  let _lastBody: string | undefined;

  const server = Bun.serve({
    port,
    async fetch(req) {
      try {
        const clone = req.clone();
        _lastBody = await clone.text();
      } catch {
        _lastBody = undefined;
      }
      return handler(req);
    },
  });

  return {
    server,
    baseURL: `http://localhost:${port}`,
    setHandler(h: RequestHandler) {
      handler = h;
      _lastBody = undefined;
    },
    lastRequestBody() {
      return _lastBody;
    },
  };
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── Helper: create a fake JWT with payload ──────────

function fakeJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

// ── Credential Storage Tests ────────────────────────

describe("Codex OAuth", () => {
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("credential storage", () => {
    it("should save and load credentials", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CodexCredentials = {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 3600000,
        accountId: "acct-123",
      };

      saveCredentials(creds, testFile);
      const loaded = loadCredentials(testFile);

      expect(loaded).not.toBeNull();
      expect(loaded!.accessToken).toBe("test-access-token");
      expect(loaded!.refreshToken).toBe("test-refresh-token");
      expect(loaded!.accountId).toBe("acct-123");
    });

    it("should return null for non-existent credentials", () => {
      const loaded = loadCredentials("/tmp/nonexistent-file-xyz.json");
      expect(loaded).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      await mkdir(testDir, { recursive: true });
      writeFileSync(testFile, "not json");

      const loaded = loadCredentials(testFile);
      expect(loaded).toBeNull();
    });

    it("should return null for missing fields", async () => {
      await mkdir(testDir, { recursive: true });
      writeFileSync(testFile, JSON.stringify({ accessToken: "" }));

      const loaded = loadCredentials(testFile);
      expect(loaded).toBeNull();
    });

    it("should return null for missing refreshToken", async () => {
      await mkdir(testDir, { recursive: true });
      writeFileSync(testFile, JSON.stringify({
        accessToken: "tok",
        refreshToken: "",
        expiresAt: Date.now(),
        accountId: "acct",
      }));

      const loaded = loadCredentials(testFile);
      expect(loaded).toBeNull();
    });

    it("should preserve all credential fields round-trip", async () => {
      await mkdir(testDir, { recursive: true });
      const expiresAt = Date.now() + 7200000;
      const creds: CodexCredentials = {
        accessToken: "access-xyz",
        refreshToken: "refresh-xyz",
        expiresAt,
        accountId: "acct-456",
      };

      saveCredentials(creds, testFile);
      const loaded = loadCredentials(testFile);

      expect(loaded).toEqual(creds);
    });
  });

  // ── refreshToken Tests ──────────────────────────────

  describe("refreshToken", () => {
    let mockServer: MockServer;

    beforeAll(() => {
      mockServer = createMockServer(18931);
    });

    afterAll(() => {
      mockServer.server.stop(true);
    });

    /** Helper: mock global fetch to redirect auth.openai.com calls to mock server */
    function withMockedFetch(fn: () => Promise<void>): Promise<void> {
      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("auth.openai.com/oauth/token")) {
          return originalFetch(`${mockServer.baseURL}/oauth/token`, init);
        }
        return originalFetch(input, init);
      };
      return fn().finally(() => {
        globalThis.fetch = originalFetch;
      });
    }

    it("should refresh token successfully", () =>
      withMockedFetch(async () => {
        const newAccessToken = fakeJWT({
          "https://api.openai.com/auth": { user_id: "user-refreshed" },
        });

        mockServer.setHandler(() =>
          jsonResp({
            access_token: newAccessToken,
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 1000,
          accountId: "acct-old",
        };

        const newCreds = await refreshToken(creds);

        expect(newCreds.accessToken).toBe(newAccessToken);
        expect(newCreds.refreshToken).toBe("new-refresh");
        expect(newCreds.accountId).toBe("user-refreshed");
        expect(newCreds.expiresAt).toBeGreaterThan(Date.now());
      }));

    it("should keep old refreshToken when new one not provided", () =>
      withMockedFetch(async () => {
        const newAccessToken = fakeJWT({ sub: "user-sub" });

        mockServer.setHandler(() =>
          jsonResp({
            access_token: newAccessToken,
            expires_in: 3600,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "keep-this-refresh",
          expiresAt: Date.now() - 1000,
          accountId: "acct",
        };

        const newCreds = await refreshToken(creds);
        expect(newCreds.refreshToken).toBe("keep-this-refresh");
      }));

    it("should throw on token refresh failure", () =>
      withMockedFetch(async () => {
        mockServer.setHandler(() =>
          new Response("invalid_grant", { status: 400 }),
        );

        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "bad-refresh",
          expiresAt: Date.now() - 1000,
          accountId: "acct",
        };

        await expect(refreshToken(creds)).rejects.toThrow("Token refresh failed (400)");
      }));

    it("should extract accountId from sub claim when auth claim not present", () =>
      withMockedFetch(async () => {
        const newAccessToken = fakeJWT({ sub: "user-from-sub" });

        mockServer.setHandler(() =>
          jsonResp({
            access_token: newAccessToken,
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "old-acct",
        };

        const newCreds = await refreshToken(creds);
        expect(newCreds.accountId).toBe("user-from-sub");
      }));

    it("should keep old accountId when token has no extractable ID", () =>
      withMockedFetch(async () => {
        const newAccessToken = fakeJWT({ iss: "test" });

        mockServer.setHandler(() =>
          jsonResp({
            access_token: newAccessToken,
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "keep-this-acct",
        };

        const newCreds = await refreshToken(creds);
        expect(newCreds.accountId).toBe("keep-this-acct");
      }));

    it("should handle non-JWT access token gracefully", () =>
      withMockedFetch(async () => {
        // A token that is NOT a valid JWT (no dots) — triggers extractAccountId catch branch
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "not-a-jwt-token",
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "fallback-acct",
        };

        const newCreds = await refreshToken(creds);
        // Falls back to old accountId since token can't be parsed
        expect(newCreds.accountId).toBe("fallback-acct");
      }));

    it("should handle malformed JWT payload gracefully", () =>
      withMockedFetch(async () => {
        // A token with 3 dots but invalid base64 payload — triggers extractAccountId catch
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "header.!!!invalid-base64!!!.signature",
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "keep-acct",
        };

        const newCreds = await refreshToken(creds);
        expect(newCreds.accountId).toBe("keep-acct");
      }));
  });

  // ── getValidCredentials Tests ─────────────────────

  describe("getValidCredentials", () => {
    const authDir = join(os.homedir(), ".pegasus", "auth");
    const credsFile = join(authDir, "codex.json");
    const backupFile = join(authDir, "codex.json.bak-test");

    afterEach(async () => {
      // Restore backup if it exists
      if (existsSync(backupFile)) {
        await rename(backupFile, credsFile);
      }
    });

    it("should return null when no credentials file exists", async () => {
      // Backup existing file if present
      if (existsSync(credsFile)) {
        await rename(credsFile, backupFile);
      }

      const result = await getValidCredentials();
      expect(result).toBeNull();
    });

    it("should return valid (non-expired) credentials without refresh", async () => {
      // Backup existing file if present
      if (existsSync(credsFile)) {
        await rename(credsFile, backupFile);
      }

      await mkdir(authDir, { recursive: true });
      const creds: CodexCredentials = {
        accessToken: "valid-token",
        refreshToken: "valid-refresh",
        expiresAt: Date.now() + 3600000, // 1 hour from now
        accountId: "acct-valid",
      };
      writeFileSync(credsFile, JSON.stringify(creds, null, 2), "utf-8");

      try {
        const result = await getValidCredentials();
        expect(result).not.toBeNull();
        expect(result!.accessToken).toBe("valid-token");
        expect(result!.accountId).toBe("acct-valid");
      } finally {
        // Cleanup
        await rm(credsFile, { force: true });
      }
    });

    it("should return null when expired credentials fail to refresh", async () => {
      // Backup existing file if present
      if (existsSync(credsFile)) {
        await rename(credsFile, backupFile);
      }

      await mkdir(authDir, { recursive: true });
      const creds: CodexCredentials = {
        accessToken: "expired-token",
        refreshToken: "bad-refresh",
        expiresAt: Date.now() - 1000, // already expired
        accountId: "acct-expired",
      };
      writeFileSync(credsFile, JSON.stringify(creds, null, 2), "utf-8");

      // Mock fetch so refresh fails
      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => {
        return new Response("invalid_grant", { status: 400 });
      };

      try {
        const result = await getValidCredentials();
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        await rm(credsFile, { force: true });
      }
    });
  });

  // ── loginCodexOAuth — full flow test ──────────────

  describe("loginCodexOAuth", () => {
    let mockServer: MockServer;

    beforeAll(() => {
      mockServer = createMockServer(18932);
    });

    afterAll(() => {
      mockServer.server.stop(true);
    });

    it("should complete the full OAuth PKCE flow", async () => {
      const newAccessToken = fakeJWT({
        "https://api.openai.com/auth": { user_id: "user-oauth" },
      });

      mockServer.setHandler(() =>
        jsonResp({
          access_token: newAccessToken,
          refresh_token: "oauth-refresh-token",
          expires_in: 3600,
        }),
      );

      // Mock child_process.exec to capture the authorize URL instead of opening a browser
      let capturedAuthorizeUrl = "";
      const childProcess = require("child_process");
      const originalExec = childProcess.exec;
      childProcess.exec = (cmd: string) => {
        // cmd is like: xdg-open "https://auth.openai.com/oauth/authorize?..."
        const match = cmd.match(/"([^"]+)"/);
        if (match) capturedAuthorizeUrl = match[1]!;
      };

      // Mock global fetch to redirect token exchange to mock server
      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("auth.openai.com/oauth/token")) {
          return originalFetch(`${mockServer.baseURL}/oauth/token`, init);
        }
        return originalFetch(input, init);
      };

      try {
        // Start the OAuth flow (non-blocking — it will wait for callback)
        const loginPromise = loginCodexOAuth();

        // Wait a bit for the server to start and exec to be called
        await new Promise((r) => setTimeout(r, 100));

        // Extract state from the captured authorize URL
        expect(capturedAuthorizeUrl).toContain("auth.openai.com/oauth/authorize");
        const authorizeParams = new URL(capturedAuthorizeUrl).searchParams;
        const state = authorizeParams.get("state");
        expect(state).toBeTruthy();

        // Simulate the OAuth callback hitting the local server
        const callbackUrl = `http://localhost:1455/auth/callback?code=test-auth-code&state=${state}`;
        const callbackResp = await originalFetch(callbackUrl);
        expect(callbackResp.status).toBe(200);
        const callbackHtml = await callbackResp.text();
        expect(callbackHtml).toContain("Authentication Successful");

        // Now the login should complete
        const creds = await loginPromise;

        expect(creds.accessToken).toBe(newAccessToken);
        expect(creds.refreshToken).toBe("oauth-refresh-token");
        expect(creds.accountId).toBe("user-oauth");
        expect(creds.expiresAt).toBeGreaterThan(Date.now());
      } finally {
        childProcess.exec = originalExec;
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should handle OAuth error in callback", async () => {
      const childProcess = require("child_process");
      const originalExec = childProcess.exec;
      childProcess.exec = () => {};

      const originalFetch = globalThis.fetch;

      try {
        // Catch the rejection immediately by attaching .catch()
        let caughtError: Error | undefined;
        const loginPromise = loginCodexOAuth().catch((e) => {
          caughtError = e;
        });

        await new Promise((r) => setTimeout(r, 100));

        // Simulate an error callback
        const callbackUrl = `http://localhost:1455/auth/callback?error=access_denied`;
        const callbackResp = await originalFetch(callbackUrl);
        expect(callbackResp.status).toBe(200);
        const callbackHtml = await callbackResp.text();
        expect(callbackHtml).toContain("Authentication Failed");

        await loginPromise;
        expect(caughtError).toBeDefined();
        expect(caughtError!.message).toContain("OAuth error: access_denied");
      } finally {
        childProcess.exec = originalExec;
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should return 404 for non-callback paths", async () => {
      const childProcess = require("child_process");
      const originalExec = childProcess.exec;
      let capturedUrl = "";
      childProcess.exec = (cmd: string) => {
        const match = cmd.match(/"([^"]+)"/);
        if (match) capturedUrl = match[1]!;
      };

      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("auth.openai.com/oauth/token")) {
          return new Response(JSON.stringify({
            access_token: fakeJWT({ sub: "u" }),
            refresh_token: "ref",
            expires_in: 3600,
          }), { headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      };

      try {
        const loginPromise = loginCodexOAuth();
        await new Promise((r) => setTimeout(r, 100));

        // Hit a wrong path — should get 404
        const wrongPath = await originalFetch("http://localhost:1455/wrong-path");
        expect(wrongPath.status).toBe(404);

        // Now send the correct callback to complete the flow
        const state = new URL(capturedUrl).searchParams.get("state");
        await originalFetch(`http://localhost:1455/auth/callback?code=c&state=${state}`);
        await loginPromise;
      } finally {
        childProcess.exec = originalExec;
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should return 400 for callback with state mismatch", async () => {
      const childProcess = require("child_process");
      const originalExec = childProcess.exec;
      let capturedUrl = "";
      childProcess.exec = (cmd: string) => {
        const match = cmd.match(/"([^"]+)"/);
        if (match) capturedUrl = match[1]!;
      };

      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("auth.openai.com/oauth/token")) {
          return new Response(JSON.stringify({
            access_token: fakeJWT({ sub: "u" }),
            refresh_token: "ref",
            expires_in: 3600,
          }), { headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      };

      try {
        const loginPromise = loginCodexOAuth();
        await new Promise((r) => setTimeout(r, 100));

        // Hit with wrong state — should get 400
        const badState = await originalFetch(
          "http://localhost:1455/auth/callback?code=c&state=wrong-state",
        );
        expect(badState.status).toBe(400);

        // Complete the flow correctly
        const state = new URL(capturedUrl).searchParams.get("state");
        await originalFetch(`http://localhost:1455/auth/callback?code=c&state=${state}`);
        await loginPromise;
      } finally {
        childProcess.exec = originalExec;
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should handle token exchange failure", async () => {
      const childProcess = require("child_process");
      const originalExec = childProcess.exec;
      let capturedUrl = "";
      childProcess.exec = (cmd: string) => {
        const match = cmd.match(/"([^"]+)"/);
        if (match) capturedUrl = match[1]!;
      };

      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("auth.openai.com/oauth/token")) {
          return new Response("invalid_grant", { status: 400 });
        }
        return originalFetch(input, init);
      };

      try {
        let caughtError: Error | undefined;
        const loginPromise = loginCodexOAuth().catch((e) => {
          caughtError = e;
        });
        await new Promise((r) => setTimeout(r, 100));

        const state = new URL(capturedUrl).searchParams.get("state");
        await originalFetch(`http://localhost:1455/auth/callback?code=bad-code&state=${state}`);

        await loginPromise;
        expect(caughtError).toBeDefined();
        expect(caughtError!.message).toContain("Token exchange failed (400)");
      } finally {
        childProcess.exec = originalExec;
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should extract empty accountId when JWT has no user info", async () => {
      // Token with no sub or auth claims → extractAccountId returns null → accountId is ""
      const tokenNoUser = fakeJWT({ iss: "openai", aud: "app" });

      const childProcess = require("child_process");
      const originalExec = childProcess.exec;
      let capturedUrl = "";
      childProcess.exec = (cmd: string) => {
        const match = cmd.match(/"([^"]+)"/);
        if (match) capturedUrl = match[1]!;
      };

      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("auth.openai.com/oauth/token")) {
          return new Response(JSON.stringify({
            access_token: tokenNoUser,
            refresh_token: "ref",
            expires_in: 3600,
          }), { headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      };

      try {
        const loginPromise = loginCodexOAuth();
        await new Promise((r) => setTimeout(r, 100));

        const state = new URL(capturedUrl).searchParams.get("state");
        await originalFetch(`http://localhost:1455/auth/callback?code=c&state=${state}`);

        const creds = await loginPromise;
        expect(creds.accountId).toBe("");
      } finally {
        childProcess.exec = originalExec;
        globalThis.fetch = originalFetch;
      }
    }, 10000);
  });
});
