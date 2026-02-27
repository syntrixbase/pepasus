/**
 * MCP (Model Context Protocol) integration — public API.
 */

export { MCPManager } from "./manager.ts";
export type { MCPServerConfig } from "./manager.ts";
export { wrapMCPTools } from "./wrap.ts";
export type { MCPAuthConfig, TransportAuthOptions } from "./auth/index.ts";
