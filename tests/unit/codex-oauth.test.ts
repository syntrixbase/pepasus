/**
 * Unit tests for Codex OAuth — credential storage, token refresh,
 * device code login flow, and credential retrieval.
 *
 * Tests use a local Bun.serve mock server and mock global fetch
 * to avoid any real network calls.
 * All file I/O uses a temp directory — never touches ~/.pegasus/auth/.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import {
  loadCredentials,
  saveCredentials,
  refreshToken,
  getValidCredentials,
  loginDeviceCode,
  validateCredentials,
} from "../../src/infra/codex-oauth.ts";
import type { CodexCredentials } from "../../src/infra/codex-oauth.ts";
import { rm, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

// ── Tests ───────────────────────────────────────────

describe("Codex OAuth", () => {
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Credential Storage Tests ────────────────────────

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
        const newIdToken = fakeJWT({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-refreshed" },
        });

        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
            id_token: newIdToken,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 1000,
          accountId: "acct-old",
        };

        const newCreds = await refreshToken(creds, testFile);

        expect(newCreds.accessToken).toBe("new-access-token");
        expect(newCreds.refreshToken).toBe("new-refresh");
        expect(newCreds.accountId).toBe("acct-refreshed");
        expect(newCreds.expiresAt).toBeGreaterThan(Date.now());
      }), 10000);

    it("should keep old refreshToken when new one not provided", () =>
      withMockedFetch(async () => {
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access",
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

        const newCreds = await refreshToken(creds, testFile);
        expect(newCreds.refreshToken).toBe("keep-this-refresh");
      }), 10000);

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

        await expect(refreshToken(creds, testFile)).rejects.toThrow("Token refresh failed (400)");
      }), 10000);

    it("should extract accountId from id_token chatgpt_account_id", () =>
      withMockedFetch(async () => {
        const newIdToken = fakeJWT({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-id-token" },
        });
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
            id_token: newIdToken,
          }),
        );
        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "old-acct",
        };
        const newCreds = await refreshToken(creds, testFile);
        expect(newCreds.accountId).toBe("acct-from-id-token");
      }), 10000);

    it("should keep old accountId when no id_token provided", () =>
      withMockedFetch(async () => {
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access",
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

        const newCreds = await refreshToken(creds, testFile);
        expect(newCreds.accountId).toBe("keep-this-acct");
      }), 10000);

    it("should keep old accountId when id_token has no chatgpt_account_id", () =>
      withMockedFetch(async () => {
        const idTokenNoAcct = fakeJWT({ sub: "user-sub-only" });
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access",
            refresh_token: "new-ref",
            expires_in: 3600,
            id_token: idTokenNoAcct,
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "keep-this-acct",
        };

        const newCreds = await refreshToken(creds, testFile);
        expect(newCreds.accountId).toBe("keep-this-acct");
      }), 10000);

    it("should handle non-JWT id_token gracefully", () =>
      withMockedFetch(async () => {
        // A token that is NOT a valid JWT (no dots) — triggers extractAccountId catch branch
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access",
            refresh_token: "new-ref",
            expires_in: 3600,
            id_token: "not-a-jwt-token",
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "fallback-acct",
        };

        const newCreds = await refreshToken(creds, testFile);
        // Falls back to old accountId since id_token can't be parsed
        expect(newCreds.accountId).toBe("fallback-acct");
      }), 10000);

    it("should handle malformed JWT id_token payload gracefully", () =>
      withMockedFetch(async () => {
        // A token with 3 dots but invalid base64 payload — triggers extractAccountId catch
        mockServer.setHandler(() =>
          jsonResp({
            access_token: "new-access",
            refresh_token: "new-ref",
            expires_in: 3600,
            id_token: "header.!!!invalid-base64!!!.signature",
          }),
        );

        await mkdir(testDir, { recursive: true });
        const creds: CodexCredentials = {
          accessToken: "old",
          refreshToken: "ref",
          expiresAt: Date.now() - 1000,
          accountId: "keep-acct",
        };

        const newCreds = await refreshToken(creds, testFile);
        expect(newCreds.accountId).toBe("keep-acct");
      }), 10000);
  });

  // ── getValidCredentials Tests ─────────────────────

  describe("getValidCredentials", () => {
    it("should return null when no credentials file exists", async () => {
      const result = await getValidCredentials("/tmp/nonexistent-xyz.json");
      expect(result).toBeNull();
    }, 10000);

    it("should return valid credentials without refresh", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CodexCredentials = {
        accessToken: "valid-token",
        refreshToken: "valid-refresh",
        expiresAt: Date.now() + 3600000,
        accountId: "acct-valid",
      };
      saveCredentials(creds, testFile);
      const result = await getValidCredentials(testFile);
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("valid-token");
      expect(result!.accountId).toBe("acct-valid");
    }, 10000);

    it("should return null when expired credentials fail to refresh", async () => {
      await mkdir(testDir, { recursive: true });
      saveCredentials({
        accessToken: "expired",
        refreshToken: "bad",
        expiresAt: Date.now() - 1000,
        accountId: "acct",
      }, testFile);

      // Mock fetch so refresh fails
      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async () => new Response("fail", { status: 400 });
      try {
        const result = await getValidCredentials(testFile);
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, 10000);
  });

  // ── loginDeviceCode Tests ─────────────────────────

  describe("loginDeviceCode", () => {
    let mockServer: MockServer;

    beforeAll(() => {
      mockServer = createMockServer(18932);
    });

    afterAll(() => {
      mockServer.server.stop(true);
    });

    // Ensure testDir exists for saveCredentials in loginDeviceCode
    const ensureTestDir = async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(testDir, { recursive: true });
    };

    /**
     * Helper: mock global fetch to redirect all auth.openai.com calls
     * to the local mock server. Routes by URL path to simulate the
     * 3-step device code flow.
     */
    function withDeviceMockedFetch(
      handlers: {
        onDeviceCode?: () => Response;
        onDeviceToken?: () => Response;
        onTokenExchange?: () => Response;
      },
      fn: () => Promise<void>,
    ): Promise<void> {
      const originalFetch = globalThis.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("deviceauth/usercode") && handlers.onDeviceCode) {
          return handlers.onDeviceCode();
        }
        if (url.includes("deviceauth/token") && handlers.onDeviceToken) {
          return handlers.onDeviceToken();
        }
        if (url.includes("oauth/token") && handlers.onTokenExchange) {
          return handlers.onTokenExchange();
        }
        return originalFetch(input, init);
      };
      return ensureTestDir().then(() => fn()).finally(() => {
        globalThis.fetch = originalFetch;
      });
    }

    it("should complete the full device code flow", () => {
      // Step 2 (polling): first call returns 403 (pending), second returns success
      let pollCount = 0;

      const idToken = fakeJWT({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-device" },
      });

      return withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_auth_id: "dev-auth-123",
              user_code: "ABCD-1234",
              interval: 1, // 1 second polling interval
            }),
          onDeviceToken: () => {
            pollCount++;
            if (pollCount <= 1) {
              return new Response("pending", { status: 403 });
            }
            return jsonResp({
              authorization_code: "auth-code-xyz",
              code_verifier: "verifier-xyz",
              code_challenge: "challenge-xyz",
            });
          },
          onTokenExchange: () =>
            jsonResp({
              access_token: "device-access-token",
              refresh_token: "device-refresh-token",
              expires_in: 3600,
              id_token: idToken,
            }),
        },
        async () => {
          const creds = await loginDeviceCode(testFile);

          expect(creds.accessToken).toBe("device-access-token");
          expect(creds.refreshToken).toBe("device-refresh-token");
          expect(creds.accountId).toBe("acct-device");
          expect(creds.expiresAt).toBeGreaterThan(Date.now());
          // pollForToken should have been called at least twice
          expect(pollCount).toBeGreaterThanOrEqual(2);
        },
      );
    }, 15000);

    it("should throw when device code request fails", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () => new Response("server error", { status: 500 }),
        },
        async () => {
          await expect(loginDeviceCode(testFile)).rejects.toThrow(
            "Device code request failed (500)",
          );
        },
      ), 10000);

    it("should throw when token exchange fails", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_auth_id: "dev-auth-fail",
              user_code: "FAIL-0000",
              interval: 1,
            }),
          onDeviceToken: () =>
            jsonResp({
              authorization_code: "auth-code-fail",
              code_verifier: "verifier-fail",
              code_challenge: "challenge-fail",
            }),
          onTokenExchange: () =>
            new Response("invalid_grant", { status: 400 }),
        },
        async () => {
          await expect(loginDeviceCode(testFile)).rejects.toThrow(
            "Token exchange failed (400)",
          );
        },
      ), 10000);

    it("should handle empty accountId when id_token has no chatgpt_account_id", () => {
      const idTokenNoAcct = fakeJWT({ sub: "user-only" });

      return withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_auth_id: "dev-auth-noid",
              user_code: "NOID-0000",
              interval: 1,
            }),
          onDeviceToken: () =>
            jsonResp({
              authorization_code: "auth-code-noid",
              code_verifier: "verifier-noid",
              code_challenge: "challenge-noid",
            }),
          onTokenExchange: () =>
            jsonResp({
              access_token: "access-noid",
              refresh_token: "refresh-noid",
              expires_in: 3600,
              id_token: idTokenNoAcct,
            }),
        },
        async () => {
          const creds = await loginDeviceCode(testFile);
          // extractAccountId returns null for missing chatgpt_account_id → ""
          expect(creds.accountId).toBe("");
        },
      );
    }, 10000);

    it("should handle missing id_token in response", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_auth_id: "dev-auth-notok",
              user_code: "NOTK-0000",
              interval: 1,
            }),
          onDeviceToken: () =>
            jsonResp({
              authorization_code: "auth-code-notok",
              code_verifier: "verifier-notok",
              code_challenge: "challenge-notok",
            }),
          onTokenExchange: () =>
            jsonResp({
              access_token: "access-notok",
              refresh_token: "refresh-notok",
              expires_in: 3600,
              // no id_token
            }),
        },
        async () => {
          const creds = await loginDeviceCode(testFile);
          expect(creds.accountId).toBe("");
        },
      ), 10000);

    it("should handle string interval from device code response", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_auth_id: "dev-auth-strint",
              user_code: "STRI-0000",
              interval: "1", // string instead of number
            }),
          onDeviceToken: () =>
            jsonResp({
              authorization_code: "auth-code-strint",
              code_verifier: "verifier-strint",
              code_challenge: "challenge-strint",
            }),
          onTokenExchange: () =>
            jsonResp({
              access_token: "access-strint",
              refresh_token: "refresh-strint",
              expires_in: 3600,
            }),
        },
        async () => {
          const creds = await loginDeviceCode(testFile);
          expect(creds.accessToken).toBe("access-strint");
        },
      ), 10000);

    it("should throw on unexpected polling status", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_auth_id: "dev-auth-unex",
              user_code: "UNEX-0000",
              interval: 1,
            }),
          onDeviceToken: () =>
            new Response("unexpected error", { status: 500 }),
        },
        async () => {
          await expect(loginDeviceCode(testFile)).rejects.toThrow(
            "Device auth polling failed (500)",
          );
        },
      ), 10000);
  });

  // ── verifyToken Tests ─────────────────────────────

  describe("verifyToken", () => {
    let mockServer: MockServer;

    beforeAll(() => {
      mockServer = createMockServer(18933);
    });

    afterAll(() => {
      mockServer.server.stop(true);
    });

    function withMockedFetch(
      handler: (url: string) => Response | null,
      fn: () => Promise<void>,
    ): Promise<void> {
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const result = handler(url);
        if (result) return result;
        return originalFetch(input, init);
      };
      return fn().finally(() => {
        globalThis.fetch = originalFetch;
      });
    }

    it("should return true for valid token (200 response)", () =>
      withMockedFetch(
        (url) => {
          if (url.includes("wham/usage")) {
            return new Response(JSON.stringify({ plan_type: "plus" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return null;
        },
        async () => {
          const { verifyToken } = await import("../../src/infra/codex-oauth.ts");
          const result = await verifyToken("valid-access-token", "acct-123", mockServer.baseURL);
          expect(result).toBe(true);
        },
      ), 10000);

    it("should return false for invalid token (401 response)", () =>
      withMockedFetch(
        (url) => {
          if (url.includes("wham/usage")) {
            return new Response(
              JSON.stringify({ detail: "Could not parse your authentication token." }),
              { status: 401 },
            );
          }
          return null;
        },
        async () => {
          const { verifyToken } = await import("../../src/infra/codex-oauth.ts");
          const result = await verifyToken("bad-token", "acct-123", mockServer.baseURL);
          expect(result).toBe(false);
        },
      ), 10000);

    it("should return false for expired token (403 response)", () =>
      withMockedFetch(
        (url) => {
          if (url.includes("wham/usage")) {
            return new Response("Forbidden", { status: 403 });
          }
          return null;
        },
        async () => {
          const { verifyToken } = await import("../../src/infra/codex-oauth.ts");
          const result = await verifyToken("expired-token", "acct-123", mockServer.baseURL);
          expect(result).toBe(false);
        },
      ), 10000);

    it("should return false on network error", () =>
      withMockedFetch(
        (url) => {
          if (url.includes("wham/usage")) {
            throw new Error("Network error");
          }
          return null;
        },
        async () => {
          const { verifyToken } = await import("../../src/infra/codex-oauth.ts");
          const result = await verifyToken("any-token", "acct-123", "http://localhost:19999");
          expect(result).toBe(false);
        },
      ), 10000);
  });

  // ── validateCredentials Tests ─────────────────────

  describe("validateCredentials", () => {
    it("should return true for valid JWT with iss claim", () => {
      const token = fakeJWT({ iss: "https://auth.openai.com/" });
      const creds: CodexCredentials = {
        accessToken: token,
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(true);
    });

    it("should return true for valid JWT with auth claim instead of iss", () => {
      const token = fakeJWT({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
      });
      const creds: CodexCredentials = {
        accessToken: token,
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(true);
    });

    it("should return false for expired token", () => {
      const token = fakeJWT({ iss: "https://auth.openai.com/" });
      const creds: CodexCredentials = {
        accessToken: token,
        refreshToken: "ref",
        expiresAt: Date.now() - 1000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(false);
    });

    it("should return false for non-JWT token (no dots)", () => {
      const creds: CodexCredentials = {
        accessToken: "plain-token-no-dots",
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(false);
    });

    it("should return false for 2-part JWT (missing signature)", () => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ iss: "test" })).toString("base64url");
      const creds: CodexCredentials = {
        accessToken: `${header}.${body}`,
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(false);
    });

    it("should return false for invalid base64 payload", () => {
      const creds: CodexCredentials = {
        accessToken: "header.!!!invalid-base64!!!.signature",
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(false);
    });

    it("should return false when payload missing both iss and auth claim", () => {
      const token = fakeJWT({ sub: "user-only", name: "test" });
      const creds: CodexCredentials = {
        accessToken: token,
        refreshToken: "ref",
        expiresAt: Date.now() + 3600000,
        accountId: "acct",
      };
      expect(validateCredentials(creds)).toBe(false);
    });
  });
});
