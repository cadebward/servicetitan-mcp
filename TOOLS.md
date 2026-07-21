# V3 tool catalog

Generated from the actual registry. ServiceTitan-facing read tools are backed by pinned API contracts and are eligible for stable support subject to scopes, module availability, and company validation. Live evidence covers representative reads, not every read tool. Built-in system tools provide health, readiness, and stored-result retrieval. Mutations are experimental and have not been verified against a live ServiceTitan Integration environment; they require both `ST_READONLY=false` and `ST_EXPERIMENTAL_WRITES=true`. Readonly mode always hides mutations. Profiles and tool allowlists narrow this catalog further. Discovery does not grant ServiceTitan API scopes.

ServiceTitan-facing reads: 261; built-in system tools: 3; readonly discovery: 264; experimental mutations: 194; total with explicit experimental opt-in: 458.

## _system

| Tool | Operation | Description |
| --- | --- | --- |
| `st_health_check` | read | Verify authentication and representative tenant read access. Use st_readiness_check for report and module compatibility. |
| `st_readiness_check` | read | Read-only compatibility manifest: authentication, representative module read access, report fields/parameters and definition fingerprints. Does not certify write scopes or metric totals. |
| `st_result_read` | read | Retrieve a stored large result as bounded JSON text chunks. Start at offset 0, concatenate text in nextOffset order, then parse JSON. Results expire after five minutes and belong to this session. |
## accounting

