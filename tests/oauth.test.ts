import type { IncomingMessage } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { loadOAuthConfig, OAuthAccess, type OAuthConfig } from "../src/oauth.js";

const config: OAuthConfig = {
  issuer: "https://tenant.auth0.com/", resource: "https://mcp.example.com/mcp",
  scope: "servicetitan:read", allowedSubjects: ["auth0|Alice"], allowedClientIds: ["chatgpt-client"],
};
const env = {
  ST_MCP_AUTH_MODE: "oauth", ST_OAUTH_ISSUER: config.issuer, ST_OAUTH_RESOURCE: config.resource,
  ST_OAUTH_ALLOWED_SUBJECTS: config.allowedSubjects.join(","), ST_OAUTH_ALLOWED_CLIENT_IDS: config.allowedClientIds.join(","),
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let access: OAuthAccess;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  access = new OAuthAccess(config, createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "one", alg: "RS256" }] }));
});
afterEach(() => vi.unstubAllGlobals());
async function token(overrides: Record<string, unknown> = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: config.issuer, aud: config.resource, sub: "auth0|Alice", azp: "chatgpt-client",
    scope: config.scope, iat: now, exp: now + 300, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "one" }).sign(key);
}
const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;

describe("OAuth resource server", () => {
  it("requires complete explicit configuration without wildcard allowlists", () => {
    expect(loadOAuthConfig(env)).toEqual(config);
    for (const name of Object.keys(env).filter(k => k !== "ST_MCP_AUTH_MODE")) {
      expect(() => loadOAuthConfig({ ...env, [name]: "" })).toThrow();
    }
    expect(() => loadOAuthConfig({ ...env, ST_OAUTH_ALLOWED_SUBJECTS: "*" })).toThrow();
    expect(() => loadOAuthConfig({ ...env, ST_OAUTH_ALLOWED_CLIENT_IDS: ",," })).toThrow();
    expect(() => loadOAuthConfig({ ...env, ST_OAUTH_RESOURCE: "http://localhost/mcp" })).toThrow();
    expect(() => loadOAuthConfig({ ...env, ST_MCP_AUTH_MODE: "typo" })).toThrow();
    expect(loadOAuthConfig({})).toBeNull();
  });
  it("verifies access tokens and produces only verified identity context", async () => {
    const auth = await access.authenticate(request(await token()));
    expect(auth.extra).toEqual({ sub: "auth0|Alice", issuer: config.issuer });
    expect(auth.clientId).toBe("chatgpt-client");
    expect(auth.scopes).toContain(config.scope);
  });
  it("supports the Auth0 RFC9068 client_id claim", async () => {
    expect((await access.authenticate(request(await token({ azp: undefined, client_id: "chatgpt-client" })))).clientId).toBe("chatgpt-client");
  });
  it.each([
    { iss: "https://attacker.example/" }, { aud: "other-api" }, { exp: 1 }, { exp: undefined },
    { iat: undefined }, { sub: undefined }, { nbf: Math.floor(Date.now() / 1000) + 300 },
  ])("rejects invalid token claims %j", async claims => {
    await expect(access.authenticate(request(await token(claims)))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects signatures from an untrusted key", async () => {
    const other = await generateKeyPair("RS256");
    await expect(access.authenticate(request(await token({}, other.privateKey)))).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { sub: "auth0|Mallory" }, { sub: "auth0|alice" }, { azp: "another-client" }, { azp: undefined },
    { client_id: "different-client" }, { scope: "openid profile" },
  ])("rejects unauthorized users, clients, and scopes %j", async claims => {
    await expect(access.authenticate(request(await token(claims)))).rejects.toMatchObject({ status: 403 });
  });
  it("rejects shared API keys and spoofed identity headers", async () => {
    for (const headers of [ {}, { "x-api-key": "old-key" }, { authorization: "Bearer old-key" },
      { "x-user-id": "auth0|Alice", "x-user-email": "alice@example.com" } ]) {
      await expect(access.authenticate({ headers } as IncomingMessage)).rejects.toMatchObject({ status: 401 });
    }
  });
  it("binds sessions to issuer, subject, and client, but permits token refresh", async () => {
    const auth = await access.authenticate(request(await token()));
    expect(access.sessionOwner(auth)).toBe(access.sessionOwner({ ...auth, token: "refreshed" }));
    expect(access.sessionOwner(auth)).not.toBe(access.sessionOwner({ ...auth, clientId: "other" }));
    expect(access.sessionOwner(auth)).not.toBe(access.sessionOwner({ ...auth, extra: { ...auth.extra, sub: "other" } }));
  });
  it("publishes canonical resource metadata and an OAuth challenge", () => {
    expect(access.metadata()).toMatchObject({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: [config.scope] });
    expect(access.challenge()).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"');
    expect(access.challenge()).toContain('error="invalid_token"');
  });
  it("validates provider discovery and rejects issuer/PKCE/key-host mismatches", async () => {
    const metadata = { issuer: config.issuer, jwks_uri: config.issuer + ".well-known/jwks.json",
      authorization_endpoint: config.issuer + "authorize", token_endpoint: config.issuer + "oauth/token",
      code_challenge_methods_supported: ["S256"] };
    for (const update of [{ issuer: "https://wrong.example/" }, { code_challenge_methods_supported: ["plain"] }, { jwks_uri: "https://attacker.example/keys" }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...metadata, ...update }) }));
      await expect(OAuthAccess.discover(config)).rejects.toThrow();
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => metadata }));
    await expect(OAuthAccess.discover(config)).resolves.toBeInstanceOf(OAuthAccess);
  });
});
