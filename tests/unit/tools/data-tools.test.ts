/**
 * Unit tests for data tools.
 */

import { describe, it, expect } from "bun:test";
import { json_parse, json_stringify, base64_encode, base64_decode } from "../../../src/tools/builtins/data-tools.ts";

describe("json_parse tool", () => {
  it("should parse valid JSON", async () => {
    const context = { taskId: "test-task-id" };
    const result = await json_parse.execute({ text: '{"key": "value"}' }, context);

    expect(result.success).toBe(true);
    expect((result.result as { data: unknown }).data).toEqual({ key: "value" });
  });

  it("should fail on invalid JSON", async () => {
    const context = { taskId: "test-task-id" };
    const result = await json_parse.execute({ text: "not valid json" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("JSON");
  });
});

describe("json_stringify tool", () => {
  it("should serialize object to JSON", async () => {
    const context = { taskId: "test-task-id" };
    const result = await json_stringify.execute({ data: { key: "value" } }, context);

    expect(result.success).toBe(true);
    expect((result.result as { text: string }).text).toBe('{"key":"value"}');
  });

  it("should format with pretty option", async () => {
    const context = { taskId: "test-task-id" };
    const result = await json_stringify.execute({ data: { key: "value" }, pretty: true }, context);

    expect(result.success).toBe(true);
    expect((result.result as { text: string }).text).toContain("\n");
  });
});

describe("base64_encode tool", () => {
  it("should encode text to Base64", async () => {
    const context = { taskId: "test-task-id" };
    const result = await base64_encode.execute({ text: "hello" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { encoded: string }).encoded).toBe("aGVsbG8=");
  });
});

describe("base64_decode tool", () => {
  it("should decode Base64 to text", async () => {
    const context = { taskId: "test-task-id" };
    const result = await base64_decode.execute({ encoded: "aGVsbG8=" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { decoded: string }).decoded).toBe("hello");
  });

  it("should fail on invalid Base64", async () => {
    const context = { taskId: "test-task-id" };
    const result = await base64_decode.execute({ encoded: "not base64!!!" }, context);

    expect(result.success).toBe(false);
  });
});
