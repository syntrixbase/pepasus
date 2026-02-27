/**
 * MCPManager — MCP server connection lifecycle manager.
 *
 * Owns Client instances for each configured MCP server.
 * Supports stdio (local subprocess) and SSE/StreamableHTTP transports.
 * Does NOT know about Pegasus Tool interface — that's the wrapper's job.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("mcp.manager");

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  enabled: boolean;
}

export class MCPManager {
  private clients = new Map<string, Client>();

  /**
   * Connect to all enabled MCP servers.
   * Graceful degradation: if a server fails, log warning and continue.
   */
  async connectAll(configs: MCPServerConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled);
    for (const config of enabled) {
      try {
        await this.connect(config);
        logger.info({ server: config.name, transport: config.transport }, "mcp_server_connected");
      } catch (err) {
        logger.warn(
          { server: config.name, error: err instanceof Error ? err.message : String(err) },
          "mcp_server_connect_failed",
        );
        // Graceful degradation — continue without this server
      }
    }
  }

  /**
   * Connect to a single MCP server.
   */
  private async connect(config: MCPServerConfig): Promise<void> {
    const client = new Client({ name: "pegasus", version: "0.1.0" });

    let transport;
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP server "${config.name}": stdio transport requires 'command'`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });
    } else {
      // SSE transport with StreamableHTTP fallback
      if (!config.url) {
        throw new Error(`MCP server "${config.name}": sse transport requires 'url'`);
      }
      try {
        transport = new StreamableHTTPClientTransport(new URL(config.url));
        await client.connect(transport);
        this.clients.set(config.name, client);
        return;
      } catch {
        // StreamableHTTP failed, fall back to SSE
        logger.debug({ server: config.name }, "streamable_http_failed_falling_back_to_sse");
        transport = new SSEClientTransport(new URL(config.url));
      }
    }

    await client.connect(transport);
    this.clients.set(config.name, client);
  }

  /**
   * Disconnect a single MCP server.
   */
  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.close();
      } catch (err) {
        logger.warn(
          { server: name, error: err instanceof Error ? err.message : String(err) },
          "mcp_server_disconnect_error",
        );
      }
      this.clients.delete(name);
    }
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.clients.keys());
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /**
   * List tools from a connected MCP server.
   */
  async listTools(name: string): Promise<McpTool[]> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`MCP server "${name}" is not connected`);
    }
    const result = await client.listTools();
    return result.tools;
  }

  /**
   * Call a tool on a connected MCP server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    return await client.callTool({ name: toolName, arguments: args }) as CallToolResult;
  }

  /**
   * Get a client by server name (for testing/debugging).
   */
  getClient(name: string): Client | undefined {
    return this.clients.get(name);
  }

  /**
   * Get all connected server names.
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
