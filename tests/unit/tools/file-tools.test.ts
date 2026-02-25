/**
 * Unit tests for file tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { read_file, write_file, list_files, delete_file, move_file, get_file_info } from "../../../src/tools/builtins/file-tools.ts";
import { rm, mkdir } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-files";

describe("file tools", () => {
  beforeEach(async () => {
    // Clean and create test directory
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("read_file", () => {
    it("should read file content", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/test.txt`;

      // Create test file
      await Bun.write(filePath, "test content");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      expect((result.result as { content: string; size: number }).content).toBe("test content");
      expect((result.result as { content: string; size: number }).size).toBeGreaterThan(0);

      // Clean up this test's file
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should fail on non-existent file", async () => {
      const context = { taskId: "test-task-id" };
      const result = await read_file.execute({ path: `${testDir}/nonexistent.txt` }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("no such file or directory");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await read_file.execute({ path: "/etc/passwd" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("write_file", () => {
    it("should write file content", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/write-test.txt`;

      const result = await write_file.execute({ path: filePath, content: "new content" }, context);

      expect(result.success).toBe(true);
      expect((result.result as { bytesWritten: number }).bytesWritten).toBeGreaterThan(0);

      // Verify file was written
      const content = await Bun.file(filePath).text();
      expect(content).toBe("new content");

      // Clean up
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await write_file.execute({ path: "/etc/unauthorized.txt", content: "test" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("list_files", () => {
    it("should list files in directory", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/list-test.txt`;

      await Bun.write(filePath, "test");

      const result = await list_files.execute({ path: testDir }, context);

      expect(result.success).toBe(true);
      expect((result.result as { files: unknown[]; count: number }).files).toBeInstanceOf(Array);
      expect((result.result as { files: unknown[]; count: number }).count).toBeGreaterThan(0);

      // Clean up
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should handle recursive listing", async () => {
      const context = { taskId: "test-task-id" };
      const subDir = `${testDir}/subdir`;

      // Create subdirectory with file
      await Bun.write(`${subDir}/nested.txt`, "nested");

      const result = await list_files.execute({ path: testDir, recursive: true }, context);

      expect(result.success).toBe(true);
      expect((result.result as { recursive: boolean; files: unknown[] }).recursive).toBe(true);
      expect((result.result as { recursive: boolean; files: unknown[] }).files).toBeInstanceOf(Array);

      // Clean up
      await rm(subDir, { recursive: true, force: true }).catch(() => {});
    });

    it("should return empty list for non-existent directory", async () => {
      const context = { taskId: "test-task-id" };
      const result = await list_files.execute({ path: `${testDir}/nonexistent-dir` }, context);

      expect(result.success).toBe(true);
      const resultObj = result.result as { files: unknown[]; count: number };
      expect(resultObj.files).toEqual([]);
      expect(resultObj.count).toBe(0);
    });

    it("should filter files by pattern (non-recursive)", async () => {
      const context = { taskId: "test-task-id" };

      // Create files with different extensions
      await Bun.write(`${testDir}/file1.ts`, "ts content");
      await Bun.write(`${testDir}/file2.js`, "js content");
      await Bun.write(`${testDir}/file3.ts`, "ts content 2");

      const result = await list_files.execute({ path: testDir, pattern: "\\.ts$" }, context);

      expect(result.success).toBe(true);
      const resultObj = result.result as { files: Array<{ name: string }>; count: number };
      // Only .ts files should match
      expect(resultObj.count).toBe(2);
      for (const file of resultObj.files) {
        expect(file.name).toMatch(/\.ts$/);
      }
    });

    it("should filter files by pattern (recursive)", async () => {
      const context = { taskId: "test-task-id" };
      const subDir = `${testDir}/sub-pattern`;

      // Create files in subdirectory
      await Bun.write(`${subDir}/nested1.ts`, "ts");
      await Bun.write(`${subDir}/nested2.js`, "js");

      const result = await list_files.execute({
        path: testDir,
        recursive: true,
        pattern: "\\.ts$",
      }, context);

      expect(result.success).toBe(true);
      const resultObj = result.result as { files: Array<{ name: string; isDir: boolean }> };
      // Should include directories and only .ts files
      const fileEntries = resultObj.files.filter(f => !f.isDir);
      for (const file of fileEntries) {
        expect(file.name).toMatch(/\.ts$/);
      }
    });

    it("should reject unauthorized paths via allowedPaths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await list_files.execute({ path: "/etc" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("delete_file", () => {
    it("should delete a file", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/delete-test.txt`;

      await Bun.write(filePath, "test");

      const result = await delete_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      expect((result.result as { deleted: boolean }).deleted).toBe(true);

      // Verify file was deleted
      const exists = await Bun.file(filePath).exists();
      expect(exists).toBe(false);
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await delete_file.execute({ path: "/etc/passwd" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });

  describe("move_file", () => {
    it("should move a file", async () => {
      const context = { taskId: "test-task-id" };
      const fromPath = `${testDir}/move-from.txt`;
      const toPath = `${testDir}/move-to.txt`;

      await Bun.write(fromPath, "original content");

      const result = await move_file.execute({ from: fromPath, to: toPath }, context);

      expect(result.success).toBe(true);
      expect((result.result as { moved: boolean }).moved).toBe(true);

      // Verify move
      const fromExists = await Bun.file(fromPath).exists();
      const toExists = await Bun.file(toPath).exists();

      expect(fromExists).toBe(false);
      expect(toExists).toBe(true);

      // Clean up
      await rm(toPath, { force: true }).catch(() => {});
    });

    it("should reject unauthorized source path via allowedPaths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await move_file.execute({
        from: "/etc/passwd",
        to: `${testDir}/stolen.txt`,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Source path");
      expect(result.error).toContain("not in allowed paths");
    });

    it("should reject unauthorized destination path via allowedPaths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      // Create a valid source file first
      const fromPath = `${testDir}/move-allowed.txt`;
      await Bun.write(fromPath, "content");

      const result = await move_file.execute({
        from: fromPath,
        to: "/etc/evil.txt",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Destination path");
      expect(result.error).toContain("not in allowed paths");
    });

    it("should fail when moving non-existent file", async () => {
      const context = { taskId: "test-task-id" };

      const result = await move_file.execute({
        from: `${testDir}/does-not-exist.txt`,
        to: `${testDir}/target.txt`,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("get_file_info", () => {
    it("should get file information", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/info-test.txt`;

      await Bun.write(filePath, "test content");

      const result = await get_file_info.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      expect((result.result as { exists: boolean; size: number }).exists).toBe(true);
      expect((result.result as { exists: boolean; size: number }).size).toBeGreaterThan(0);
      // isFile and isDirectory are functions, so we call them to get the boolean value
      const stat = await Bun.file(filePath).stat();
      expect(stat.isFile()).toBe(true);
      expect(stat.isDirectory()).toBe(false);

      // Clean up
      await rm(filePath, { force: true }).catch(() => {});
    });

    it("should handle non-existent file gracefully", async () => {
      const context = { taskId: "test-task-id" };
      const result = await get_file_info.execute({ path: `${testDir}/nonexistent.txt` }, context);

      expect(result.success).toBe(false);
      expect((result.result as { exists: boolean }).exists).toBe(false);
    });

    it("should reject unauthorized paths via allowedPaths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await get_file_info.execute({ path: "/etc/passwd" }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });
  });
});
