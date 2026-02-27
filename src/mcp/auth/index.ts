/**
 * MCP Auth — public API.
 */

export { MCPAuthConfigSchema, StoredTokenSchema } from "./types.ts";
export type {
  MCPAuthConfig,
  ClientCredentialsAuthConfig,
  DeviceCodeAuthConfig,
  StoredToken,
  TransportAuthOptions,
  DeviceAuthorizationResponse,
  OAuthClientProvider,
} from "./types.ts";
export { TokenStore } from "./token-store.ts";
export { executeDeviceCodeFlow, DeviceCodeAuthError } from "./device-code.ts";
export { resolveTransportAuth, refreshToken } from "./provider-factory.ts";
export { TokenRefreshMonitor } from "./refresh-monitor.ts";
export type { AuthEvent } from "./refresh-monitor.ts";
