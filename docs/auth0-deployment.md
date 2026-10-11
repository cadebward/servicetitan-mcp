# Auth0 connection for the Fly MCP server

The deployment uses one persistent Fly machine and Auth0 as the OAuth authorization server. ChatGPT/dot connects through a personal plugin using authorization code + PKCE S256. A static MCP API key cannot connect this plugin.

## Auth0 setup

1. Enable tenant **Resource Parameter Compatibility Profile** and **Include Issuer in Authorization Responses**. The issuer must match the configured HTTPS tenant origin, including its trailing slash.
2. Create a custom API named `Rocky Mountain Plumbing ServiceTitan MCP`, identifier exactly `https://rmp-servicetitan-mcp.fly.dev/mcp`, RS256 signatures and RFC 9068 access-token profile. Use per-application authorization for user-delegated access; disable client-credentials access.
3. Define `servicetitan:read`. Enable RBAC and assign this permission only to the intended application user. The dashboard administrator and application user are separate accounts.
4. Configure the supplied OAuth application for authorization code and refresh token grants. Authorize it for this API and scope. Enable only the required login connection. Register the exact callback URL displayed by ChatGPT's MCP management page, with no wildcards. For issuers meeting RFC 9207 requirements the documented stable callback is `https://chatgpt.com/connector_platform_oauth_redirect`; verify the connection's actual value before completing linking.
5. If using a confidential predefined client, enter its existing client secret directly in the plugin's credential UI. Do not put it into a conversation or the MCP server environment. Do not use a machine-to-machine app or token as a substitute for user sign-in.

## Server configuration

Required in addition to the existing ServiceTitan credentials:

| Setting | Purpose |
| --- | --- |
| `ST_MCP_AUTH_MODE=oauth` | Enables OAuth exclusively on Streamable HTTP |
| `ST_OAUTH_ISSUER` | Exact Auth0 issuer URL including trailing slash |
| `ST_OAUTH_RESOURCE` | API identifier / access-token audience, exactly the MCP URL above |
| `ST_OAUTH_SCOPE=servicetitan:read` | Required delegated access scope |
| `ST_OAUTH_ALLOWED_SUBJECTS` | Comma-separated exact Auth0 user IDs, case-sensitive; no wildcard |
| `ST_OAUTH_ALLOWED_CLIENT_IDS` | Comma-separated exact approved OAuth client IDs; no wildcard |
| `ST_READONLY=false` | Enable registered write and delete tools for approved callers; use `true` to block mutations |

The configured scope is a connection-level permission shared by all tools. Its legacy name `servicetitan:read` does not restrict operations when `ST_READONLY=false`; all allowlisted users and clients with this scope can use registered writes. ServiceTitan API permissions still apply. Deletes require `confirm: true`; writes require `_confirmed: true` only when `ST_CONFIRM_WRITES=true`.

The OAuth transport fails startup on missing allowlists or invalid provider discovery. In OAuth mode, the old `ST_MCP_API_KEY` grants no access. Keep deployment replicas at one. Never log access tokens or return them in tool output.

Public discovery is at `/.well-known/oauth-protected-resource/mcp` (also at the root well-known alias). It advertises the exact resource identifier, Auth0 issuer and required scope. Every MCP method validates access before session lookup and MCP dispatch. Sessions bind to the verified issuer, subject and client, not the token string, so refresh can preserve a session.

`ST_ALLOWED_CALLERS`, when used, now matches only the transport-verified subject. Metadata, forwarded user headers and OAuth client IDs cannot satisfy it. Case folding was removed because user subjects are case-sensitive. OAuth mode independently enforces its mandatory subject and client allowlists.

## Deployment and acceptance

1. Run typecheck, lint, tests, build, and `npm audit --omit=dev`.
2. Import the named configuration into Fly secrets through stdin without printing values. Deploy with `fly deploy --app rmp-servicetitan-mcp --remote-only --ha=false`.
3. Confirm discovery is public and matches Auth0; health is passing; missing, malformed and old static bearer credentials return 401 with `WWW-Authenticate`.
4. In ChatGPT developer mode, create/install a personal plugin for the MCP URL and select OAuth using the approved predefined client. Complete interactive sign-in as the approved application user.
5. Verify tool discovery and `st_health_check` through the linked plugin. Verify another subject/client cannot connect, wrong-audience/expired tokens are rejected, sessions cannot cross principals, and mutations follow `ST_READONLY`. Verify write/delete authorization and confirmation behavior with synthetic test handlers; do not mutate production records solely as a deployment smoke test.

Local tests use generated test keys and mocked Auth0 discovery; they do not use real credentials or ServiceTitan data. Do not describe OAuth linking as complete until the interactive flow and a real linked tool call succeed.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Auth0 MCP setup](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server).
