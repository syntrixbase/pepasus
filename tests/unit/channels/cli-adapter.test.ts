/**
 * Tests for CLIAdapter — Terminal channel adapter.
 *
 * Uses PassThrough streams to simulate stdin/stdout without real terminal I/O.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { CLIAdapter } from "@pegasus/channels/cli-adapter.ts";
import type { InboundMessage, OutboundMessage } from "@pegasus/channels/types.ts";
import { PassThrough } from "stream";

describe("CLIAdapter", () => {
  const adapters: CLIAdapter[] = [];

  afterEach(async () => {
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch {
        // ignore
      }
    }
    adapters.length = 0;
  });

  it("should have type 'cli'", () => {
    const adapter = new CLIAdapter("TestBot");
    expect(adapter.type).toBe("cli");
  });

  it("should implement ChannelAdapter interface", () => {
    const adapter = new CLIAdapter("TestBot");
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("cli");
  });

  it("should accept optional onExit callback", () => {
    const adapter = new CLIAdapter("TestBot", async () => {});
    expect(adapter.type).toBe("cli");
  });

  it("should start and create readline interface", async () => {
    const adapter = new CLIAdapter("TestBot");
    adapters.push(adapter);

    // Patch stdin to prevent hanging
    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    try {
      await adapter.start({
        send: () => {},
      });
      // If we got here, start() didn't throw
      expect(true).toBe(true);
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should send regular text input as InboundMessage", async () => {
    const adapter = new CLIAdapter("TestBot");
    adapters.push(adapter);

    const received: InboundMessage[] = [];
    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    try {
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      // Simulate user typing a line
      mockStdin.write("hello world\n");
      await Bun.sleep(50);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("hello world");
      expect(received[0]!.channel.type).toBe("cli");
      expect(received[0]!.channel.channelId).toBe("main");
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should skip empty input", async () => {
    const adapter = new CLIAdapter("TestBot");
    adapters.push(adapter);

    const received: InboundMessage[] = [];
    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    try {
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      // Empty lines should be skipped
      mockStdin.write("\n");
      mockStdin.write("   \n");
      await Bun.sleep(50);

      expect(received).toHaveLength(0);
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should handle /help command without sending to agent", async () => {
    const adapter = new CLIAdapter("TestBot");
    adapters.push(adapter);

    const received: InboundMessage[] = [];
    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    // Capture console.log
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));

    try {
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      mockStdin.write("/help\n");
      await Bun.sleep(50);

      // Help should not be sent to the agent
      expect(received).toHaveLength(0);
      // Help output should be printed
      expect(logged.some((l) => l.includes("/help"))).toBe(true);
    } finally {
      console.log = origLog;
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should handle /exit command and call onExit", async () => {
    let exitCalled = false;
    const adapter = new CLIAdapter("TestBot", async () => {
      exitCalled = true;
    });
    adapters.push(adapter);

    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    // Suppress console output
    const origLog = console.log;
    console.log = () => {};

    try {
      await adapter.start({
        send: () => {},
      });

      mockStdin.write("/exit\n");
      await Bun.sleep(100);

      expect(exitCalled).toBe(true);
    } finally {
      console.log = origLog;
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should handle /quit as alias for /exit", async () => {
    let exitCalled = false;
    const adapter = new CLIAdapter("TestBot", async () => {
      exitCalled = true;
    });
    adapters.push(adapter);

    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const origLog = console.log;
    console.log = () => {};

    try {
      await adapter.start({
        send: () => {},
      });

      mockStdin.write("/quit\n");
      await Bun.sleep(100);

      expect(exitCalled).toBe(true);
    } finally {
      console.log = origLog;
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should treat unrecognized slash commands as regular input", async () => {
    const adapter = new CLIAdapter("TestBot");
    adapters.push(adapter);

    const received: InboundMessage[] = [];
    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    try {
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      mockStdin.write("/unknown_command\n");
      await Bun.sleep(50);

      // Unrecognized command should be sent as regular text
      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("/unknown_command");
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("deliver should print persona name and message text", async () => {
    const adapter = new CLIAdapter("Aria");
    adapters.push(adapter);

    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));

    try {
      await adapter.start({ send: () => {} });

      const msg: OutboundMessage = {
        text: "Hello user!",
        channel: { type: "cli", channelId: "main" },
      };

      await adapter.deliver(msg);

      expect(logged.some((l) => l.includes("Aria") && l.includes("Hello user!"))).toBe(
        true,
      );
    } finally {
      console.log = origLog;
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("should handle exit without onExit callback", async () => {
    const adapter = new CLIAdapter("TestBot"); // no onExit
    adapters.push(adapter);

    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const origLog = console.log;
    console.log = () => {};

    try {
      await adapter.start({ send: () => {} });

      // Should not crash when no onExit is set
      mockStdin.write("/exit\n");
      await Bun.sleep(100);
    } finally {
      console.log = origLog;
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });

  it("stop should close readline", async () => {
    const adapter = new CLIAdapter("TestBot");
    adapters.push(adapter);

    const mockStdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    try {
      await adapter.start({ send: () => {} });
      // Should not throw
      await adapter.stop();
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
      mockStdin.destroy();
    }
  });
});
