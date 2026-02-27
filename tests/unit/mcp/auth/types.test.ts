/**
 * Unit tests for MCP auth types and Zod schemas.
 *
 * Covers:
 * - ClientCredentialsAuthSchema validation (required/optional fields, URL)
 * - DeviceCodeAuthSchema validation (required/optional fields, defaults, URL)
 * - MCPAuthConfigSchema discriminated union
 * - StoredTokenSchema validation
 * - TypeScript type exports (compile-time)
 */

import { describe, it, expect } from "bun:test";
import {
  ClientCredentialsAuthSchema,
  DeviceCodeAuthSchema,
  MCPAuthConfigSchema,
  StoredTokenSchema,
  type MCPAuthConfig,
  type ClientCredentialsAuthConfig,
  type DeviceCodeAuthConfig,
  type StoredToken,
  type DeviceAuthorizationResponse,
  type TransportAuthOptions,
  type OAuthClientProvider,
} from "../../../../src/mcp/auth/types.ts";

// ── ClientCredentialsAuthSchema ──

describe("ClientCredentialsAuthSchema", () => {
  it("should accept minimal valid config", () => {
    const result = ClientCredentialsAuthSchema.parse({
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
    });
    expect(result.type).toBe("client_credentials");
    expect(result.clientId).toBe("my-client");
    expect(result.clientSecret).toBe("my-secret");
    expect(result.tokenUrl).toBeUndefined();
    expect(result.scope).toBeUndefined();
  });

  it("should accept config with all optional fields", () => {
    const result = ClientCredentialsAuthSchema.parse({
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
      tokenUrl: "https://auth.example.com/token",
      scope: "read write",
    });
    expect(result.tokenUrl).toBe("https://auth.example.com/token");
    expect(result.scope).toBe("read write");
  });

  it("should reject missing clientId", () => {
    expect(() =>
      ClientCredentialsAuthSchema.parse({
        type: "client_credentials",
        clientSecret: "my-secret",
      }),
    ).toThrow();
  });

  it("should reject missing clientSecret", () => {
    expect(() =>
      ClientCredentialsAuthSchema.parse({
        type: "client_credentials",
        clientId: "my-client",
      }),
    ).toThrow();
  });

  it("should reject missing type", () => {
    expect(() =>
      ClientCredentialsAuthSchema.parse({
        clientId: "my-client",
        clientSecret: "my-secret",
      }),
    ).toThrow();
  });

  it("should reject invalid tokenUrl", () => {
    expect(() =>
      ClientCredentialsAuthSchema.parse({
        type: "client_credentials",
        clientId: "my-client",
        clientSecret: "my-secret",
        tokenUrl: "not-a-url",
      }),
    ).toThrow();
  });
});

// ── DeviceCodeAuthSchema ──

