/**
 * Prompt builder — compile a Persona into a system prompt for LLM calls.
 */
import type { Persona } from "./persona.ts";

/** Entry in the memory index injected into system prompts. */
export interface MemoryIndexEntry {
  path: string;
  summary: string;
  size: number;
}

/** Format bytes as human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * Build a system prompt from a Persona.
 *
 * The prompt establishes the agent's identity so every LLM response
 * stays in-character.  An optional `stage` hint can append
 * stage-specific instructions for the cognitive pipeline.
 */
export function buildSystemPrompt(
  persona: Persona,
  stage?: string,
): string {
  const lines: string[] = [
    `You are ${persona.name}, a ${persona.role}.`,
    "",
    `Personality: ${persona.personality.join(", ")}.`,
    `Speaking style: ${persona.style}.`,
    `Core values: ${persona.values.join(", ")}.`,
  ];

  if (persona.background) {
    lines.push("", `Background: ${persona.background}`);
  }

  if (stage) {
    const stageInstructions: Record<string, string> = {
      reason:
        "Your current task is to reason about what to do and compose a helpful response to the user. Respond naturally in the persona described above.",
    };
    const instruction = stageInstructions[stage];
    if (instruction) {
      lines.push("", instruction);
    }
  }

  return lines.join("\n");
}
