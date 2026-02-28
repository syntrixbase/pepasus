import { describe, it, expect } from "bun:test";
import { formatTimestamp, formatToolTimestamp } from "@pegasus/infra/time.ts";

describe("formatTimestamp", () => {
  it("should format epoch ms to YYYY-MM-DD HH:MM:SS", () => {
    const epoch = Date.UTC(2026, 1, 28, 14, 30, 5);
    const result = formatTimestamp(epoch);
    expect(result).toBe("2026-02-28 14:30:05");
  });

  it("should zero-pad single-digit months, days, hours, minutes, seconds", () => {
    const epoch = Date.UTC(2026, 0, 5, 3, 7, 9);
    const result = formatTimestamp(epoch);
    expect(result).toBe("2026-01-05 03:07:09");
  });
});

describe("formatToolTimestamp", () => {
  it("should include duration when provided", () => {
    const epoch = Date.UTC(2026, 1, 28, 14, 30, 5);
    const result = formatToolTimestamp(epoch, 2345);
    expect(result).toBe("[2026-02-28 14:30:05 | took 2.3s]");
  });

  it("should show sub-second durations with one decimal", () => {
    const epoch = Date.UTC(2026, 1, 28, 14, 30, 5);
    const result = formatToolTimestamp(epoch, 150);
    expect(result).toBe("[2026-02-28 14:30:05 | took 0.1s]");
  });

  it("should show seconds without decimal for whole seconds", () => {
    const epoch = Date.UTC(2026, 1, 28, 14, 30, 5);
    const result = formatToolTimestamp(epoch, 3000);
    expect(result).toBe("[2026-02-28 14:30:05 | took 3.0s]");
  });

  it("should omit duration when undefined", () => {
    const epoch = Date.UTC(2026, 1, 28, 14, 30, 5);
    const result = formatToolTimestamp(epoch);
    expect(result).toBe("[2026-02-28 14:30:05]");
  });
});
