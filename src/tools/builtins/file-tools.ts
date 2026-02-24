/**
 * File tools - read, write, list, delete, move files with path security.
 */

import { z } from "zod";
import { normalizePath, isPathAllowed } from "../types.ts";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";
import { ToolPermissionError } from "../errors.ts";
import path from "node:path";
import { rm, readdir, access } from "node:fs/promises";

// ── read_file ──────────────────────────────────

export const read_file: Tool = {
  name: "read_file",
  description: "Read content of a file",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to read"),
    encoding: z.string().optional().default("utf-8").describe("File encoding"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, encoding } = params as {
      path: string;
      encoding?: string;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("read_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Read file
      const filePath = normalizePath(originalPath, context.dataDir);
      const content = await Bun.file(filePath).text();

      // Get file stats
      const stat = await Bun.file(filePath).stat();

      return {
        success: true,
        result: {
          path: filePath,
          content,
          size: stat.size,
          encoding,
        },
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

// ── write_file ─────────────────────────────────

export const write_file: Tool = {
  name: "write_file",
  description: "Write content to a file",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to write"),
    content: z.string().describe("Content to write"),
    encoding: z.string().optional().default("utf-8").describe("File encoding"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, content, encoding } = params as {
      path: string;
      content: string;
      encoding?: string;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("write_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Write file
      const filePath = normalizePath(originalPath, context.dataDir);

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await Bun.$`mkdir -p ${parentDir}`.quiet();

      const writer = Bun.file(filePath).writer();
      await writer.write(content);
      await writer.end();

      // Get file stats
      const stat = await Bun.file(filePath).stat();

      return {
        success: true,
        result: {
          path: filePath,
          bytesWritten: stat.size,
          encoding,
        },
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

// ── list_files ────────────────────────────────

export const list_files: Tool = {
  name: "list_files",
  description: "List files and directories",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().default(".").describe("Directory path to list"),
    recursive: z.boolean().optional().default(false).describe("List recursively"),
    pattern: z.string().optional().describe("Filter by pattern (e.g., '*.ts')"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath = ".", recursive, pattern } = params as {
      path?: string;
      recursive?: boolean;
      pattern?: string;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      const dirPath = normalizePath(originalPath || ".", context.dataDir);

      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(dirPath, allowedPaths)) {
          throw new ToolPermissionError("list_files", `Path "${dirPath}" is not in allowed paths`);
        }
      }

      // List files - if directory doesn't exist, return empty list
      let files: Array<{ name: string; path: string; isDir: boolean; size: number }> = [];

      // Check if directory exists - use access instead of Bun.file().exists()
      // since Bun.file().exists() only works for files, not directories
      let dirExists = false;
      try {
        await access(dirPath);
        dirExists = true;
      } catch {
        dirExists = false;
      }

      if (!dirExists) {
        return {
          success: true,
          result: {
            path: dirPath,
            recursive: recursive || false,
            files: [],
            count: 0,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      if (recursive) {
        // Recursive listing
        const scanDir = async (currentPath: string, relativePath: string = ""): Promise<void> => {
          const entries = await readdir(currentPath, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);
            const stat = await Bun.file(entryPath).stat();

            if (stat.isDirectory()) {
              // Add directory and recurse
              files.push({
                name: entryRelativePath,
                path: entryPath,
                isDir: true,
                size: 0,
              });
              await scanDir(entryPath, entryRelativePath);
            } else if (stat.isFile()) {
              // Apply pattern filter
              if (pattern && !entry.name.match(new RegExp(pattern))) {
                continue;
              }
              files.push({
                name: entryRelativePath,
                path: entryPath,
                isDir: false,
                size: stat.size,
              });
            }
          }
        };

        await scanDir(dirPath);
      } else {
        // Non-recursive listing
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry.name);
          const stat = await Bun.file(entryPath).stat();

          // Skip directories in non-recursive mode
          if (stat.isDirectory()) {
            continue;
          }

          // Apply pattern filter
          if (pattern && !entry.name.match(new RegExp(pattern))) {
            continue;
          }

          files.push({
            name: entry.name,
            path: entryPath,
            isDir: false,
            size: stat.size,
          });
        }
      }

      return {
        success: true,
        result: {
          path: dirPath,
          recursive: recursive || false,
          files,
          count: files.length,
        },
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

// ── delete_file ───────────────────────────────

export const delete_file: Tool = {
  name: "delete_file",
  description: "Delete a file or directory",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Path to delete"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath } = params as { path: string };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("delete_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Delete file
      const filePath = normalizePath(originalPath, context.dataDir);
      await rm(filePath, { recursive: true, force: true });

      return {
        success: true,
        result: {
          path: filePath,
          deleted: true,
        },
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

// ── move_file ─────────────────────────────────

export const move_file: Tool = {
  name: "move_file",
  description: "Move or rename a file or directory",
  category: "file" as ToolCategory,
  parameters: z.object({
    from: z.string().describe("Source path"),
    to: z.string().describe("Destination path"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { from: fromPath, to: toPath } = params as {
      from: string;
      to: string;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(fromPath, allowedPaths)) {
          throw new ToolPermissionError("move_file", `Source path "${fromPath}" is not in allowed paths`);
        }
        if (!isPathAllowed(toPath, allowedPaths)) {
          throw new ToolPermissionError("move_file", `Destination path "${toPath}" is not in allowed paths`);
        }
      }

      // Move file
      const normalizedFrom = normalizePath(fromPath, context.dataDir);
      const normalizedTo = normalizePath(toPath, context.dataDir);

      await Bun.write(normalizedTo, await Bun.file(normalizedFrom).text());
      await rm(normalizedFrom, { recursive: true, force: true });

      return {
        success: true,
        result: {
          from: normalizedFrom,
          to: normalizedTo,
          moved: true,
        },
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

// ── get_file_info ─────────────────────────────

export const get_file_info: Tool = {
  name: "get_file_info",
  description: "Get information about a file or directory",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("Path to get info for"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath } = params as { path: string };

    try {
      // Check path permissions (read-only check for info)
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("get_file_info", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Get file stats
      const filePath = normalizePath(originalPath, context.dataDir);
      const stat = await Bun.file(filePath).stat();

      return {
        success: true,
        result: {
          path: filePath,
          exists: true,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          modified: stat.mtime?.getTime() || 0,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      // File doesn't exist or other error
      const exists = false;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        result: { exists },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
