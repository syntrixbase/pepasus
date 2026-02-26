import { describe, expect, test } from "bun:test";
import { getContextWindowSize } from "@pegasus/session/context-windows.ts";

describe("getContextWindowSize", () => {
  test("returns known size for gpt-4o", () => {
    expect(getContextWindowSize("gpt-4o")).toBe(128_000);
  }, 5_000);

  test("returns known size for gpt-4.1", () => {
    expect(getContextWindowSize("gpt-4.1")).toBe(1_000_000);
  }, 5_000);

  test("returns known size for claude-sonnet-4-20250514", () => {
    expect(getContextWindowSize("claude-sonnet-4-20250514")).toBe(200_000);
  }, 5_000);

  test("returns fallback for unknown model", () => {
    expect(getContextWindowSize("unknown-model-xyz")).toBe(128_000);
  }, 5_000);
});
