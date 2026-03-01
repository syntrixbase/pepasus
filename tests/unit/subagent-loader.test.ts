/**
 * Tests for SubagentLoader — SUBAGENT.md parsing and directory scanning.
 *
 * Covers frontmatter parsing, model field extraction, name validation,
 * tool parsing, and multi-directory scanning with source tagging.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "node:path";
import { tmpdir } from "os";
import { parseSubagentFile, scanSubagentDir, loadAllSubagents } from "@pegasus/subagents/loader.ts";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "subagent-loader-test-"));
}

function writeSubagentMd(dir: string, name: string, content: string): string {
  const subDir = path.join(dir, name);
  mkdirSync(subDir, { recursive: true });
  const filePath = path.join(subDir, "SUBAGENT.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("parseSubagentFile", () => {
  test("parses basic frontmatter fields", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "test-agent", `---
name: test-agent
description: "A test agent"
tools: "read_file, grep_files"
---

You are a test agent.
`);
      const def = parseSubagentFile(filePath, "test-agent", "builtin");
      expect(def).not.toBeNull();
      expect(def!.name).toBe("test-agent");
      expect(def!.description).toBe("A test agent");
      expect(def!.tools).toEqual(["read_file", "grep_files"]);
      expect(def!.prompt).toBe("You are a test agent.");
      expect(def!.source).toBe("builtin");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model field is parsed from frontmatter (tier name)", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "explore", `---
name: explore
description: "Explorer agent"
tools: "*"
model: fast
---

Explore things.
`);
      const def = parseSubagentFile(filePath, "explore", "builtin");
      expect(def).not.toBeNull();
      expect(def!.model).toBe("fast");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model field is parsed from frontmatter (specific model spec)", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "custom", `---
name: custom
description: "Custom agent"
tools: "*"
model: openai/gpt-4o-mini
---

Custom prompt.
`);
      const def = parseSubagentFile(filePath, "custom", "user");
      expect(def).not.toBeNull();
      expect(def!.model).toBe("openai/gpt-4o-mini");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model field is undefined when not specified", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "no-model", `---
name: no-model
description: "Agent without model"
tools: "*"
---

No model specified.
`);
      const def = parseSubagentFile(filePath, "no-model", "builtin");
      expect(def).not.toBeNull();
      expect(def!.model).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tier names (fast, balanced, powerful) are passed through as-is", () => {
    const tmp = makeTmpDir();
    try {
      for (const tier of ["fast", "balanced", "powerful"]) {
        const filePath = writeSubagentMd(tmp, `agent-${tier}`, `---
name: agent-${tier}
description: "Agent with ${tier} tier"
tools: "*"
model: ${tier}
---

Prompt.
`);
        const def = parseSubagentFile(filePath, `agent-${tier}`, "builtin");
        expect(def).not.toBeNull();
        expect(def!.model).toBe(tier);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("specific model specs are passed through as-is", () => {
    const tmp = makeTmpDir();
    try {
      const specs = ["openai/gpt-4o", "anthropic/claude-sonnet-4", "openai/gpt-4o-mini"];
      for (const spec of specs) {
        const safeName = spec.replace(/\//g, "-");
        const filePath = writeSubagentMd(tmp, safeName, `---
name: ${safeName}
description: "Agent with ${spec}"
tools: "*"
model: ${spec}
---

Prompt.
`);
        const def = parseSubagentFile(filePath, safeName, "user");
        expect(def).not.toBeNull();
        expect(def!.model).toBe(spec);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("uses dirName as name when frontmatter name is missing", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "fallback-name", `---
description: "No name field"
tools: "*"
---

Body.
`);
      const def = parseSubagentFile(filePath, "fallback-name", "builtin");
      expect(def).not.toBeNull();
      expect(def!.name).toBe("fallback-name");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tools '*' expands to wildcard array", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "wildcard", `---
name: wildcard
description: "Wildcard tools"
tools: "*"
---

Body.
`);
      const def = parseSubagentFile(filePath, "wildcard", "builtin");
      expect(def).not.toBeNull();
      expect(def!.tools).toEqual(["*"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns null for invalid name", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "INVALID_NAME", `---
name: INVALID_NAME
description: "Bad name"
tools: "*"
---

Body.
`);
      const def = parseSubagentFile(filePath, "INVALID_NAME", "builtin");
      expect(def).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("handles missing frontmatter gracefully", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubagentMd(tmp, "no-fm", "Just a markdown body.");
      const def = parseSubagentFile(filePath, "no-fm", "builtin");
      expect(def).not.toBeNull();
      expect(def!.name).toBe("no-fm");
      expect(def!.tools).toEqual(["*"]);
      expect(def!.model).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scanSubagentDir", () => {
  test("discovers subagents in directory", () => {
    const tmp = makeTmpDir();
    try {
      writeSubagentMd(tmp, "agent-a", `---
name: agent-a
description: "Agent A"
tools: "*"
model: fast
---

A prompt.
`);
      writeSubagentMd(tmp, "agent-b", `---
name: agent-b
description: "Agent B"
tools: "*"
---

B prompt.
`);
      const defs = scanSubagentDir(tmp, "builtin");
      expect(defs.length).toBe(2);
      const names = defs.map(d => d.name).sort();
      expect(names).toEqual(["agent-a", "agent-b"]);

      const agentA = defs.find(d => d.name === "agent-a");
      expect(agentA!.model).toBe("fast");

      const agentB = defs.find(d => d.name === "agent-b");
      expect(agentB!.model).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns empty array for nonexistent directory", () => {
    const defs = scanSubagentDir("/nonexistent/path/xyz", "user");
    expect(defs).toEqual([]);
  });
});

describe("loadAllSubagents", () => {
  test("merges builtin and user subagents", () => {
    const builtinDir = makeTmpDir();
    const userDir = makeTmpDir();
    try {
      writeSubagentMd(builtinDir, "explore", `---
name: explore
description: "Built-in explore"
tools: "*"
model: fast
---

Explore.
`);
      writeSubagentMd(userDir, "custom", `---
name: custom
description: "User custom"
tools: "*"
model: openai/gpt-4o-mini
---

Custom.
`);
      const all = loadAllSubagents(builtinDir, userDir);
      expect(all.length).toBe(2);

      const explore = all.find(d => d.name === "explore");
      expect(explore!.source).toBe("builtin");
      expect(explore!.model).toBe("fast");

      const custom = all.find(d => d.name === "custom");
      expect(custom!.source).toBe("user");
      expect(custom!.model).toBe("openai/gpt-4o-mini");
    } finally {
      rmSync(builtinDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});
