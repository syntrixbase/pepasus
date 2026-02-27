import { describe, expect, test } from "bun:test";
import { loadPersona, PersonaSchema } from "@pegasus/identity/persona.ts";
import { buildSystemPrompt, formatSize } from "@pegasus/identity/prompt.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Persona tests ───────────────────────────────────────────

describe("PersonaSchema", () => {
  test("valid persona passes validation", () => {
    const result = PersonaSchema.parse({
      name: "Alice",
      role: "digital employee",
      personality: ["professional", "helpful"],
      style: "concise and warm",
      values: ["accuracy", "empathy"],
    });
    expect(result.name).toBe("Alice");
    expect(result.personality).toHaveLength(2);
  });

  test("optional background field", () => {
    const result = PersonaSchema.parse({
      name: "Alice",
      role: "assistant",
      personality: ["helpful"],
      style: "concise",
      values: ["accuracy"],
      background: "10 years of experience",
    });
    expect(result.background).toBe("10 years of experience");
  });

  test("missing required field throws", () => {
    expect(() =>
      PersonaSchema.parse({ name: "Alice", role: "assistant" }),
    ).toThrow();
  });

  test("empty name throws", () => {
    expect(() =>
      PersonaSchema.parse({
        name: "",
        role: "assistant",
        personality: ["helpful"],
        style: "concise",
        values: ["accuracy"],
      }),
    ).toThrow();
  });

  test("empty personality array throws", () => {
    expect(() =>
      PersonaSchema.parse({
        name: "Alice",
        role: "assistant",
        personality: [],
        style: "concise",
        values: ["accuracy"],
      }),
    ).toThrow();
  });
});

describe("loadPersona", () => {
  const testDir = join(import.meta.dir, "..", "fixtures");
  const validFile = join(testDir, "test-persona.json");
  const invalidFile = join(testDir, "invalid-persona.json");

  test("loads valid persona from JSON file", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    writeFileSync(
      validFile,
      JSON.stringify({
        name: "TestBot",
        role: "test assistant",
        personality: ["helpful"],
        style: "concise",
        values: ["accuracy"],
      }),
    );

    const persona = loadPersona(validFile);
    expect(persona.name).toBe("TestBot");
    expect(persona.role).toBe("test assistant");

    unlinkSync(validFile);
  });

  test("throws on invalid JSON file", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    writeFileSync(invalidFile, "not valid json");

    expect(() => loadPersona(invalidFile)).toThrow();

    unlinkSync(invalidFile);
  });

  test("throws on non-existent file", () => {
    expect(() => loadPersona("/tmp/nonexistent-persona.json")).toThrow();
  });

  test("throws when persona fails validation", () => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    const badFile = join(testDir, "bad-persona.json");
    writeFileSync(badFile, JSON.stringify({ name: "Alice" }));

    expect(() => loadPersona(badFile)).toThrow();

    unlinkSync(badFile);
  });

  test("loads default persona file", () => {
    const persona = loadPersona("data/personas/default.json");
    expect(persona.name).toBeTruthy();
    expect(persona.role).toBeTruthy();
  });
});

// ── Prompt tests ────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  const persona: Persona = {
    name: "Alice",
    role: "digital employee",
    personality: ["professional", "helpful"],
    style: "concise and warm",
    values: ["accuracy", "empathy"],
  };

  test("includes persona name and role", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("digital employee");
  });

  test("includes personality traits", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("professional");
    expect(prompt).toContain("helpful");
  });

  test("includes style", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("concise and warm");
  });

  test("includes values", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("accuracy");
    expect(prompt).toContain("empathy");
  });

  test("reason stage adds task worker instruction", () => {
    const prompt = buildSystemPrompt(persona, "reason");
    expect(prompt).toContain("background task worker");
    expect(prompt).toContain("FOCUS");
    expect(prompt).toContain("CONCISE RESULT");
    expect(prompt).toContain("notify()");
  });

  test("reflect stage (removed) does not add instruction", () => {
    const prompt = buildSystemPrompt(persona, "reflect");
    expect(prompt).not.toContain("Your current task");
  });

  test("unknown stage does not add instruction", () => {
    const prompt = buildSystemPrompt(persona, "unknown_stage");
    // Should not contain any stage-specific instructions
    expect(prompt).not.toContain("Your current task");
  });

  test("no stage returns base prompt only", () => {
    const prompt = buildSystemPrompt(persona);
    // Should not contain stage-specific instructions
    expect(prompt).not.toContain("Your current task");
  });

  test("includes background when present", () => {
    const personaWithBg: Persona = {
      ...persona,
      background: "Expert in AI systems",
    };
    const prompt = buildSystemPrompt(personaWithBg);
    expect(prompt).toContain("Expert in AI systems");
  });

  test("works without background", () => {
    // persona without background should still produce valid prompt
    const prompt = buildSystemPrompt(persona);
    expect(prompt.length).toBeGreaterThan(50);
  });

  test("should NOT include memory index in system prompt (moved to user message)", () => {
    const prompt = buildSystemPrompt(persona, "reason");
    expect(prompt).not.toContain("Available memory");
    expect(prompt).not.toContain("memory_read");
  });

  test("should not include memory section in system prompt", () => {
    const prompt = buildSystemPrompt(persona, "reason");
    expect(prompt).not.toContain("Available memory");
  });

  test("should not include memory section when no stage", () => {
    const prompt = buildSystemPrompt(persona);
    expect(prompt).not.toContain("Available memory");
  });

  test("formatSize formats bytes correctly", () => {
    expect(formatSize(500)).toBe("500B");
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(2560)).toBe("2.5KB");
  });
});
