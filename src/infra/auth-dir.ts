/**
 * Auth directory — unified location for all OAuth/token credentials.
 *
 * All auth tokens are stored under ~/.pegasus/auth/:
 *   ~/.pegasus/auth/codex.json          — Codex OAuth credentials
 *   ~/.pegasus/auth/mcp/<server>.json   — MCP server OAuth tokens
 *
 * This keeps credentials in the user's home directory (not project data dir),
 * making them shareable across projects and safe from git tracking.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PEGASUS_AUTH_DIR = path.join(os.homedir(), ".pegasus", "auth");

/** Get the root auth directory (~/.pegasus/auth/). Creates it if needed. */
export function getAuthDir(): string {
  fs.mkdirSync(PEGASUS_AUTH_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(PEGASUS_AUTH_DIR, 0o700);
  } catch {
    // ignore — may fail on some platforms
  }
  return PEGASUS_AUTH_DIR;
}

/** Get a subdirectory under the auth directory. Creates it if needed. */
export function getAuthSubdir(subdir: string): string {
  const dir = path.join(getAuthDir(), subdir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  return dir;
}
