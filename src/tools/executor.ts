/**
 * ToolExecutor - executes tools with validation, timeout, and event publishing.
 */

import type { Event } from "../events/index.ts";
import type { ToolResult, ToolContext } from "./types.ts";
import {
  ToolNotFoundError,
  ToolValidationError,
  ToolTimeoutError,
} from "./errors.ts";
import type { EventType } from "../events/types.ts";
import { createEvent } from "../events/types.ts";

export class ToolExecutor {
  constructor(
    private registry: { get(name: string): unknown; updateCallStats(name: string, duration: number, success: boolean): void },
    private bus: { emit(event: Event): void },
    private timeout: number = 30000,
  ) {}

  /**
   * Execute a tool with validation, timeout, and event publishing.
   */
  async execute(
    toolName: string,
    params: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    // Emit TOOL_CALL_REQUESTED event
    this.bus.emit(
      createEvent(400 as EventType, {
        source: "tools.executor",
        taskId: context.taskId,
        payload: { toolName, params },
      })
    );

    try {
      // Validate tool exists
      const tool = this.registry.get(toolName);
      if (!tool) {
        throw new ToolNotFoundError(toolName);
      }

      // Validate parameters
      const validatedParams = (tool as { parameters: { parse: (p: unknown) => unknown } }).parameters.parse(params);

      // Execute with timeout
      const result = await this.executeWithTimeout(
        tool as { execute: (params: unknown, context: ToolContext) => Promise<ToolResult>; name: string },
        validatedParams,
        context,
      );

      // Update call statistics
      this.registry.updateCallStats(
        toolName,
        result.durationMs ?? 0,
        result.success,
      );

      // Emit TOOL_CALL_COMPLETED event
      this.bus.emit(
        createEvent(410 as EventType, {
          source: "tools.executor",
          taskId: context.taskId,
          payload: { toolName, result: result.result, durationMs: result.durationMs },
        })
      );

      return result;
    } catch (error) {
      const errorResult: ToolResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };

      // Update call statistics
      const durationMs = Date.now() - startedAt;
      this.registry.updateCallStats(toolName, durationMs, false);

      // Emit TOOL_CALL_FAILED event
      this.bus.emit(
        createEvent(420 as EventType, {
          source: "tools.executor",
          taskId: context.taskId,
          payload: { toolName, error: errorResult.error },
        })
      );

      return errorResult;
    }
  }

  /**
   * Execute a tool with timeout protection.
   */
  private async executeWithTimeout(
    tool: { execute: (params: unknown, context: ToolContext) => Promise<ToolResult>; name: string },
    params: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const resultPromise = tool.execute(params, context);
    const timeoutPromise = new Promise<ToolResult>((_, reject) =>
      setTimeout(() => reject(new ToolTimeoutError(tool.name, this.timeout)), this.timeout),
    );

    try {
      return (await Promise.race([resultPromise, timeoutPromise])) as ToolResult;
    } catch (error) {
      // Re-throw ToolTimeoutError to be caught by outer try-catch
      if (error instanceof ToolTimeoutError) {
        throw error;
      }
      // Handle Zod validation errors
      if (error && typeof error === "object" && "issues" in error) {
        throw new ToolValidationError(tool.name, error);
      }
      throw error;
    }
  }
}
