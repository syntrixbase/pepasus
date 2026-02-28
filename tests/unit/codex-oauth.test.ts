import { describe, it, expect, afterEach } from "bun:test";
import {
  loadCredentials,
  saveCredentials,
} from "../../src/infra/codex-oauth.ts";
import type { CodexCredentials } from "../../src/infra/codex-oauth.ts";
import { rm, mkdir } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-codex-oauth";

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

      saveCredentials(testDir, creds);
      const loaded = loadCredentials(testDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.accessToken).toBe("test-access-token");
      expect(loaded!.refreshToken).toBe("test-refresh-token");
      expect(loaded!.accountId).toBe("acct-123");
    });

    it("should return null for non-existent credentials", () => {
      const loaded = loadCredentials("/tmp/nonexistent-dir-xyz");
      expect(loaded).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      await mkdir(testDir, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${testDir}/codex-auth.json`, "not json");

      const loaded = loadCredentials(testDir);
      expect(loaded).toBeNull();
    });

    it("should return null for missing fields", async () => {
      await mkdir(testDir, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${testDir}/codex-auth.json`, JSON.stringify({ accessToken: "" }));

      const loaded = loadCredentials(testDir);
      expect(loaded).toBeNull();
    });
  });
});
