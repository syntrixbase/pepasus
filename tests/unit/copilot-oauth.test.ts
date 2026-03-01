/**
 * Unit tests for Copilot OAuth — credential storage, token exchange,
 * base URL derivation, and credential retrieval with auto-refresh.
 *
 * Tests mock global fetch to avoid any real network calls.
 * All file I/O uses a temp directory — never touches ~/.pegasus/auth/.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  loadCredentials,
  saveCredentials,
  deriveCopilotBaseURL,
  exchangeCopilotToken,
  getValidCopilotCredentials,
  loginCopilot,
} from "../../src/infra/copilot-oauth.ts";
import type { CopilotCredentials } from "../../src/infra/copilot-oauth.ts";
import { rm, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const testDir = "/tmp/pegasus-test-copilot-oauth";
const testFile = join(testDir, "github-copilot.json");

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── Tests ───────────────────────────────────────────

describe("Copilot OAuth", () => {
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Credential Storage Tests ────────────────────────

  describe("credential storage", () => {
    it("should save and load credentials", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CopilotCredentials = {
        githubToken: "gho_test123",
        copilotToken: "tid=abc;exp=999;sku=free",
        copilotExpiresAt: Date.now() + 3600000,
        baseURL: "https://api.individual.githubcopilot.com",
      };

      saveCredentials(testFile, creds);
      const loaded = loadCredentials(testFile);

      expect(loaded).not.toBeNull();
      expect(loaded!.githubToken).toBe("gho_test123");
      expect(loaded!.copilotToken).toBe("tid=abc;exp=999;sku=free");
      expect(loaded!.baseURL).toBe("https://api.individual.githubcopilot.com");
    });

    it("should return null for non-existent credentials", () => {
      const loaded = loadCredentials("/tmp/nonexistent-copilot-file-xyz.json");
      expect(loaded).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      await mkdir(testDir, { recursive: true });
      writeFileSync(testFile, "not json");

      const loaded = loadCredentials(testFile);
      expect(loaded).toBeNull();
    });

    it("should return null for missing githubToken", async () => {
      await mkdir(testDir, { recursive: true });
      writeFileSync(testFile, JSON.stringify({
        githubToken: "",
        copilotToken: "tok",
        copilotExpiresAt: Date.now(),
        baseURL: "https://example.com",
      }));

      const loaded = loadCredentials(testFile);
      expect(loaded).toBeNull();
    });

    it("should return null for missing copilotToken", async () => {
      await mkdir(testDir, { recursive: true });
      writeFileSync(testFile, JSON.stringify({
        githubToken: "gho_test",
        copilotToken: "",
        copilotExpiresAt: Date.now(),
        baseURL: "https://example.com",
      }));

      const loaded = loadCredentials(testFile);
      expect(loaded).toBeNull();
    });

    it("should preserve all credential fields round-trip", async () => {
      await mkdir(testDir, { recursive: true });
      const expiresAt = Date.now() + 7200000;
      const creds: CopilotCredentials = {
        githubToken: "gho_abc",
        copilotToken: "tid=xyz;exp=123;proxy-ep=proxy.example.com",
        copilotExpiresAt: expiresAt,
        baseURL: "https://api.example.com",
      };

      saveCredentials(testFile, creds);
      const loaded = loadCredentials(testFile);

      expect(loaded).toEqual(creds);
    });
  });

  // ── deriveCopilotBaseURL Tests ────────────────────────

  describe("deriveCopilotBaseURL", () => {
    it("should extract proxy-ep and replace proxy. with api.", () => {
      const token = "tid=abc;exp=123;sku=free;proxy-ep=proxy.individual.githubcopilot.com";
      expect(deriveCopilotBaseURL(token)).toBe("https://api.individual.githubcopilot.com");
    });

    it("should handle proxy-ep without proxy. prefix", () => {
      const token = "tid=abc;proxy-ep=api.custom.githubcopilot.com";
      expect(deriveCopilotBaseURL(token)).toBe("https://api.custom.githubcopilot.com");
    });

    it("should return default URL when no proxy-ep found", () => {
      const token = "tid=abc;exp=123;sku=free";
      expect(deriveCopilotBaseURL(token)).toBe("https://api.individual.githubcopilot.com");
    });

    it("should handle empty token string", () => {
      expect(deriveCopilotBaseURL("")).toBe("https://api.individual.githubcopilot.com");
    });

    it("should handle proxy-ep with empty value", () => {
      const token = "tid=abc;proxy-ep=;sku=free";
      expect(deriveCopilotBaseURL(token)).toBe("https://api.individual.githubcopilot.com");
    });

    it("should handle proxy-ep as the first field", () => {
      const token = "proxy-ep=proxy.business.githubcopilot.com;tid=abc";
      expect(deriveCopilotBaseURL(token)).toBe("https://api.business.githubcopilot.com");
    });
  });

  // ── exchangeCopilotToken Tests ────────────────────────

  describe("exchangeCopilotToken", () => {
    function withMockedFetch(
      handler: (url: string, init?: RequestInit) => Response | null,
      fn: () => Promise<void>,
    ): Promise<void> {
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const result = handler(url, init);
        if (result) return result;
        return originalFetch(input, init);
      };
      return fn().finally(() => {
        globalThis.fetch = originalFetch;
      });
    }

    it("should exchange github token for copilot token", () =>
      withMockedFetch(
        (url, init) => {
          if (url.includes("copilot_internal/v2/token")) {
            // Verify Authorization header
            const headers = init?.headers as Record<string, string>;
            expect(headers?.["Authorization"] ?? "").toBe("token gho_test_github_token");
            return jsonResp({
              token: "tid=abc;exp=999;proxy-ep=proxy.individual.githubcopilot.com",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            });
          }
          return null;
        },
        async () => {
          const result = await exchangeCopilotToken("gho_test_github_token");
          expect(result.copilotToken).toBe(
            "tid=abc;exp=999;proxy-ep=proxy.individual.githubcopilot.com",
          );
          expect(result.baseURL).toBe("https://api.individual.githubcopilot.com");
          expect(result.expiresAt).toBeGreaterThan(Date.now());
        },
      ), 10000);

    it("should throw on exchange failure", () =>
      withMockedFetch(
        (url) => {
          if (url.includes("copilot_internal/v2/token")) {
            return new Response("Unauthorized", { status: 401 });
          }
          return null;
        },
        async () => {
          await expect(exchangeCopilotToken("bad_token")).rejects.toThrow(
            "Copilot token exchange failed (401)",
          );
        },
      ), 10000);

    it("should use default base URL when token has no proxy-ep", () =>
      withMockedFetch(
        (url) => {
          if (url.includes("copilot_internal/v2/token")) {
            return jsonResp({
              token: "tid=abc;exp=999",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            });
          }
          return null;
        },
        async () => {
          const result = await exchangeCopilotToken("gho_test");
          expect(result.baseURL).toBe("https://api.individual.githubcopilot.com");
        },
      ), 10000);
  });

  // ── getValidCopilotCredentials Tests ─────────────────

  describe("getValidCopilotCredentials", () => {
    it("should return null when no credentials file exists", async () => {
      const result = await getValidCopilotCredentials("/tmp/nonexistent-xyz.json");
      expect(result).toBeNull();
    }, 10000);

    it("should return valid credentials without refresh", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CopilotCredentials = {
        githubToken: "gho_valid",
        copilotToken: "tid=valid;exp=999",
        copilotExpiresAt: Date.now() + 3600000, // 1 hour from now
        baseURL: "https://api.individual.githubcopilot.com",
      };
      saveCredentials(testFile, creds);

      const result = await getValidCopilotCredentials(testFile);
      expect(result).not.toBeNull();
      expect(result!.copilotToken).toBe("tid=valid;exp=999");
    }, 10000);

    it("should refresh expired copilot token using github token", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CopilotCredentials = {
        githubToken: "gho_refresh_me",
        copilotToken: "tid=expired;exp=0",
        copilotExpiresAt: Date.now() - 1000, // expired
        baseURL: "https://api.individual.githubcopilot.com",
      };
      saveCredentials(testFile, creds);

      // Mock fetch for token exchange
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("copilot_internal/v2/token")) {
          return jsonResp({
            token: "tid=fresh;exp=999;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          });
        }
        return originalFetch(input, init);
      };

      try {
        const result = await getValidCopilotCredentials(testFile);
        expect(result).not.toBeNull();
        expect(result!.copilotToken).toBe(
          "tid=fresh;exp=999;proxy-ep=proxy.individual.githubcopilot.com",
        );
        expect(result!.githubToken).toBe("gho_refresh_me"); // preserved
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should refresh token within 5min buffer of expiry", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CopilotCredentials = {
        githubToken: "gho_buffer",
        copilotToken: "tid=about_to_expire;exp=0",
        copilotExpiresAt: Date.now() + 2 * 60 * 1000, // 2 min from now (within 5min buffer)
        baseURL: "https://api.individual.githubcopilot.com",
      };
      saveCredentials(testFile, creds);

      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("copilot_internal/v2/token")) {
          return jsonResp({
            token: "tid=refreshed;exp=999",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          });
        }
        return originalFetch(input);
      };

      try {
        const result = await getValidCopilotCredentials(testFile);
        expect(result).not.toBeNull();
        expect(result!.copilotToken).toBe("tid=refreshed;exp=999");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, 10000);

    it("should return null when refresh fails", async () => {
      await mkdir(testDir, { recursive: true });
      const creds: CopilotCredentials = {
        githubToken: "gho_bad_refresh",
        copilotToken: "tid=expired;exp=0",
        copilotExpiresAt: Date.now() - 1000,
        baseURL: "https://api.individual.githubcopilot.com",
      };
      saveCredentials(testFile, creds);

      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async () =>
        new Response("Server Error", { status: 500 });

      try {
        const result = await getValidCopilotCredentials(testFile);
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, 10000);
  });

  // ── loginCopilot Tests ─────────────────────────

  describe("loginCopilot", () => {
    function withDeviceMockedFetch(
      handlers: {
        onDeviceCode?: () => Response;
        onAccessToken?: () => Response;
        onCopilotToken?: () => Response;
      },
      fn: () => Promise<void>,
    ): Promise<void> {
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("login/device/code") && handlers.onDeviceCode) {
          return handlers.onDeviceCode();
        }
        if (url.includes("login/oauth/access_token") && handlers.onAccessToken) {
          return handlers.onAccessToken();
        }
        if (url.includes("copilot_internal/v2/token") && handlers.onCopilotToken) {
          return handlers.onCopilotToken();
        }
        return originalFetch(input, init);
      };
      return mkdir(testDir, { recursive: true })
        .then(() => fn())
        .finally(() => {
          globalThis.fetch = originalFetch;
        });
    }

    it("should complete the full device code + copilot token flow", () => {
      let pollCount = 0;

      return withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_code: "dev-code-123",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 900,
            }),
          onAccessToken: () => {
            pollCount++;
            if (pollCount <= 1) {
              return jsonResp({ error: "authorization_pending" });
            }
            return jsonResp({ access_token: "gho_device_token" });
          },
          onCopilotToken: () =>
            jsonResp({
              token: "tid=copilot;exp=999;proxy-ep=proxy.individual.githubcopilot.com",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            }),
        },
        async () => {
          const creds = await loginCopilot(testFile);

          expect(creds.githubToken).toBe("gho_device_token");
          expect(creds.copilotToken).toBe(
            "tid=copilot;exp=999;proxy-ep=proxy.individual.githubcopilot.com",
          );
          expect(creds.baseURL).toBe("https://api.individual.githubcopilot.com");
          expect(creds.copilotExpiresAt).toBeGreaterThan(Date.now());
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
          await expect(loginCopilot(testFile)).rejects.toThrow(
            "Device code request failed (500)",
          );
        },
      ), 10000);

    it("should throw when copilot token exchange fails after login", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_code: "dev-code-fail",
              user_code: "FAIL-0000",
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 900,
            }),
          onAccessToken: () =>
            jsonResp({ access_token: "gho_got_token" }),
          onCopilotToken: () =>
            new Response("Forbidden", { status: 403 }),
        },
        async () => {
          await expect(loginCopilot(testFile)).rejects.toThrow(
            "Copilot token exchange failed (403)",
          );
        },
      ), 10000);

    it("should handle slow_down response during polling", () => {
      let pollCount = 0;

      return withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_code: "dev-code-slow",
              user_code: "SLOW-0000",
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 900,
            }),
          onAccessToken: () => {
            pollCount++;
            if (pollCount === 1) {
              return jsonResp({ error: "slow_down", interval: 2 });
            }
            return jsonResp({ access_token: "gho_slow_token" });
          },
          onCopilotToken: () =>
            jsonResp({
              token: "tid=slow;exp=999",
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            }),
        },
        async () => {
          const creds = await loginCopilot(testFile);
          expect(creds.githubToken).toBe("gho_slow_token");
          expect(pollCount).toBeGreaterThanOrEqual(2);
        },
      );
    }, 15000);

    it("should throw on expired_token error", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_code: "dev-code-exp",
              user_code: "EXPD-0000",
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 900,
            }),
          onAccessToken: () =>
            jsonResp({ error: "expired_token" }),
        },
        async () => {
          await expect(loginCopilot(testFile)).rejects.toThrow(
            "Device code expired",
          );
        },
      ), 10000);

    it("should throw on access_denied error", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_code: "dev-code-denied",
              user_code: "DENY-0000",
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 900,
            }),
          onAccessToken: () =>
            jsonResp({ error: "access_denied" }),
        },
        async () => {
          await expect(loginCopilot(testFile)).rejects.toThrow(
            "User denied access",
          );
        },
      ), 10000);

    it("should throw on non-200 polling response", () =>
      withDeviceMockedFetch(
        {
          onDeviceCode: () =>
            jsonResp({
              device_code: "dev-code-err",
              user_code: "ERR-0000",
              verification_uri: "https://github.com/login/device",
              interval: 1,
              expires_in: 900,
            }),
          onAccessToken: () =>
            new Response("Internal Server Error", { status: 500 }),
        },
        async () => {
          await expect(loginCopilot(testFile)).rejects.toThrow(
            "GitHub token polling failed (500)",
          );
        },
      ), 10000);
  });
});
