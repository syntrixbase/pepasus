/**
 * Unit tests for file tools.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { read_file, write_file, list_files, delete_file, move_file, get_file_info, edit_file, grep_files } from "../../../src/tools/builtins/file-tools.ts";
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
    it("should read file content with line numbers", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/test.txt`;

      await Bun.write(filePath, "test content");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; size: number; totalLines: number; linesReturned: number };
      // Line-numbered format: "1\ttest content"
      expect(r.content).toBe("1\ttest content");
      expect(r.size).toBeGreaterThan(0);
      expect(r.totalLines).toBe(1);
      expect(r.linesReturned).toBe(1);
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

    it("should read with offset and limit (line-numbered)", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/lines.txt`;
      const lines = ["line0", "line1", "line2", "line3", "line4"];
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath, offset: 1, limit: 2 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; offset: number; linesReturned: number; truncated: boolean };
      expect(r.content).toBe("2\tline1\n3\tline2");
      expect(r.totalLines).toBe(5);
      expect(r.offset).toBe(1);
      expect(r.linesReturned).toBe(2);
      expect(r.truncated).toBe(true);
    });

    it("should read with offset only (to default max)", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/lines-offset.txt`;
      const lines = ["a", "b", "c", "d"];
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath, offset: 2 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; offset: number; truncated: boolean };
      expect(r.content).toBe("3\tc\n4\td");
      expect(r.offset).toBe(2);
      expect(r.truncated).toBe(false);
    });

    it("should read with limit only (from start)", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/lines-limit.txt`;
      const lines = ["x", "y", "z"];
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath, limit: 2 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; offset: number; linesReturned: number; truncated: boolean };
      expect(r.content).toBe("1\tx\n2\ty");
      expect(r.offset).toBe(0);
      expect(r.linesReturned).toBe(2);
      expect(r.truncated).toBe(true);
    });

    it("should always include totalLines and linesReturned", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/full.txt`;
      await Bun.write(filePath, "full content here");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; linesReturned: number; truncated: boolean };
      expect(r.content).toBe("1\tfull content here");
      expect(r.totalLines).toBe(1);
      expect(r.linesReturned).toBe(1);
      expect(r.truncated).toBe(false);
    });

    it("should default to 2000-line limit for large files", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/large.txt`;
      // Create a file with 3000 lines
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      await Bun.write(filePath, lines.join("\n"));

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { totalLines: number; linesReturned: number; truncated: boolean; notice: string };
      expect(r.totalLines).toBe(3000);
      expect(r.linesReturned).toBe(2000);
      expect(r.truncated).toBe(true);
      expect(r.notice).toContain("3000 lines");
      expect(r.notice).toContain("offset and limit");
    });

    it("should truncate long lines at 2000 characters", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/longline.txt`;
      const longLine = "x".repeat(3000);
      await Bun.write(filePath, longLine);

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string };
      // "1\t" + 2000 chars + "…"
      const content = r.content;
      expect(content.startsWith("1\t")).toBe(true);
      const lineContent = content.slice(2); // strip "1\t"
      expect(lineContent.length).toBe(2001); // 2000 + "…"
      expect(lineContent.endsWith("…")).toBe(true);
    });

    it("should not include notice when file fits within limit", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/small.txt`;
      await Bun.write(filePath, "short\nfile");

      const result = await read_file.execute({ path: filePath }, context);

      expect(result.success).toBe(true);
      const r = result.result as Record<string, unknown>;
      expect(r.notice).toBeUndefined();
      expect(r.truncated).toBe(false);
    });

    it("should return empty content when offset is beyond file length", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/small.txt`;
      await Bun.write(filePath, "one\ntwo");

      const result = await read_file.execute({ path: filePath, offset: 100 }, context);

      expect(result.success).toBe(true);
      const r = result.result as { content: string; totalLines: number; truncated: boolean };
      expect(r.content).toBe("");
      expect(r.totalLines).toBe(2);
      expect(r.truncated).toBe(false);
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

  describe("edit_file", () => {
    it("should replace a unique string in a file", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/edit-test.txt`;
      await Bun.write(filePath, "Hello world, this is a test file.\nSecond line here.");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "this is a test file",
        new_string: "this is an edited file",
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { path: string; replacements: number };
      expect(r.replacements).toBe(1);

      const content = await Bun.file(filePath).text();
      expect(content).toBe("Hello world, this is an edited file.\nSecond line here.");
    });

    it("should replace all occurrences with replace_all=true", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/edit-all.txt`;
      await Bun.write(filePath, "foo bar foo baz foo");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "foo",
        new_string: "qux",
        replace_all: true,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { replacements: number };
      expect(r.replacements).toBe(3);

      const content = await Bun.file(filePath).text();
      expect(content).toBe("qux bar qux baz qux");
    });

    it("should error when old_string is not found", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/edit-notfound.txt`;
      await Bun.write(filePath, "some content here");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "nonexistent string",
        new_string: "replacement",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("old_string not found in file");
    });

    it("should error when old_string matches multiple times without replace_all", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/edit-ambiguous.txt`;
      await Bun.write(filePath, "abc def abc ghi abc");

      const result = await edit_file.execute({
        path: filePath,
        old_string: "abc",
        new_string: "xyz",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("found 3 times");
      expect(result.error).toContain("replace_all");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await edit_file.execute({
        path: "/etc/passwd",
        old_string: "root",
        new_string: "hacked",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should error on non-existent file", async () => {
      const context = { taskId: "test-task-id" };

      const result = await edit_file.execute({
        path: `${testDir}/does-not-exist.txt`,
        old_string: "hello",
        new_string: "world",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
    });
  });

  describe("grep_files", () => {
    it("should search a single file and return matches with line numbers", async () => {
      const context = { taskId: "test-task-id" };
      const filePath = `${testDir}/grep-single.txt`;
      await Bun.write(filePath, "first line\nsecond match here\nthird line\nfourth match here");

      const result = await grep_files.execute({
        pattern: "match",
        path: filePath,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { matches: Array<{ file: string; line: string; lineNumber: number; match: string }>; totalMatches: number; truncated: boolean };
      expect(r.totalMatches).toBe(2);
      expect(r.matches).toHaveLength(2);
      expect(r.matches[0]!.lineNumber).toBe(2);
      expect(r.matches[0]!.line).toBe("second match here");
      expect(r.matches[0]!.match).toBe("match");
      expect(r.matches[1]!.lineNumber).toBe(4);
      expect(r.truncated).toBe(false);
    });

    it("should search across multiple files in a directory", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/a.txt`, "hello world");
      await Bun.write(`${testDir}/b.txt`, "hello there");
      await Bun.write(`${testDir}/c.txt`, "goodbye");

      const result = await grep_files.execute({
        pattern: "hello",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { matches: Array<{ file: string }>; totalMatches: number };
      expect(r.totalMatches).toBe(2);
      const files = r.matches.map(m => m.file);
      expect(files.some(f => f.endsWith("a.txt"))).toBe(true);
      expect(files.some(f => f.endsWith("b.txt"))).toBe(true);
    });

    it("should filter files with include pattern", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/code.ts`, "const x = 1;");
      await Bun.write(`${testDir}/code.js`, "const x = 2;");
      await Bun.write(`${testDir}/data.json`, '{"x": 3}');

      const result = await grep_files.execute({
        pattern: "const",
        path: testDir,
        include: "*.ts",
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { matches: Array<{ file: string }>; totalMatches: number };
      expect(r.totalMatches).toBe(1);
      expect(r.matches[0]!.file).toContain("code.ts");
    });

    it("should return empty matches when no results found", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/nope.txt`, "nothing here");

      const result = await grep_files.execute({
        pattern: "zzzzz_not_found",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { matches: unknown[]; totalMatches: number; truncated: boolean };
      expect(r.matches).toHaveLength(0);
      expect(r.totalMatches).toBe(0);
      expect(r.truncated).toBe(false);
    });

    it("should respect max_results and report truncation", async () => {
      const context = { taskId: "test-task-id" };
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i} match`);
      await Bun.write(`${testDir}/many.txt`, lines.join("\n"));

      const result = await grep_files.execute({
        pattern: "match",
        path: `${testDir}/many.txt`,
        max_results: 5,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { matches: unknown[]; totalMatches: number; truncated: boolean };
      expect(r.matches).toHaveLength(5);
      expect(r.totalMatches).toBe(20);
      expect(r.truncated).toBe(true);
    });

    it("should error on invalid regex pattern", async () => {
      const context = { taskId: "test-task-id" };
      await Bun.write(`${testDir}/regex-test.txt`, "content");

      const result = await grep_files.execute({
        pattern: "[invalid",
        path: testDir,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid regex pattern");
    });

    it("should reject unauthorized paths", async () => {
      const allowedPaths = [testDir];
      const context = { taskId: "test-task-id", allowedPaths };

      const result = await grep_files.execute({
        pattern: "root",
        path: "/etc",
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed paths");
    });

    it("should search recursively in subdirectories", async () => {
      const context = { taskId: "test-task-id" };
      const subDir = `${testDir}/sub`;
      await mkdir(subDir, { recursive: true });
      await Bun.write(`${testDir}/top.txt`, "find_me_here");
      await Bun.write(`${subDir}/nested.txt`, "find_me_here too");

      const result = await grep_files.execute({
        pattern: "find_me_here",
        path: testDir,
      }, context);

      expect(result.success).toBe(true);
      const r = result.result as { matches: Array<{ file: string }>; totalMatches: number };
      expect(r.totalMatches).toBe(2);
    });

    it("should error on non-existent path", async () => {
      const context = { taskId: "test-task-id" };

      const result = await grep_files.execute({
        pattern: "test",
        path: `${testDir}/nonexistent-dir`,
      }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Path not found");
    });
  });
});
