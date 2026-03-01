/**
 * Auth directory — unified location for all OAuth/token credentials.
 *
 * The base directory is config-driven (system.authDir in config.yml).
 * All auth tokens are stored under that directory:
 *   <authDir>/codex.json          — Codex OAuth credentials
 *   <authDir>/mcp/<server>.json   — MCP server OAuth tokens
 *
 * This keeps credentials in the user's home directory (not project data dir),
 * making them shareable across projects and safe from git tracking.
 */
import * as fs from "fs";
import * as path from "path";

/** Get the auth directory. Creates it if needed. baseDir MUST be provided. */
export function getAuthDir(baseDir: string): string {
  if (!baseDir) throw new Error("authDir is required");
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(baseDir, 0o700);
  } catch {
    // ignore — may fail on some platforms
  }
  return baseDir;
}

/** Get a subdirectory under the auth directory. Creates it if needed. */
export function getAuthSubdir(baseDir: string, subdir: string): string {
  const dir = path.join(getAuthDir(baseDir), subdir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  return dir;
}
