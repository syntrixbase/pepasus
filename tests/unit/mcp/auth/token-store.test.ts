/**
 * Unit tests for TokenStore — filesystem-backed MCP auth token persistence.
 *
 * Covers: sanitizeName, save/load round-trip, file permissions, isValid
 * expiry logic, delete, overwrite, and checkNameCollisions.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TokenStore } from "../../../../src/mcp/auth/token-store.ts";
import type { StoredToken } from "../../../../src/mcp/auth/types.ts";

// ── Helpers ──

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-token-test-"));
}

function makeToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: "tok_abc123",
    tokenType: "Bearer",
    obtainedAt: Date.now(),
    authType: "client_credentials",
    ...overrides,
  };
}

// ── Tests ──

describe("TokenStore", () => {
  const tmpDirs: string[] = [];

  function createTmpDir(): string {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpDirs.length = 0;
  });

  // ── sanitizeName ──

  describe("sanitizeName", () => {
    it("should replace special characters with underscores", () => {
      expect(TokenStore.sanitizeName("my.server/name:1")).toBe("my_server_name_1");
    });

    it("should preserve valid characters (letters, digits, hyphens, underscores)", () => {
      expect(TokenStore.sanitizeName("my-server_01")).toBe("my-server_01");
    });

    it("should handle URL-like names", () => {
      expect(TokenStore.sanitizeName("https://api.example.com:8080/v1")).toBe(
        "https___api_example_com_8080_v1",
      );
    });

    it("should handle empty string", () => {
      expect(TokenStore.sanitizeName("")).toBe("");
    });
  });

  // ── save / load round-trip ──

  describe("save and load", () => {
    it("should round-trip a token through save and load", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);
      const token = makeToken();

      store.save("my-server", token);

      const loaded = store.load("my-server");
      expect(loaded).toEqual(token);
    });

    it("should persist across fresh instances", () => {
      const dir = createTmpDir();
      const token = makeToken();

      new TokenStore(dir).save("srv", token);
      const loaded = new TokenStore(dir).load("srv");

      expect(loaded).toEqual(token);
    });

    it("should return null for non-existent server", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      expect(store.load("no-such-server")).toBeNull();
    });

    it("should overwrite existing token", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      const tokenA = makeToken({ accessToken: "first" });
      const tokenB = makeToken({ accessToken: "second" });

      store.save("srv", tokenA);
      store.save("srv", tokenB);

      const loaded = store.load("srv");
      expect(loaded?.accessToken).toBe("second");
    });

    it("should persist all optional fields", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      const token = makeToken({
        refreshToken: "refresh_xyz",
        scope: "read write",
        expiresAt: Date.now() + 3600_000,
      });

      store.save("full", token);
      const loaded = store.load("full");
      expect(loaded).toEqual(token);
    });

    it("should return null for corrupted JSON", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      // Write garbage to the expected file location
      const filePath = path.join(dir, "corrupt.json");
      fs.writeFileSync(filePath, "not-valid-json{{{", { mode: 0o600 });

      expect(store.load("corrupt")).toBeNull();
    });

    it("should return null for JSON that doesn't match schema", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      const filePath = path.join(dir, "bad-schema.json");
      fs.writeFileSync(filePath, JSON.stringify({ foo: "bar" }), { mode: 0o600 });

      expect(store.load("bad-schema")).toBeNull();
    });
  });

  // ── file permissions ──

  describe("file permissions", () => {
    it("should create token files with 0600 permissions", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      store.save("perms-test", makeToken());

      const filePath = path.join(dir, "perms-test.json");
      const stats = fs.statSync(filePath);
      // 0o600 = owner read+write only
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("should create data directory with 0700 permissions", () => {
      const dir = createTmpDir();
      new TokenStore(dir);

      const stats = fs.statSync(dir);
      expect(stats.mode & 0o777).toBe(0o700);
    });
  });

  // ── isValid ──

  describe("isValid", () => {
    it("should return true when expiresAt is not set", () => {
      const token = makeToken({ expiresAt: undefined });
      expect(TokenStore.isValid(token)).toBe(true);
    });

    it("should return true when expiresAt is far in the future", () => {
      const token = makeToken({ expiresAt: Date.now() + 3600_000 });
      expect(TokenStore.isValid(token)).toBe(true);
    });

    it("should return false when expiresAt is in the past", () => {
      const token = makeToken({ expiresAt: Date.now() - 1000 });
      expect(TokenStore.isValid(token)).toBe(false);
    });

    it("should return false when expiresAt is within 60 seconds from now", () => {
      const token = makeToken({ expiresAt: Date.now() + 30_000 }); // 30s from now
      expect(TokenStore.isValid(token)).toBe(false);
    });

    it("should return false when expiresAt is exactly 60 seconds from now", () => {
      const token = makeToken({ expiresAt: Date.now() + 60_000 }); // exactly 60s
      expect(TokenStore.isValid(token)).toBe(false);
    });

    it("should return true when expiresAt is 61 seconds from now", () => {
      const token = makeToken({ expiresAt: Date.now() + 61_000 });
      expect(TokenStore.isValid(token)).toBe(true);
    });
  });

  // ── delete ──

  describe("delete", () => {
    it("should remove a saved token", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      store.save("del-me", makeToken());
      expect(store.load("del-me")).not.toBeNull();

      store.delete("del-me");
      expect(store.load("del-me")).toBeNull();
    });

    it("should be no-op for non-existent server", () => {
      const dir = createTmpDir();
      const store = new TokenStore(dir);

      // Should not throw
      expect(() => store.delete("ghost")).not.toThrow();
    });
  });

  // ── checkNameCollisions ──

  describe("checkNameCollisions", () => {
    it("should return empty array when no collisions", () => {
      const result = TokenStore.checkNameCollisions(["alpha", "beta", "gamma"]);
      expect(result).toEqual([]);
    });

    it("should detect a single collision pair", () => {
      const result = TokenStore.checkNameCollisions(["my.server", "my/server"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("my.server");
      expect(result[0]).toContain("my/server");
    });

    it("should detect multiple collision groups", () => {
      const result = TokenStore.checkNameCollisions([
        "a.b",
        "a/b",
        "x:y",
        "x!y",
      ]);
      expect(result).toHaveLength(2);
    });

    it("should return empty array for empty input", () => {
      expect(TokenStore.checkNameCollisions([])).toEqual([]);
    });

    it("should return empty array for single name", () => {
      expect(TokenStore.checkNameCollisions(["only-one"])).toEqual([]);
    });
  });
});