describe("DeviceCodeAuthSchema", () => {
  it("should accept minimal valid config with defaults", () => {
    const result = DeviceCodeAuthSchema.parse({
      type: "device_code",
      clientId: "my-client",
      deviceAuthorizationUrl: "https://auth.example.com/device",
      tokenUrl: "https://auth.example.com/token",
    });
    expect(result.type).toBe("device_code");
    expect(result.clientId).toBe("my-client");
    expect(result.deviceAuthorizationUrl).toBe("https://auth.example.com/device");
    expect(result.tokenUrl).toBe("https://auth.example.com/token");
    expect(result.clientSecret).toBeUndefined();
    expect(result.scope).toBeUndefined();
    expect(result.pollIntervalSeconds).toBe(5);
    expect(result.timeoutSeconds).toBe(300);
  });

  it("should accept config with all optional fields", () => {
    const result = DeviceCodeAuthSchema.parse({
      type: "device_code",
      clientId: "my-client",
      deviceAuthorizationUrl: "https://auth.example.com/device",
      tokenUrl: "https://auth.example.com/token",
      clientSecret: "optional-secret",
      scope: "openid profile",
      pollIntervalSeconds: 10,
      timeoutSeconds: 600,
    });
    expect(result.clientSecret).toBe("optional-secret");
    expect(result.scope).toBe("openid profile");
    expect(result.pollIntervalSeconds).toBe(10);
    expect(result.timeoutSeconds).toBe(600);
  });

  it("should reject missing clientId", () => {
    expect(() =>
      DeviceCodeAuthSchema.parse({
        type: "device_code",
        deviceAuthorizationUrl: "https://auth.example.com/device",
        tokenUrl: "https://auth.example.com/token",
      }),
    ).toThrow();
  });

  it("should reject missing deviceAuthorizationUrl", () => {
    expect(() =>
      DeviceCodeAuthSchema.parse({
        type: "device_code",
        clientId: "my-client",
        tokenUrl: "https://auth.example.com/token",
      }),
    ).toThrow();
  });

  it("should reject missing tokenUrl", () => {
    expect(() =>
      DeviceCodeAuthSchema.parse({
        type: "device_code",
        clientId: "my-client",
        deviceAuthorizationUrl: "https://auth.example.com/device",
      }),
    ).toThrow();
  });

  it("should reject invalid deviceAuthorizationUrl", () => {
    expect(() =>
      DeviceCodeAuthSchema.parse({
        type: "device_code",
        clientId: "my-client",
        deviceAuthorizationUrl: "not-a-url",
        tokenUrl: "https://auth.example.com/token",
      }),
    ).toThrow();
  });

  it("should reject invalid tokenUrl", () => {
    expect(() =>
      DeviceCodeAuthSchema.parse({
        type: "device_code",
        clientId: "my-client",
        deviceAuthorizationUrl: "https://auth.example.com/device",
        tokenUrl: "not-a-url",
      }),
    ).toThrow();
  });
});

// ── MCPAuthConfigSchema (discriminated union) ──

