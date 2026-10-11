# Security Policy

## Supported Versions

| Version | Supported              |
|---------|------------------------|
| 2.3.x   | ✅ Current              |
| 2.2.x   | ⚠️ Security fixes only  |
| < 2.2   | ❌ Not supported        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email **montrell@rowvyn.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

You should receive an acknowledgment within 48 hours.

## Security Model

### Authentication

- The server authenticates to ServiceTitan using OAuth 2.0 client credentials
- Credentials are loaded from environment variables, never hardcoded
- Access tokens are cached in memory with a 60-second expiry buffer
- Token acquisition uses a dedicated `axios.post()` call outside the interceptor chain to avoid recursive auth loops

### Remote Deployment (SSE Mode)

- Remote clients authenticate with `ST_MCP_API_KEY` (bearer token via `Authorization: Bearer` header or `x-api-key` header)
- CORS headers are configurable via `ST_CORS_ORIGIN`; the default is empty (no CORS headers emitted by Streamable HTTP; SSE uses the configured value)
- Request body size is limited to 1MB (HTTP 413 on oversize payloads)
- The server handles graceful shutdown on `SIGTERM`/`SIGINT` with a 10-second force-exit fallback
- `uncaughtException` and `unhandledRejection` handlers prevent silent crashes

### Data Safety

- Read-only mode is **enabled by default** (`ST_READONLY=true`) — write and delete tools remain visible, but execution is blocked with `Readonly mode: operation not permitted` until explicitly opted in
- Write and delete operations require explicit opt-in via `ST_READONLY=false`
- Delete operations require `confirm: true` in the tool call payload
- Write operations (when `ST_CONFIRM_WRITES=true`) require `_confirmed: true` in the tool call payload
- Audit logging records all write/delete operations with sensitive fields (including composite names such as `clientSecret`, `apiKey`, `accessToken`, and `authorization`) sanitized
- Tool responses never include raw credentials or tokens

## Authorization Model

This server is designed for single-operator use. The confirmation prompts for writes and deletes are safety UX to reduce accidental mutations; they are not a substitute for access control.

Remote deployments still authenticate transport access with `ST_MCP_API_KEY`, but that only answers "can this client reach the server?" It does not implement per-caller authorization.

`ST_ALLOWED_CALLERS` now accepts only exact, case-sensitive verified user subjects from `authInfo.extra.sub`. Client-provided MCP `_meta`, identity headers, and OAuth application client IDs are never treated as user identities. This intentionally breaks the previous insecure header-based allowlist behavior; stdio/API-key callers have no verified user subject and are denied if this allowlist is enabled.

### Auth0 OAuth transport

Set `ST_MCP_AUTH_MODE=oauth` for the Streamable HTTP entrypoint. Configuration must include an HTTPS issuer and resource identifier plus non-empty explicit subject and client-ID allowlists. Startup validates Auth0 discovery and PKCE S256 support. Every MCP request validates an RS256 access token against the issuer's JWKS, issuer, audience, expiry, required scope, exact subject, and OAuth client ID. JWT-controlled key URLs are not used. Invalid credentials produce an OAuth challenge; valid but unauthorized identities receive 403.

The legacy static key is ignored in OAuth mode. OAuth sessions are bound to issuer, user subject, and client ID; refreshed tokens for the same principal can reuse a session. Each tool also checks its verified request context. OAuth access follows `ST_READONLY`: the default `true` blocks mutations, while `false` enables registered write and delete tools for approved callers. Delete confirmation and optional write confirmation still apply. The configured OAuth scope is a connection-level permission, not a per-operation permission; the legacy scope name `servicetitan:read` does not impose read-only access when `ST_READONLY=false`. Public health and OAuth resource metadata contain no ServiceTitan records or credentials.

Use one Fly machine because sessions remain in memory. Auth0 stores login state and refresh tokens; the MCP service needs neither an Auth0 client secret nor a local user database. Short-lived access tokens limit revocation delay: a previously issued JWT remains usable until expiry unless the server allowlist is changed. No blanket public access, anonymous tools, or metadata-based identity fallback is used.

See [Auth0 deployment setup](docs/auth0-deployment.md) for configuration and connection validation.
