/**
 * File tools - read, write, list, delete, move files with path security.
 */

import { z } from "zod";
import { normalizePath, isPathAllowed } from "../types.ts";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";
import { ToolPermissionError } from "../errors.ts";
import path from "node:path";
import { rm, readdir, access, stat as fsStat } from "node:fs/promises";

// ── read_file ──────────────────────────────────

export const read_file: Tool = {
  name: "read_file",
  description: "Read content of a file",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to read"),
    encoding: z.string().optional().default("utf-8").describe("File encoding"),
    offset: z.coerce.number().int().min(0).optional().describe("Start reading from this line number (0-based)"),
    limit: z.coerce.number().int().positive().optional().describe("Maximum number of lines to return"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, encoding, offset, limit } = params as {
      path: string;
      encoding?: string;
      offset?: number;
      limit?: number;
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
      const filePath = normalizePath(originalPath);
      let content = await Bun.file(filePath).text();

      // Get file stats
      const stat = await Bun.file(filePath).stat();

      // Apply offset/limit if provided
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split("\n");
        const totalLines = lines.length;
        const startLine = offset ?? 0;
        const endLine = limit !== undefined ? startLine + limit : totalLines;
        const sliced = lines.slice(startLine, endLine);
        const truncated = endLine < totalLines;
        content = sliced.join("\n");

        return {
          success: true,
          result: {
            path: filePath,
            content,
            size: stat.size,
            encoding,
            totalLines,
            offset: startLine,
            limit: limit ?? null,
            truncated,
          },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

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
      const filePath = normalizePath(originalPath);

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
      const dirPath = normalizePath(originalPath || ".");

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
      const filePath = normalizePath(originalPath);
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
      const normalizedFrom = normalizePath(fromPath);
      const normalizedTo = normalizePath(toPath);

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
      const filePath = normalizePath(originalPath);
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

// ── edit_file ──────────────────────────────────

export const edit_file: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match with new content. "
    + "The old_string must appear in the file and be unique (unless replace_all is true). "
    + "Include enough surrounding context in old_string to make it unique.",
  category: "file" as ToolCategory,
  parameters: z.object({
    path: z.string().describe("File path to edit"),
    old_string: z.string().min(1).describe("Exact string to find (include surrounding lines for uniqueness)"),
    new_string: z.string().describe("Replacement string"),
    replace_all: z.boolean().optional().default(false).describe("Replace all occurrences (for renaming)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { path: originalPath, old_string, new_string, replace_all } = params as {
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(originalPath, allowedPaths)) {
          throw new ToolPermissionError("edit_file", `Path "${originalPath}" is not in allowed paths`);
        }
      }

      // Read file
      const filePath = normalizePath(originalPath);
      const fileHandle = Bun.file(filePath);
      const exists = await fileHandle.exists();
      if (!exists) {
        throw new Error(`File not found: ${filePath}`);
      }
      const content = await fileHandle.text();

      // Count occurrences of old_string
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = content.indexOf(old_string, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + old_string.length;
      }

      if (count === 0) {
        throw new Error("old_string not found in file");
      }

      if (count > 1 && !replace_all) {
        throw new Error(`old_string found ${count} times, provide more context or set replace_all`);
      }

      // Perform replacement
      let newContent: string;
      let replacements: number;
      if (replace_all) {
        newContent = content.split(old_string).join(new_string);
        replacements = count;
      } else {
        newContent = content.replace(old_string, new_string);
        replacements = 1;
      }

      // Write back
      await Bun.write(filePath, newContent);

      return {
        success: true,
        result: {
          path: filePath,
          replacements,
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

// ── grep_files ─────────────────────────────────

/**
 * Convert a simple glob pattern to a regex for filename matching.
 * Supports: *.ts, *.{ts,js}, etc.
 */
function globToRegex(glob: string): RegExp {
  // Handle {a,b} alternation
  let pattern = glob.replace(/\{([^}]+)\}/g, (_match, group: string) => {
    const alternatives = group.split(",").map((s: string) => s.trim());
    return `(${alternatives.join("|")})`;
  });
  // Escape regex special chars except * and our alternation groups
  pattern = pattern.replace(/[.+^$[\]\\]/g, (char) => `\\${char}`);
  // Convert * to regex
  pattern = pattern.replace(/\*/g, ".*");
  return new RegExp(`${pattern}$`);
}

export const grep_files: Tool = {
  name: "grep_files",
  description: "Search file contents using a regular expression pattern. "
    + "Returns matching lines with file paths and line numbers.",
  category: "file" as ToolCategory,
  parameters: z.object({
    pattern: z.string().min(1).describe("Regex pattern to search for"),
    path: z.string().default(".").describe("Directory or file to search in"),
    include: z.string().optional().describe("File name pattern to include (e.g. '*.ts')"),
    max_results: z.coerce.number().int().positive().optional().default(50).describe("Maximum matches to return"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { pattern, path: originalPath = ".", include, max_results = 50 } = params as {
      pattern: string;
      path?: string;
      include?: string;
      max_results?: number;
    };

    try {
      // Check path permissions
      const allowedPaths = context.allowedPaths;
      const searchPath = normalizePath(originalPath || ".");
      if (allowedPaths && allowedPaths.length > 0) {
        if (!isPathAllowed(searchPath, allowedPaths)) {
          throw new ToolPermissionError("grep_files", `Path "${searchPath}" is not in allowed paths`);
        }
      }

      // Compile regex
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
      }

      // Compile include filter
      const includeRegex = include ? globToRegex(include) : null;

      const matches: Array<{ file: string; line: string; lineNumber: number; match: string }> = [];
      let totalMatches = 0;

      // Search a single file
      const searchFile = async (filePath: string): Promise<boolean> => {
        try {
          const content = await Bun.file(filePath).text();
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i]!;
            const m = lineContent.match(regex);
            if (m) {
              totalMatches++;
              if (matches.length < max_results) {
                matches.push({
                  file: filePath,
                  line: lineContent,
                  lineNumber: i + 1,
                  match: m[0],
                });
              }
            }
          }
        } catch {
          // Skip files that can't be read (binary, permission, etc.)
        }
        return matches.length >= max_results;
      };

      // Check if path is a file or directory
      let isDir = false;
      try {
        const stats = await fsStat(searchPath);
        isDir = stats.isDirectory();
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }

      if (!isDir) {
        // Single file search
        await searchFile(searchPath);
      } else {
        // Recursive directory walk
        const walkDir = async (dirPath: string): Promise<boolean> => {
          let entries;
          try {
            entries = await readdir(dirPath, { withFileTypes: true });
          } catch {
            return false;
          }
          for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              const capped = await walkDir(entryPath);
              if (capped) return true;
            } else if (entry.isFile()) {
              // Apply include filter on filename
              if (includeRegex && !includeRegex.test(entry.name)) {
                continue;
              }
              const capped = await searchFile(entryPath);
              if (capped) return true;
            }
          }
          return false;
        };

        await walkDir(searchPath);
      }

      return {
        success: true,
        result: {
          matches,
          totalMatches,
          truncated: totalMatches > matches.length,
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
