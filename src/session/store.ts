/**
 * SessionStore — persists Main Agent conversation history as JSONL.
 *
 * Supports append, load, compact (archive + summarize), and listing archives.
 */

import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import type { Message } from "../infra/llm-types.ts";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("session_store");

export interface SessionEntry {
  ts: number;
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: unknown[];
  metadata?: Record<string, unknown>;
}

export class SessionStore {
  private dir: string;
  private currentPath: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "main");
    this.currentPath = path.join(this.dir, "current.jsonl");
  }

  /** Append a message to current session. */
  async append(
    message: Message,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: SessionEntry = {
      ts: Date.now(),
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      metadata,
    };
    await appendFile(this.currentPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  /** Load all messages from current session. */
  async load(): Promise<Message[]> {
    try {
      const content = await readFile(this.currentPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.map((line) => {
        const entry = JSON.parse(line) as SessionEntry;
        const msg: Message = {
          role: entry.role as Message["role"],
          content: entry.content,
        };
        if (entry.toolCallId) msg.toolCallId = entry.toolCallId;
        if (entry.toolCalls)
          msg.toolCalls = entry.toolCalls as Message["toolCalls"];
        return msg;
      });
    } catch {
      return []; // No session yet
    }
  }

  /** Compact current session: rename to timestamped file, create new current with summary. */
  async compact(summary: string, previousRef?: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "")
      .slice(0, 15);
    const archiveName = `${timestamp}.jsonl`;
    const archivePath = path.join(this.dir, archiveName);

    // Rename current -> archive
    try {
      await rename(this.currentPath, archivePath);
    } catch {
      // current.jsonl doesn't exist, nothing to archive
    }

    // Create new current with compact summary + reference
    const compactEntry: SessionEntry = {
      ts: Date.now(),
      role: "system",
      content: summary,
      metadata: {
        type: "compact",
        previousSession: previousRef ?? archiveName,
      },
    };
    await writeFile(
      this.currentPath,
      JSON.stringify(compactEntry) + "\n",
      "utf-8",
    );

    logger.info({ archiveName }, "session_compacted");
    return archiveName;
  }

  /** List archived session files. */
  async listArchives(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".jsonl") && f !== "current.jsonl")
        .sort();
    } catch {
      return [];
    }
  }
}
