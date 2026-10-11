import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { OAuthAccess, type OAuthConfig } from "../src/oauth.js";

const config: OAuthConfig = { issuer: "https://tenant.auth0.com/", resource: "https://mcp.example.com/mcp",
  scope: "servicetitan:read", allowedSubjects: ["auth0|Alice", "auth0|Bob"], allowedClientIds: ["client"] };
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let access: OAuthAccess;
let counter = 0;
const handled = vi.fn();

class Response {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  setHeader(k: string, v: unknown) { this.headers[k.toLowerCase()] = v; }
  writeHead(code: number, headers: Record<string, unknown> = {}) {
    this.statusCode = code;
    for (const [k,v] of Object.entries(headers)) this.setHeader(k,v);
    this.headersSent = true;
  }
  end(body = "") { this.body += body; this.writableEnded = true; }
}
async function dispatch(method: string, url: string, headers: Record<string,string> = {}, body?: unknown) {
  const req = { method, url, headers: { host: "mcp.example.com", ...headers },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } } as IncomingMessage;
  const res = new Response();
  await handler(req, res as unknown as ServerResponse);
  return res;
}
async function bearer(sub = "auth0|Alice", scope = config.scope) {
  const t = await new SignJWT({ azp: "client", scope }).setSubject(sub).setIssuer(config.issuer)
    .setAudience(config.resource).setIssuedAt().setExpirationTime("5m")
    .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey);
  return { authorization: `Bearer ${t}` };
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  access = new OAuthAccess(config, createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }] }));
  vi.stubEnv("ST_MCP_AUTH_MODE", "oauth");
  vi.stubEnv("ST_OAUTH_ISSUER", config.issuer);
  vi.stubEnv("ST_OAUTH_RESOURCE", config.resource);
  vi.stubEnv("ST_OAUTH_ALLOWED_SUBJECTS", config.allowedSubjects.join(","));
  vi.stubEnv("ST_OAUTH_ALLOWED_CLIENT_IDS", "client");
  vi.stubEnv("ST_MCP_API_KEY", "legacy-key");
  for (const k of ["ST_CLIENT_ID","ST_CLIENT_SECRET","ST_APP_KEY","ST_TENANT_ID"]) vi.stubEnv(k,"test");
  vi.stubEnv("ST_LOG_LEVEL","error");
  vi.spyOn(OAuthAccess, "discover").mockResolvedValue(access);
  vi.doMock("node:http", async () => ({ ...await vi.importActual("node:http"),
    createServer: vi.fn((h) => { handler = h; return { listen: vi.fn(), close: vi.fn() }; }) }));
  vi.doMock("../src/domains/loader.js", () => ({ loadDomainModules: async () => {} }));
  vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
    registerTool = vi.fn(); async connect() {} async close() {}
  } }));
  vi.doMock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
    StreamableHTTPServerTransport: class {
      sessionId?: string;
      constructor(private options: { onsessioninitialized: (id: string) => void }) {}
      async close() {}
      async handleRequest(req: IncomingMessage & { auth?: unknown }, res: ServerResponse, body: { method?: string }) {
        handled(req.auth);
        if (body?.method === "initialize") {
          this.sessionId = `session-${++counter}`;
          this.options.onsessioninitialized(this.sessionId);
          res.setHeader("Mcp-Session-Id", this.sessionId);
        }
        res.writeHead(200); res.end("{}");
      }
    },
  }));
  await import("../src/streamable-http.js");
  for (let i=0; !handler && i<20; i++) await new Promise(resolve => setTimeout(resolve,0));
  expect(handler).toBeTypeOf("function");
});

describe("OAuth HTTP routing and session isolation", () => {
  it("exposes only health and resource discovery without authentication", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await dispatch("GET",path);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).resource).toBe(config.resource);
    }
    expect((await dispatch("GET","/health")).statusCode).toBe(200);
  });
  it.each(["GET","POST","DELETE"])("protects %s and never falls back to the old key", async method => {
    for (const headers of [{}, { authorization: "Bearer legacy-key" }, { "x-api-key": "legacy-key" }, { "x-user-id": "auth0|Alice" }]) {
      const res = await dispatch(method,"/mcp",headers);
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
    }
  });
  it("passes verified identity to MCP and denies cross-user session reuse", async () => {
    const alice = await bearer();
    const initialize = await dispatch("POST","/mcp",alice,{ method: "initialize" });
    expect(initialize.statusCode).toBe(200);
    expect(handled).toHaveBeenLastCalledWith(expect.objectContaining({ extra: { sub: "auth0|Alice", issuer: config.issuer } }));
    const session = String(initialize.headers["mcp-session-id"]);
    for (const method of ["GET","POST","DELETE"]) {
      const denied = await dispatch(method,"/mcp",{ ...await bearer("auth0|Bob"), "mcp-session-id": session }, { method: "tools/list" });
      expect(denied.statusCode).toBe(403);
    }
    const refreshed = await dispatch("POST","/mcp",{ ...await bearer(), "mcp-session-id": session },{ method: "tools/list" });
    expect(refreshed.statusCode).toBe(200);
  });
  it("denies unapproved users and insufficient scopes before MCP dispatch", async () => {
    for (const headers of [await bearer("auth0|Mallory"), await bearer("auth0|Alice","openid")]) {
      const res = await dispatch("POST","/mcp",headers,{ method: "initialize" });
      expect(res.statusCode).toBe(403);
    }
  });
});
