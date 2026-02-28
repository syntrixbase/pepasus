import { describe, expect, test } from "bun:test";
import { sanitizeForPrompt } from "@pegasus/infra/sanitize.ts";

describe("sanitizeForPrompt", () => {
  test("preserves normal text", () => {
    expect(sanitizeForPrompt("Hello world")).toBe("Hello world");
  });

  test("preserves newlines and tabs", () => {
    expect(sanitizeForPrompt("line1\nline2\ttab")).toBe("line1\nline2\ttab");
  });

  test("preserves carriage return", () => {
    expect(sanitizeForPrompt("line1\r\nline2")).toBe("line1\r\nline2");
  });

  test("strips null bytes", () => {
    expect(sanitizeForPrompt("hello\x00world")).toBe("helloworld");
  });

  test("strips bidi override characters", () => {
    expect(sanitizeForPrompt("hello\u202Eworld")).toBe("helloworld");
  });

  test("strips zero-width characters", () => {
    expect(sanitizeForPrompt("hello\u200Bworld")).toBe("helloworld");
    expect(sanitizeForPrompt("hello\uFEFFworld")).toBe("helloworld");
  });

  test("strips line separator U+2028", () => {
    expect(sanitizeForPrompt("hello\u2028world")).toBe("helloworld");
  });

  test("strips paragraph separator U+2029", () => {
    expect(sanitizeForPrompt("hello\u2029world")).toBe("helloworld");
  });

  test("handles empty string", () => {
    expect(sanitizeForPrompt("")).toBe("");
  });

  test("preserves unicode text (CJK, emoji)", () => {
    expect(sanitizeForPrompt("你好世界 🌍")).toBe("你好世界 🌍");
  });

  test("strips multiple control chars in one string", () => {
    expect(sanitizeForPrompt("\x00hello\u200B\u202Eworld\x01")).toBe("helloworld");
  });
});