describe("MCPAuthConfigSchema", () => {
  it("should accept client_credentials config", () => {
    const result = MCPAuthConfigSchema.parse({
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(result.type).toBe("client_credentials");
  });

  it("should accept device_code config", () => {
    const result = MCPAuthConfigSchema.parse({
      type: "device_code",
      clientId: "id",
      deviceAuthorizationUrl: "https://auth.example.com/device",
      tokenUrl: "https://auth.example.com/token",
    });
    expect(result.type).toBe("device_code");
  });

  it("should reject unknown auth type", () => {
    expect(() =>
      MCPAuthConfigSchema.parse({
        type: "api_key",
        key: "abc123",
      }),
    ).toThrow();
  });
});

// ── StoredTokenSchema ──

describe("StoredTokenSchema", () => {
  it("should accept minimal valid token", () => {
    const result = StoredTokenSchema.parse({
      accessToken: "tok_abc123",
      tokenType: "Bearer",
      obtainedAt: 1700000000000,
      authType: "client_credentials",
    });
    expect(result.accessToken).toBe("tok_abc123");
    expect(result.tokenType).toBe("Bearer");
    expect(result.obtainedAt).toBe(1700000000000);
    expect(result.authType).toBe("client_credentials");
    expect(result.refreshToken).toBeUndefined();
    expect(result.scope).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });

  it("should accept token with all optional fields", () => {
    const result = StoredTokenSchema.parse({
      accessToken: "tok_abc123",
      tokenType: "Bearer",
      obtainedAt: 1700000000000,
      authType: "device_code",
      refreshToken: "ref_xyz789",
      scope: "read write",
      expiresAt: 1700003600000,
    });
    expect(result.refreshToken).toBe("ref_xyz789");
    expect(result.scope).toBe("read write");
    expect(result.expiresAt).toBe(1700003600000);
    expect(result.authType).toBe("device_code");
  });

  it("should reject token without accessToken", () => {
    expect(() =>
      StoredTokenSchema.parse({
        tokenType: "Bearer",
        obtainedAt: 1700000000000,
        authType: "client_credentials",
      }),
    ).toThrow();
  });

  it("should reject token without tokenType", () => {
    expect(() =>
      StoredTokenSchema.parse({
        accessToken: "tok_abc123",
        obtainedAt: 1700000000000,
        authType: "client_credentials",
      }),
    ).toThrow();
  });

  it("should reject token without obtainedAt", () => {
    expect(() =>
      StoredTokenSchema.parse({
        accessToken: "tok_abc123",
        tokenType: "Bearer",
        authType: "client_credentials",
      }),
    ).toThrow();
  });

  it("should reject token with invalid authType", () => {
    expect(() =>
      StoredTokenSchema.parse({
        accessToken: "tok_abc123",
        tokenType: "Bearer",
        obtainedAt: 1700000000000,
        authType: "api_key",
      }),
    ).toThrow();
  });
});

// ── Type exports (compile-time checks) ──

describe("Type exports", () => {
  it("should export MCPAuthConfig type usable with parsed values", () => {
    const config: MCPAuthConfig = MCPAuthConfigSchema.parse({
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(config).toBeDefined();
  });

  it("should export ClientCredentialsAuthConfig type", () => {
    const config: ClientCredentialsAuthConfig = ClientCredentialsAuthSchema.parse({
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(config.type).toBe("client_credentials");
  });

  it("should export DeviceCodeAuthConfig type", () => {
    const config: DeviceCodeAuthConfig = DeviceCodeAuthSchema.parse({
      type: "device_code",
      clientId: "id",
      deviceAuthorizationUrl: "https://auth.example.com/device",
      tokenUrl: "https://auth.example.com/token",
    });
    expect(config.type).toBe("device_code");
  });

  it("should export StoredToken type", () => {
    const token: StoredToken = StoredTokenSchema.parse({
      accessToken: "tok",
      tokenType: "Bearer",
      obtainedAt: 1700000000000,
      authType: "client_credentials",
    });
    expect(token.accessToken).toBe("tok");
  });

  it("should export DeviceAuthorizationResponse interface", () => {
    const response: DeviceAuthorizationResponse = {
      device_code: "dc_abc",
      user_code: "ABCD-1234",
      verification_uri: "https://example.com/activate",
      expires_in: 600,
    };
    expect(response.device_code).toBe("dc_abc");
    expect(response.user_code).toBe("ABCD-1234");
    expect(response.verification_uri).toBe("https://example.com/activate");
    expect(response.verification_uri_complete).toBeUndefined();
    expect(response.interval).toBeUndefined();
  });

  it("should export OAuthClientProvider interface", () => {
    // Minimal implementation to verify interface shape
    const provider: OAuthClientProvider = {
      get redirectUrl() { return "https://example.com/callback"; },
      get clientMetadata() {
        return { client_id: "test", redirect_uris: ["https://example.com/callback"] };
      },
      clientInformation() { return { client_id: "test", client_secret: "secret" }; },
      tokens() { return { access_token: "tok", token_type: "Bearer" }; },
      saveTokens(_tokens) { /* no-op */ },
      redirectToAuthorization(_url) { /* no-op */ },
      saveCodeVerifier(_verifier) { /* no-op */ },
      codeVerifier() { return "verifier"; },
    };
    expect(provider.redirectUrl).toBe("https://example.com/callback");
  });

  it("should support TransportAuthOptions discriminated union", () => {
    // authProvider variant
    const opt1: TransportAuthOptions = {
      mode: "authProvider",
      authProvider: {
        get redirectUrl() { return "https://example.com/callback"; },
        get clientMetadata() {
          return { client_id: "test", redirect_uris: ["https://example.com/callback"] };
        },
        clientInformation() { return { client_id: "test" }; },
        tokens() { return { access_token: "tok", token_type: "Bearer" }; },
        saveTokens(_tokens) {},
        redirectToAuthorization(_url) {},
        saveCodeVerifier(_verifier) {},
        codeVerifier() { return "v"; },
      },
    };
    expect(opt1.mode).toBe("authProvider");
    expect(opt1.authProvider).toBeDefined();

    // requestInit variant
    const opt2: TransportAuthOptions = {
      mode: "requestInit",
      requestInit: {
        headers: { Authorization: "Bearer tok" },
      },
    };
    expect(opt2.mode).toBe("requestInit");

    // none variant
    const opt3: TransportAuthOptions = { mode: "none" };
    expect(opt3.mode).toBe("none");
  });
});
