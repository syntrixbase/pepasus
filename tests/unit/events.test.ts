import { describe, expect, test } from "bun:test";
import {
  EventType,
  createEvent,
  effectivePriority,
  deriveEvent,
} from "@pegasus/events/types.ts";
import { EventBus } from "@pegasus/events/bus.ts";
import type { Event } from "@pegasus/events/types.ts";

// ── EventType ────────────────────────────────────

describe("EventType", () => {
  test("system events have lower values (higher priority) than external input", () => {
    expect(EventType.SYSTEM_STARTED).toBeLessThan(EventType.MESSAGE_RECEIVED);
  });

  test("segments are correctly ranged", () => {
    expect(EventType.HEARTBEAT).toBeGreaterThanOrEqual(0);
    expect(EventType.HEARTBEAT).toBeLessThan(100);

    expect(EventType.MESSAGE_RECEIVED).toBeGreaterThanOrEqual(100);
    expect(EventType.MESSAGE_RECEIVED).toBeLessThan(200);

    expect(EventType.TASK_CREATED).toBeGreaterThanOrEqual(200);
    expect(EventType.TASK_CREATED).toBeLessThan(300);

    expect(EventType.PERCEIVE_DONE).toBeGreaterThanOrEqual(300);
    expect(EventType.PERCEIVE_DONE).toBeLessThan(400);

    expect(EventType.TOOL_CALL_REQUESTED).toBeGreaterThanOrEqual(400);
    expect(EventType.TOOL_CALL_REQUESTED).toBeLessThan(500);
  });
});

// ── Event ────────────────────────────────────────

describe("Event", () => {
  test("create with defaults", () => {
    const e = createEvent(EventType.MESSAGE_RECEIVED);
    expect(e.type).toBe(EventType.MESSAGE_RECEIVED);
    expect(e.id).toBeTruthy();
    expect(e.timestamp).toBeGreaterThan(0);
    expect(e.taskId).toBeNull();
    expect(e.payload).toEqual({});
  });

  test("is frozen (immutable)", () => {
    const e = createEvent(EventType.MESSAGE_RECEIVED);
    expect(() => {
      (e as unknown as Record<string, unknown>)["type"] = EventType.HEARTBEAT;
    }).toThrow();
  });

  test("effectivePriority defaults to EventType value", () => {
    const e = createEvent(EventType.MESSAGE_RECEIVED);
    expect(effectivePriority(e)).toBe(100);
  });

  test("effectivePriority uses custom priority when set", () => {
    const e = createEvent(EventType.MESSAGE_RECEIVED, { priority: 1 });
    expect(effectivePriority(e)).toBe(1);
  });

  test("deriveEvent preserves causality chain", () => {
    const parent = createEvent(EventType.MESSAGE_RECEIVED, {
      source: "user",
      taskId: "task-1",
    });
    const child = deriveEvent(parent, EventType.PERCEIVE_DONE, {
      payload: { result: "ok" },
    });
    expect(child.type).toBe(EventType.PERCEIVE_DONE);
    expect(child.taskId).toBe("task-1");
    expect(child.source).toBe("user");
    expect(child.parentEventId).toBe(parent.id);
    expect(child.payload).toEqual({ result: "ok" });
  });
});

// ── EventBus ─────────────────────────────────────

describe("EventBus", () => {
  test("start and stop", async () => {
    const bus = new EventBus();
    await bus.start();
    expect(bus.isRunning).toBe(true);
    await bus.stop();
    expect(bus.isRunning).toBe(false);
  });

  test("emit and handle", async () => {
    const bus = new EventBus();
    const received: Event[] = [];

    bus.subscribe(EventType.MESSAGE_RECEIVED, async (e) => {
      received.push(e);
    });
    await bus.start();

    await bus.emit(createEvent(EventType.MESSAGE_RECEIVED, { payload: { text: "hello" } }));
    await sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload["text"]).toBe("hello");
    await bus.stop();
  });

  test("wildcard handler catches all events", async () => {
    const bus = new EventBus();
    const received: Event[] = [];

    bus.subscribe(null, async (e) => {
      received.push(e);
    });
    await bus.start();

    await bus.emit(createEvent(EventType.MESSAGE_RECEIVED));
    await bus.emit(createEvent(EventType.HEARTBEAT));
    await sleep(50);

    expect(received.length).toBeGreaterThanOrEqual(2);
    await bus.stop();
  });

  test("priority ordering", async () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.subscribe(null, async (e) => {
      order.push(e.type);
    });

    // Queue events BEFORE starting — they accumulate in priority order
    await bus.emit(createEvent(EventType.MESSAGE_RECEIVED)); // priority 100
    await bus.emit(createEvent(EventType.SYSTEM_STARTED));    // priority 0

    await bus.start();
    await sleep(50);
    await bus.stop();

    const sysIdx = order.indexOf(EventType.SYSTEM_STARTED);
    const msgIdx = order.indexOf(EventType.MESSAGE_RECEIVED);
    if (sysIdx >= 0 && msgIdx >= 0) {
      expect(sysIdx).toBeLessThan(msgIdx);
    }
  });

  test("handler error does not crash bus", async () => {
    const bus = new EventBus();
    const goodReceived: Event[] = [];

    bus.subscribe(EventType.MESSAGE_RECEIVED, async () => {
      throw new Error("boom");
    });
    bus.subscribe(EventType.MESSAGE_RECEIVED, async (e) => {
      goodReceived.push(e);
    });

    await bus.start();
    await bus.emit(createEvent(EventType.MESSAGE_RECEIVED));
    await sleep(50);

    expect(goodReceived).toHaveLength(1);
    expect(bus.isRunning).toBe(true);
    await bus.stop();
  });

  test("history recording", async () => {
    const bus = new EventBus({ keepHistory: true });
    await bus.start();

    await bus.emit(createEvent(EventType.MESSAGE_RECEIVED));
    await sleep(50);

    expect(bus.history.length).toBeGreaterThanOrEqual(1);
    expect(bus.history[0]!.type).toBe(EventType.MESSAGE_RECEIVED);
    await bus.stop();
  });
});

// ── Helper ───────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
