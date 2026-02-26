/**
 * CLI — Interactive REPL for conversing with the Pegasus agent.
 *
 * Uses Bun's native readline for zero-dependency terminal interaction.
 * The CLI is a simple channel adapter: read input → send → display reply.
 */
import { createInterface } from "readline";
import { MainAgent } from "./agents/main-agent.ts";
import { loadPersona } from "./identity/persona.ts";
import { getSettings } from "./infra/config.ts";
import { getLogger, initLogger } from "./infra/logger.ts";
import { ModelRegistry } from "./infra/model-registry.ts";

const logger = getLogger("cli");

/** Print a styled banner. */
function printBanner(personaName: string, personaRole: string) {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║          🚀 Pegasus CLI              ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`  Persona: ${personaName} (${personaRole})`);
  console.log("  Type /help for commands, /exit to quit");
  console.log("");
}

/** Handle slash commands. Returns true if command was handled. */
function handleCommand(input: string): boolean | "exit" {
  const cmd = input.trim().toLowerCase();

  if (cmd === "/exit" || cmd === "/quit") {
    console.log("\n👋 Goodbye!\n");
    return "exit";
  }

  if (cmd === "/help") {
    console.log("");
    console.log("  Commands:");
    console.log("    /help   — Show this help message");
    console.log("    /exit   — Exit the REPL");
    console.log("");
    return true;
  }

  return false;
}

/** Main CLI REPL loop. */
export async function startCLI(): Promise<void> {
  const settings = getSettings();

  // Initialize logger — this is the application entry point, the only place that should create log files
  const path = await import("node:path");
  initLogger(
    path.join(settings.dataDir, "logs/pegasus.log"),
    settings.logFormat,
    settings.logLevel,
  );

  const persona = loadPersona(settings.identity.personaPath);
  const models = new ModelRegistry(settings.llm);

  const mainAgent = new MainAgent({ models, persona, settings });
  await mainAgent.start();

  printBanner(persona.name, persona.role);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.setPrompt("> ");

  // Register reply callback — display all MainAgent replies
  mainAgent.onReply((msg) => {
    console.log(`\n  ${persona.name}: ${msg.text}\n`);
    rl.prompt();
  });

  rl.on("line", async (input) => {
    const trimmed = input.trim();

    // Skip empty input
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (trimmed.startsWith("/")) {
      const result = handleCommand(trimmed);
      if (result === "exit") {
        rl.close();
        await mainAgent.stop();
        return;
      }
      if (result === true) {
        rl.prompt();
        return;
      }
      // Not a recognized command — treat as regular input
    }

    try {
      // Fire-and-forget: MainAgent queues the message and replies via onReply
      mainAgent.send({
        text: trimmed,
        channel: { type: "cli", channelId: "main" },
      });
    } catch (err) {
      logger.error({ error: err }, "cli_error");
      console.log(`  [Error] ${(err as Error).message}\n`);
    }

    rl.prompt(); // Immediately accept next input
  });

  rl.prompt(); // Initial prompt
}

// Entry point: run CLI when this file is executed directly
if (import.meta.main) {
  startCLI().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
