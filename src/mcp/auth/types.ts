/**
 * MCP Auth — types and Zod schemas.
 *
 * Defines the configuration shapes for OAuth-based authentication
 * on MCP remote transports (SSE / StreamableHTTP).
 *
 * Two auth flows are supported:
 * - client_credentials: machine-to-machine OAuth2
 * - device_code: interactive device authorization (RFC 8628)
 */

import { z } from "zod";

// ── Auth Config Schemas ──

export const ClientCredentialsAuthSchema = z.object({
  type: z.literal("client_credentials"),
  clientId: z.string(),
  clientSecret: z.string(),
  tokenUrl: z.string().url().optional(),
  scope: z.string().optional(),
});

export const DeviceCodeAuthSchema = z.object({
  type: z.literal("device_code"),
  clientId: z.string(),
  deviceAuthorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  pollIntervalSeconds: z.number().default(5),
  timeoutSeconds: z.number().default(300),
});

export const MCPAuthConfigSchema = z.discriminatedUnion("type", [
  ClientCredentialsAuthSchema,
  DeviceCodeAuthSchema,
]);

// ── Stored Token Schema ──

export const StoredTokenSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  obtainedAt: z.number(),
  authType: z.enum(["client_credentials", "device_code"]),
  refreshToken: z.string().optional(),
  scope: z.string().optional(),
  expiresAt: z.number().optional(),
});

// ── Inferred Types ──

export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;
export type ClientCredentialsAuthConfig = z.infer<typeof ClientCredentialsAuthSchema>;
export type DeviceCodeAuthConfig = z.infer<typeof DeviceCodeAuthSchema>;
export type StoredToken = z.infer<typeof StoredTokenSchema>;

// ── Interfaces ──

/** RFC 8628 device authorization response. */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/**
 * Minimal OAuthClientProvider interface compatible with
 * @modelcontextprotocol/sdk's auth transport options.
 */
export interface OAuthClientProvider {
  get redirectUrl(): string;
  get clientMetadata(): { client_id: string; redirect_uris: string[] };
  clientInformation(): { client_id: string; client_secret?: string };
  tokens(): { access_token: string; token_type: string } | undefined;
  saveTokens(tokens: { access_token: string; token_type: string }): void;
  redirectToAuthorization(url: URL | string): void;
  saveCodeVerifier(verifier: string): void;
  codeVerifier(): string;
}

/**
 * Transport auth options union.
 * - authProvider: full OAuth flow via OAuthClientProvider
 * - requestInit: static headers (e.g. pre-set Bearer token)
 * - empty: no auth
 */
export type TransportAuthOptions = {
  authProvider?: OAuthClientProvider;
  requestInit?: RequestInit;
};
