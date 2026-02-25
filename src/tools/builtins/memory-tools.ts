/**
 * Memory tools — long-term memory as markdown files.
 *
 * Storage layout:
 *   data/memory/
 *   ├── facts/       (key-value fact files)
 *   └── episodes/    (monthly experience summaries)
 *
 * Each file has a `> Summary: ...` line used as the index entry.
 */

import { z } from "zod";
import path from "node:path";
import { readdir, access, mkdir } from "node:fs/promises";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

/** Extract `> Summary: ...` from file content. */
export function extractSummary(content: string): string {
  const match = content.match(/^>\s*Summary:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

/** Resolve and validate a memory path. Prevents directory traversal. */
export function resolveMemoryPath(
  relativePath: string,
  memoryDir: string,
): string {
  const resolved = path.resolve(memoryDir, relativePath);
  const memoryRoot = path.resolve(memoryDir);
  if (!resolved.startsWith(memoryRoot + "/") && resolved !== memoryRoot) {
    throw new Error(`Path "${relativePath}" escapes memory directory`);
  }
  return resolved;
}

/** Get the memory directory from context. Crashes if dataDir is missing — a configuration bug. */
function getMemoryDir(context: ToolContext): string {
  if (!context.dataDir) {
    throw new Error("ToolContext.dataDir is required but missing — this is a configuration bug");
  }
  return context.dataDir;
}

// ── memory_list ─────────────────────────────────

export const memory_list: Tool = {
  name: "memory_list",
  description: "List available memory files with their summaries",
  category: "memory" as ToolCategory,
  parameters: z.object({}),
  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const memoryDir = getMemoryDir(context);

    try {
      // Check if memory directory exists
      try {
        await access(memoryDir);
      } catch {
        return {
          success: true,
          result: [],
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const entries: Array<{ path: string; summary: string; size: number }> = [];

      // Scan subdirectories (facts/, episodes/, etc.)
      const subdirs = await readdir(memoryDir, { withFileTypes: true });
      for (const subdir of subdirs) {
        if (!subdir.isDirectory()) continue;

        const subdirPath = path.join(memoryDir, subdir.name);
        const files = await readdir(subdirPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".md")) continue;

          const filePath = path.join(subdirPath, file.name);
          const content = await Bun.file(filePath).text();
          const stat = Bun.file(filePath).size;

          entries.push({
            path: `${subdir.name}/${file.name}`,
            summary: extractSummary(content),
            size: stat,
          });
        }
      }

      return {
        success: true,
        result: entries,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── memory_read ─────────────────────────────────

export const memory_read: Tool = {
  name: "memory_read",
  description: "Read a memory file",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path within memory directory, e.g. 'facts/user.md'"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath } = params as { path: string };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);
      const content = await Bun.file(filePath).text();

      return {
        success: true,
        result: content,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── memory_write ─────────────────────────────────

export const memory_write: Tool = {
  name: "memory_write",
  description: "Write or overwrite a memory file",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path, e.g. 'facts/user.md'"),
    content: z.string().describe("Full file content (markdown)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath, content } = params as { path: string; content: string };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await mkdir(parentDir, { recursive: true });

      await Bun.write(filePath, content);

      return {
        success: true,
        result: { path: relativePath, size: content.length },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── memory_append ─────────────────────────────────

export const memory_append: Tool = {
  name: "memory_append",
  description: "Append an entry to a memory file (typically episodes)",
  category: "memory" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Relative path, e.g. 'episodes/2026-02.md'"),
    entry: z.string().describe("Markdown block to append"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: relativePath, entry } = params as { path: string; entry: string };
    const memoryDir = getMemoryDir(context);

    try {
      const filePath = resolveMemoryPath(relativePath, memoryDir);

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await mkdir(parentDir, { recursive: true });

      // Read existing content or start empty
      let existing = "";
      try {
        existing = await Bun.file(filePath).text();
      } catch {
        // File doesn't exist, will be created
      }

      const newContent = existing + entry;
      await Bun.write(filePath, newContent);

      return {
        success: true,
        result: { path: relativePath, size: newContent.length },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
