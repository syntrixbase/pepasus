/**
 * TokenStore — filesystem-backed storage for MCP OAuth tokens.
 *
 * Each MCP server gets a separate JSON file under `~/.pegasus/auth/mcp/`.
 * Files are stored with restrictive permissions (0600) since they contain
 * bearer tokens and refresh tokens.
 *
 * Server names are sanitized to filesystem-safe characters before use as
 * filenames. Use `checkNameCollisions` at config load time to detect names
 * that would collide after sanitization.
 */

import * as fs from "fs";
import * as path from "path";
import { StoredTokenSchema, type StoredToken } from "./types.ts";
import { getLogger } from "../../infra/logger.ts";
import { getAuthSubdir } from "../../infra/auth-dir.ts";

const log = getLogger("mcp.auth.token-store");

const EXPIRY_BUFFER_MS = 60_000; // 60 seconds

export class TokenStore {
  private readonly dir: string;

  /**
   * Creates token store.
   * Default: `~/.pegasus/auth/mcp/`.
   * Pass `dirOverride` for testing.
   */
  constructor(dirOverride?: string) {
    if (dirOverride) {
      this.dir = dirOverride;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(this.dir, 0o700); } catch { /* ignore */ }
    } else {
      this.dir = getAuthSubdir("mcp");
    }
  }

  // ── Persistence ──

  /**
   * Load a stored token for the given server.
   * Returns `null` if the file does not exist or contains invalid data.
   */
  load(serverName: string): StoredToken | null {
    const filePath = this.filePath(serverName);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    try {
      const json = JSON.parse(raw);
      return StoredTokenSchema.parse(json);
    } catch (err) {
      log.warn({ serverName, err }, "Failed to parse stored token — ignoring");
      return null;
    }
  }

  /**
   * Save a token for the given server.
   * Overwrites any existing token file.
   */
  save(serverName: string, token: StoredToken): void {
    const filePath = this.filePath(serverName);
    fs.writeFileSync(filePath, JSON.stringify(token, null, 2), { mode: 0o600 });
    log.debug({ serverName }, "Token saved");
  }

  /**
   * Delete the stored token for the given server.
   * No-op if the file does not exist.
   */
  delete(serverName: string): void {
    const filePath = this.filePath(serverName);
    try {
      fs.unlinkSync(filePath);
      log.debug({ serverName }, "Token deleted");
    } catch {
      // file didn't exist — that's fine
    }
  }

  // ── Static Utilities ──

  /**
   * Check whether a stored token is still valid (not expired).
   *
   * Returns `false` if `expiresAt` is within 60 seconds of now (safety buffer).
   * Returns `true` if `expiresAt` is unset (e.g. non-expiring tokens).
   */
  static isValid(token: StoredToken): boolean {
    if (token.expiresAt == null) {
      return true;
    }
    return token.expiresAt - Date.now() > EXPIRY_BUFFER_MS;
  }

  /**
   * Sanitize a server name for use as a filename.
   * Replaces any character that is not alphanumeric, hyphen, or underscore
   * with an underscore.
   */
  static sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /**
   * Detect server names that would collide after sanitization.
   *
   * @returns Human-readable descriptions of each collision group.
   *   Empty array if no collisions.
   */
  static checkNameCollisions(serverNames: string[]): string[] {
    const groups = new Map<string, string[]>();

    for (const name of serverNames) {
      const sanitized = TokenStore.sanitizeName(name);
      const existing = groups.get(sanitized);
      if (existing) {
        existing.push(name);
      } else {
        groups.set(sanitized, [name]);
      }
    }

    const collisions: string[] = [];
    for (const [sanitized, names] of groups) {
      if (names.length > 1) {
        collisions.push(
          `Names [${names.map((n) => `"${n}"`).join(", ")}] all map to "${sanitized}"`,
        );
      }
    }

    return collisions;
  }

  // ── Private ──

  private filePath(serverName: string): string {
    return path.join(this.dir, `${TokenStore.sanitizeName(serverName)}.json`);
  }
}
