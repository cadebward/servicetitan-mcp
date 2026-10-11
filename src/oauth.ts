import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OAuthConfig {
  issuer: string;
  resource: string;
  scope: string;
  allowedSubjects: string[];
  allowedClientIds: string[];
}

function httpsUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.href;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required OAuth configuration: ${name}`);
  return value;
}

function allowlist(env: NodeJS.ProcessEnv, name: string): string[] {
  const values = required(env, name).split(",").map(value => value.trim()).filter(Boolean);
  if (!values.length || values.includes("*")) throw new Error(`${name} requires an explicit allowlist`);
  return values;
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const mode = env.ST_MCP_AUTH_MODE ?? "api-key";
  if (mode === "api-key") return null;
  if (mode !== "oauth") throw new Error("ST_MCP_AUTH_MODE must be oauth or api-key");
  const issuer = httpsUrl(required(env, "ST_OAUTH_ISSUER"), "ST_OAUTH_ISSUER");
  if (new URL(issuer).pathname !== "/") throw new Error("Auth0 issuer must be the tenant origin with a trailing slash");
  const scope = env.ST_OAUTH_SCOPE ?? "servicetitan:read";
  if (!/^[a-zA-Z0-9:_-]+$/.test(scope)) throw new Error("ST_OAUTH_SCOPE must be one scope name");
  return {
    issuer,
    resource: httpsUrl(required(env, "ST_OAUTH_RESOURCE"), "ST_OAUTH_RESOURCE"),
    scope,
    allowedSubjects: allowlist(env, "ST_OAUTH_ALLOWED_SUBJECTS"),
    allowedClientIds: allowlist(env, "ST_OAUTH_ALLOWED_CLIENT_IDS"),
  };
}

export class OAuthFailure extends Error {
  constructor(public readonly status: 401 | 403, public readonly code: "invalid_token" | "insufficient_scope" | "access_denied") {
    super(code);
  }
}

export class OAuthAccess {
  readonly metadataUrl: string;

  constructor(readonly config: OAuthConfig, private readonly key: JWTVerifyGetKey) {
    this.metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.resource).href;
  }

  static async discover(config: OAuthConfig): Promise<OAuthAccess> {
    const response = await fetch(new URL(".well-known/openid-configuration", config.issuer), {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Auth0 discovery failed");
    const metadata = await response.json() as Record<string, unknown>;
    if (metadata.issuer !== config.issuer || !Array.isArray(metadata.code_challenge_methods_supported) ||
        !metadata.code_challenge_methods_supported.includes("S256")) {
      throw new Error("Auth0 discovery must match the configured issuer and advertise PKCE S256");
    }
    for (const field of ["jwks_uri", "authorization_endpoint", "token_endpoint"]) {
      if (typeof metadata[field] !== "string") throw new Error(`Auth0 discovery missing ${field}`);
      const url = httpsUrl(metadata[field], field);
      if (new URL(url).origin !== new URL(config.issuer).origin) throw new Error(`Auth0 ${field} must use the configured issuer origin`);
    }
    return new OAuthAccess(config, createRemoteJWKSet(new URL(metadata.jwks_uri as string), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    }));
  }

  metadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      resource_name: "Rocky Mountain Plumbing ServiceTitan",
      authorization_servers: [this.config.issuer],
      scopes_supported: [this.config.scope],
      bearer_methods_supported: ["header"],
    };
  }

  challenge(code = "invalid_token"): string {
    return `Bearer resource_metadata="${this.metadataUrl}", scope="${this.config.scope}", error="${code}", error_description="A valid authorized OAuth access token is required"`;
  }

  reject(res: ServerResponse, failure: OAuthFailure): void {
    res.writeHead(failure.status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": this.challenge(failure.code),
    });
    res.end(JSON.stringify({ error: failure.code }));
  }

  async authenticate(req: IncomingMessage): Promise<AuthInfo> {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match) throw new OAuthFailure(401, "invalid_token");
    const token = match[1];
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        issuer: this.config.issuer,
        audience: this.config.resource,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
      }));
    } catch {
      throw new OAuthFailure(401, "invalid_token");
    }
    if (typeof payload.sub !== "string" || !this.config.allowedSubjects.includes(payload.sub)) {
      throw new OAuthFailure(403, "access_denied");
    }
    // Auth0's default access-token profile uses azp; RFC 9068 uses client_id.
    const clientId = payload.azp ?? payload.client_id;
    if (typeof clientId !== "string" || !this.config.allowedClientIds.includes(clientId) ||
        (payload.azp !== undefined && payload.client_id !== undefined && payload.azp !== payload.client_id)) {
      throw new OAuthFailure(403, "access_denied");
    }
    const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
    if (!scopes.includes(this.config.scope)) throw new OAuthFailure(403, "insufficient_scope");
    return { token, clientId, scopes, expiresAt: payload.exp, resource: new URL(this.config.resource),
      extra: { sub: payload.sub, issuer: this.config.issuer } };
  }

  sessionOwner(auth: AuthInfo): string {
    return JSON.stringify([auth.extra?.issuer, auth.extra?.sub, auth.clientId]);
  }
}
