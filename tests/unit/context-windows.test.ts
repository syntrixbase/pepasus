import { describe, expect, test } from "bun:test";
import { getContextWindowSize } from "@pegasus/session/context-windows.ts";

describe("getContextWindowSize", () => {
  // OpenAI models
  test("returns known size for gpt-4o", () => {
    expect(getContextWindowSize("gpt-4o")).toBe(128_000);
  }, 5_000);

  test("returns known size for gpt-4.1 (1M context)", () => {
    expect(getContextWindowSize("gpt-4.1")).toBe(1_000_000);
  }, 5_000);

  test("returns known size for gpt-5", () => {
    expect(getContextWindowSize("gpt-5")).toBe(272_000);
  }, 5_000);

  test("returns known size for o1", () => {
    expect(getContextWindowSize("o1")).toBe(200_000);
  }, 5_000);

  test("returns known size for o3-mini", () => {
    expect(getContextWindowSize("o3-mini")).toBe(200_000);
  }, 5_000);

  // Anthropic models
  test("returns known size for claude-sonnet-4-20250514", () => {
    expect(getContextWindowSize("claude-sonnet-4-20250514")).toBe(200_000);
  }, 5_000);

  test("returns known size for claude-opus-4-6 (1M context)", () => {
    expect(getContextWindowSize("claude-opus-4-6")).toBe(1_000_000);
  }, 5_000);

  // Google Gemini models
  test("returns known size for gemini-2.5-pro", () => {
    expect(getContextWindowSize("gemini-2.5-pro")).toBe(1_000_000);
  }, 5_000);

  test("returns known size for gemini-1.5-pro (2M context)", () => {
    expect(getContextWindowSize("gemini-1.5-pro")).toBe(2_000_000);
  }, 5_000);

  // Meta Llama models
  test("returns known size for llama-4-scout (10M context)", () => {
    expect(getContextWindowSize("llama-4-scout")).toBe(10_000_000);
  }, 5_000);

  test("returns known size for llama-3.1-70b", () => {
    expect(getContextWindowSize("llama-3.1-70b")).toBe(128_000);
  }, 5_000);

  // Fallback
  test("returns fallback for unknown model", () => {
    expect(getContextWindowSize("unknown-model-xyz")).toBe(128_000);
  }, 5_000);
});
