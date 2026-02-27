/**
 * CLIAdapter — Interactive terminal channel adapter.
 *
 * Uses readline for terminal I/O. Extracted from cli.ts to implement
 * the ChannelAdapter interface for multi-channel routing.
 */
import { createInterface, type Interface as ReadlineInterface } from "readline";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "./types.ts";

/** Handle slash commands. Returns true if command was handled, "exit" to quit. */
function handleCommand(input: string): boolean | "exit" {
  const cmd = input.trim().toLowerCase();

  if (cmd === "/exit" || cmd === "/quit") {
    console.log("\n\u{1f44b} Goodbye!\n");
    return "exit";
  }

  if (cmd === "/help") {
    console.log("");
    console.log("  Commands:");
    console.log("    /help   \u2014 Show this help message");
    console.log("    /exit   \u2014 Exit the REPL");
    console.log("");
    return true;
  }

  return false;
}

export class CLIAdapter implements ChannelAdapter {
  readonly type = "cli";
  private rl!: ReadlineInterface;
  private personaName: string;
  private onExit?: () => Promise<void>;

  constructor(personaName: string, onExit?: () => Promise<void>) {
    this.personaName = personaName;
    this.onExit = onExit;
  }

  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.rl.setPrompt("> ");

    this.rl.on("line", async (input) => {
      const trimmed = input.trim();

      // Skip empty input
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Handle slash commands
      if (trimmed.startsWith("/")) {
        const result = handleCommand(trimmed);
        if (result === "exit") {
          this.rl.close();
          if (this.onExit) {
            await this.onExit();
          }
          return;
        }
        if (result === true) {
          this.rl.prompt();
          return;
        }
        // Not a recognized command — treat as regular input
      }

      agent.send({
        text: trimmed,
        channel: { type: "cli", channelId: "main" },
      });

      this.rl.prompt();
    });

    this.rl.prompt();
  }

  async deliver(message: OutboundMessage): Promise<void> {
    console.log(`\n  ${this.personaName}: ${message.text}\n`);
    this.rl.prompt();
  }

  async stop(): Promise<void> {
    this.rl.close();
  }
}
