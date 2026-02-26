import { describe, expect, test } from "bun:test";
import { loadPersona, PersonaSchema } from "@pegasus/identity/persona.ts";
import { buildSystemPrompt } from "@pegasus/identity/prompt.ts";
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

  test("reason stage adds response instruction", () => {
    const prompt = buildSystemPrompt(persona, "reason");
    expect(prompt.toLowerCase()).toContain("reason");
    expect(prompt.toLowerCase()).toContain("respond");
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

  test("should include memory index in reason stage prompt", () => {
    const memoryIndex = [
      { path: "facts/user.md", summary: "user name, language", size: 320 },
      { path: "episodes/2026-02.md", summary: "logger fix, short ID", size: 1200 },
    ];

    const prompt = buildSystemPrompt(persona, "reason", memoryIndex);

    expect(prompt).toContain("Available memory:");
    expect(prompt).toContain("facts/user.md (320B): user name, language");
    expect(prompt).toContain("episodes/2026-02.md (1.2KB): logger fix, short ID");
    expect(prompt).toContain("memory_read");
  });

  test("should not include memory section when index is empty", () => {
    const prompt = buildSystemPrompt(persona, "reason", []);
    expect(prompt).not.toContain("Available memory:");
  });

  test("should not include memory section when index is undefined", () => {
    const prompt = buildSystemPrompt(persona, "reason");
    expect(prompt).not.toContain("Available memory:");
  });

  test("should format sizes correctly for memory index", () => {
    const memoryIndex = [
      { path: "facts/small.md", summary: "small", size: 100 },
      { path: "facts/large.md", summary: "large", size: 2048 },
    ];

    const prompt = buildSystemPrompt(persona, undefined, memoryIndex);

    expect(prompt).toContain("100B");
    expect(prompt).toContain("2.0KB");
  });
});
