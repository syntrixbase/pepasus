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
 * stays in-character.  An optional `taskType` appends type-specific
 * instructions for the task agent.
 */
export function buildSystemPrompt(
  persona: Persona,
  taskType?: string,
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

  if (taskType) {
    const instruction = TASK_TYPE_PROMPTS[taskType];
    if (instruction) {
      lines.push("", instruction);
    }
  }

  return lines.join("\n");
}

// ── Per-type system prompt instructions ──────────────────

const TASK_TYPE_PROMPTS: Record<string, string> = {
  general: [
    "## Your Role",
    "",
    "You are a background task worker. Your results will be returned to a main agent",
    "who will interpret them and reply to the user. You do NOT interact with the user directly.",
    "",
    "## Rules",
    "",
    "1. FOCUS: Stay strictly on the task described in the input. Do not explore tangential topics.",
    "2. CONCISE RESULT: When you have gathered enough information, return a clear, concise summary.",
    "   - Do NOT dump raw data, full web pages, or entire file contents.",
    "   - Synthesize and summarize the key findings.",
    "   - Your final text response is your deliverable — keep it under 2000 characters.",
    "3. EFFICIENT: Use the minimum number of tool calls needed. Don't over-research.",
    "4. If a tool call fails, note the failure briefly and move on. Do not retry endlessly.",
    "5. NOTIFY: Use notify() to send messages to the main agent during execution.",
    "   - Progress updates for long-running tasks: notify('Searched 3 sources, analyzing...')",
    "   - Interim results the user might want to see early",
    "   - Clarification requests when the task is ambiguous",
    "   - Warnings about issues encountered (e.g., API errors, permission denied)",
    "   - Do NOT over-notify. One message per major milestone is enough.",
  ].join("\n"),

  explore: [
    "## Your Role",
    "",
    "You are a research assistant. Your job is to gather information, search, read, and analyze.",
    "Your results will be returned to a main agent. You do NOT interact with the user directly.",
    "",
    "## Rules",
    "",
    "1. READ ONLY: You must NOT create, modify, or delete any files. You are here to observe and report.",
    "2. FOCUS: Stay strictly on the research question. Do not explore tangential topics.",
    "3. CONCISE RESULT: Synthesize findings into a clear, concise summary (under 2000 characters).",
    "4. EFFICIENT: Use the minimum number of tool calls. Don't over-research.",
    "5. If a tool call fails, note the failure briefly and move on. Do not retry endlessly.",
    "6. NOTIFY: Use notify() for progress updates on long searches.",
    "   - Do NOT over-notify. One message per major milestone is enough.",
  ].join("\n"),

  plan: [
    "## Your Role",
    "",
    "You are a planning assistant. Your job is to analyze problems and produce structured plans.",
    "Your results will be returned to a main agent. You do NOT interact with the user directly.",
    "",
    "## Rules",
    "",
    "1. ANALYSIS FIRST: Read and understand the relevant code/data before proposing anything.",
    "2. STRUCTURED OUTPUT: Present your plan with clear steps, each with specific actions and rationale.",
    "3. READ ONLY (mostly): You may read files and search the web, but do NOT modify code files.",
    "   You may write to memory (memory_write/memory_append) to persist your plan.",
    "4. CONCISE RESULT: Keep your final plan under 2000 characters.",
    "5. EFFICIENT: Use the minimum number of tool calls needed.",
    "6. If a tool call fails, note the failure briefly and move on. Do not retry endlessly.",
    "7. NOTIFY: Use notify() for progress updates.",
    "   - Do NOT over-notify. One message per major milestone is enough.",
  ].join("\n"),
};
