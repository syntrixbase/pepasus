/**
 * Tests for logger.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveTransports, reinitLogger, getLogger } from "../../src/infra/logger.ts";
import { existsSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("logger", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `pegasus-logger-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (_err) {
      // Ignore cleanup errors
    }
  });

  describe("resolveTransports", () => {
    test("returns file transport only when console disabled", () => {
      const logFile = join(testDir, "test.log");
      const { transport, isMultiTarget } = resolveTransports(logFile, false, "json");

      expect(transport).toBeDefined();
      expect(isMultiTarget).toBe(false);
      expect((transport as any).target).toBe("pino-roll");
      expect((transport as any).options.file).toBe(logFile);
    });

    test("returns multi-transport with console enabled and pretty format", () => {
      const logFile = join(testDir, "test.log");
      const { transport, isMultiTarget } = resolveTransports(logFile, true, "pretty");

      expect(transport).toBeDefined();
      expect(isMultiTarget).toBe(true);
      expect((transport as any).targets).toBeDefined();
      expect((transport as any).targets).toHaveLength(2);

      const targets = (transport as any).targets;
      // Console: pino-pretty with color
      expect(targets[0].target).toBe("pino-pretty");
      expect(targets[0].options.colorize).toBe(true);
      // File: pipeline (pino-pretty no color → pino-roll)
      expect(targets[1].pipeline).toBeDefined();
      expect(targets[1].pipeline).toHaveLength(2);
      expect(targets[1].pipeline[0].target).toBe("pino-pretty");
      expect(targets[1].pipeline[0].options.colorize).toBe(false);
      expect(targets[1].pipeline[1].target).toBe("pino-roll");
    });

    test("returns multi-transport with console enabled and json format", () => {
      const logFile = join(testDir, "test.log");
      const { transport, isMultiTarget } = resolveTransports(logFile, true, "json");

      expect(transport).toBeDefined();
      expect(isMultiTarget).toBe(true);
      expect((transport as any).targets).toBeDefined();
      expect((transport as any).targets).toHaveLength(2);

      const targets = (transport as any).targets;
      expect(targets[0].target).toBe("pino/file");
      expect(targets[0].options.destination).toBe(1); // stdout
      expect(targets[1].target).toBe("pino-roll");
    });

    test("defaults to json format when logFormat not specified", () => {
      const logFile = join(testDir, "test.log");
      const { transport, isMultiTarget } = resolveTransports(logFile, true);

      expect(isMultiTarget).toBe(true);
      const targets = (transport as any).targets;
      expect(targets[0].target).toBe("pino/file"); // json = pino/file for console
    });

    test("creates log directory if it doesn't exist", () => {
      const logFile = join(testDir, "nested/dir/test.log");
      const logDir = join(testDir, "nested/dir");

      expect(existsSync(logDir)).toBe(false);

      resolveTransports(logFile, false, "json");

      expect(existsSync(logDir)).toBe(true);
    });

    test("file transport uses pipeline with pino-pretty when format is pretty", () => {
      const logFile = join(testDir, "test.log");
      const { transport, isMultiTarget } = resolveTransports(logFile, false, "pretty");

      expect(transport).toBeDefined();
      // Single transport (file only), but it's a pipeline
      expect(isMultiTarget).toBe(false);
      expect((transport as any).pipeline).toBeDefined();
      expect((transport as any).pipeline).toHaveLength(2);
      expect((transport as any).pipeline[0].target).toBe("pino-pretty");
      expect((transport as any).pipeline[0].options.colorize).toBe(false);
      expect((transport as any).pipeline[1].target).toBe("pino-roll");
    });
  });

  describe("reinitLogger", () => {
    test("reinitializes logger without errors", () => {
      const logFile = join(testDir, "reinit.log");

      expect(() => reinitLogger(logFile, false)).not.toThrow();
    });

    test("reinitializes logger and getLogger still works", () => {
      const logFile = join(testDir, "reinit.log");

      reinitLogger(logFile, false);

      const logger = getLogger("test-module");
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });

    test("reinitializes logger with console enabled", () => {
      const logFile = join(testDir, "reinit.log");

      expect(() => reinitLogger(logFile, true)).not.toThrow();
    });

    test("reinitializes logger with pretty format", () => {
      const logFile = join(testDir, "reinit.log");

      expect(() => reinitLogger(logFile, false, "pretty")).not.toThrow();
    });
  });

  describe("automatic log cleanup", () => {
    test("cleans up old log files older than 30 days", () => {
      const logFile = join(testDir, "pegasus.log");
      const logsDir = join(testDir);

      // Create some old rotated log files
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
      const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;

      const oldLogFile = join(logsDir, "pegasus.log.2024-01-01");
      const recentLogFile = join(logsDir, "pegasus.log.2024-02-10");

      writeFileSync(oldLogFile, "old log content");
      writeFileSync(recentLogFile, "recent log content");

      // Set modification times
      utimesSync(oldLogFile, new Date(thirtyOneDaysAgo), new Date(thirtyOneDaysAgo));
      utimesSync(recentLogFile, new Date(twentyNineDaysAgo), new Date(twentyNineDaysAgo));

      expect(existsSync(oldLogFile)).toBe(true);
      expect(existsSync(recentLogFile)).toBe(true);

      // Trigger cleanup by initializing logger
      resolveTransports(logFile, false, "json");

      // Old log should be deleted, recent log should remain
      expect(existsSync(oldLogFile)).toBe(false);
      expect(existsSync(recentLogFile)).toBe(true);
    });

    test("does not delete non-log files", () => {
      const logFile = join(testDir, "pegasus.log");
      const logsDir = join(testDir);

      // Create a non-log file
      const otherFile = join(logsDir, "other-file.txt");
      writeFileSync(otherFile, "not a log file");

      // Set old modification time
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
      utimesSync(otherFile, new Date(thirtyOneDaysAgo), new Date(thirtyOneDaysAgo));

      expect(existsSync(otherFile)).toBe(true);

      // Trigger cleanup
      resolveTransports(logFile, false, "json");

      // Non-log file should not be deleted
      expect(existsSync(otherFile)).toBe(true);
    });

    test("handles cleanup errors gracefully", () => {
      const logFile = join(testDir, "nonexistent/dir/pegasus.log");

      // Should not throw even if directory doesn't exist
      expect(() => resolveTransports(logFile, false, "json")).not.toThrow();
    });
  });
});
