# Marketing Ads routing investigation — 2026-10-19

## Finding and scope

All three installed connector tools reproduced `INVALID_ARGUMENT: Unable to match incoming request to an operation.` The same requests through this checkout's real ServiceTitan client succeeded against production with existing local credentials, before these edits. Therefore the reported failure is **not reproduced in this checkout's route resolver**. The installed connector's deployment/dispatch path remains unverified. We cannot attribute its error conclusively to MCP dispatch versus ServiceTitan's gateway without its outbound request metadata or deployment artifact. Do not interpret this message alone as a permissions failure.

The patch explicitly qualifies just these three handler paths, validates Ads date ranges and handler inputs, and adds regression coverage. It does not claim that explicit paths change the effective HTTP URL in the pre-patch checkout: the existing resolver already supplies the same module/version. No global routing, campaign reports, costs, intelligence, or write tools were changed. Names and exposed argument schemas remain compatible. No deployment or scope expansion was performed.

## Official evidence

Retrieved current public OpenAPI directly from ServiceTitan on 2026-10-19:

- [Marketing Ads v2 OpenAPI](https://developer.servicetitan.io/api/docs/apis/tenant-marketing-ads-v2), SHA-256 `84a50e8c586d2aec6f97fcd08cf9ffa58a5b367aaa0cfa80c8340a69929b3de8`.
- [Task Management v2 OpenAPI](https://developer.servicetitan.io/api/docs/apis/tenant-task-management-v2), SHA-256 `5f68c2a93a5f94044d0aec482847a9b7a1529c6d7e17be6a0f4fa18cc1bb0d35`.
- [Ads dashboard reference](https://help.servicetitan.com/docs/use-marketing-pro-ads-analytics-1). This describes the UI; the public API contract, rather than UI endpoints, governs the tools.

Both API documents still publish these operations; none is marked deprecated. All three succeeded with existing credentials. No evidence of an additional licensing or scope blocker was observed for this local credential set. The local credentials' equivalence to the remote connector credentials has not been established.

## Trace and per-tool findings

| Exposed tool | Handler | Official operation / effective GET path | Required OAuth scope |
|---|---|---|---|
| `people_performance_get` | `src/domains/people/technicians.ts` | `Performance_Get`: `/marketingads/v2/tenant/{tenant}/performance` | `tn.mads.performance:r` |
| `marketing_attributed_leads_get` | `src/domains/marketing/attributions.ts` | `AttributedLeads_Get`: `/marketingads/v2/tenant/{tenant}/attributed-leads` | `tn.mads.attributedleads:r` |
| `marketing_client_side_data_get` | `src/domains/marketing/attributions.ts` | `ClientSideData_Get`: `/taskmanagement/v2/tenant/{tenant}/data` | `tn.tsm.data:r` |

Domain loaders register the named handlers with `ToolRegistry`, which exposes their Zod field schemas via `McpServer.registerTool`. The registered handler calls `ServiceTitanClient.get`; `request` resolves and validates the route against pinned official contracts, replaces the tenant placeholder, and uses Axios GET with query parameters and no request body. Production origin is `https://api.servicetitan.io`; integration origin is `https://api-integration.servicetitan.io`. Authentication is client credentials plus `ST-App-Key`; credentials never enter query parameters.

Originally these handlers supplied `/tenant/{tenant}/performance`, `/tenant/{tenant}/attributed-leads`, and `/tenant/{tenant}/data`. The current resolver maps them correctly. The patch makes ownership explicit at each call site so the misleading domain names cannot imply a different API module.

- **Performance:** legacy `people_` naming is misleading; it is Marketing Ads, not technician performance. The local mapping already worked. Date parsing previously occurred outside the handler's error boundary, and reversed/equal ranges were accepted. These validation defects are fixed, but are not asserted to have caused the remote operation-matching error.
- **Attributed leads:** local mapping already worked. Handler previously cast arguments rather than validating them when called directly. Handler validation and ordered date ranges are now enforced. This is not evidence of the remote failure's cause.
- **Client-side data:** the legacy `marketing_` name does not make this Ads analytics. Official response is task reference data. Its description in this checkout already states this; the connected tool's shorter description is different. Local mapping succeeds; remote failure remains a deployment/dispatch discrepancy. No invented Ads client-data operation or analytics substitution was added.

The installed connector returns `{error_code: "INVALID_ARGUMENT"}` plus a plain error string. This checkout returns structured `error` diagnostics for upstream failures (status, path, phase, trace ID where supplied, retryability). The mismatch and differing tool descriptions support deployment drift, but do not identify the exact remote failing URL.

## Inputs and serialization

Performance requires `fromUtc`, `toUtc` (UTC ISO date-times) and `performanceSegmentationType` (`Campaign`, `AdGroup`, `Keyword`). Attributed leads requires the same date-time pair and optionally `leadType` (`Call`, `WebBooking`, `WebLeadForm`, `ManualJob`). Both support `page`, `pageSize`, `includeTotal`. No documented campaign-ID, attribution-model, sort, or funnel-stage filter exists on these two operations.

The server's existing pagination validation is retained: page >= 1, integer pageSize 1–5000; the official description specifies a default pageSize of 50 but does not publish that upper bound. The local upper bound is a connector guard, not an asserted API guarantee. New range validation requires `fromUtc < toUtc`. Official docs do not specify boundary inclusivity, maximum date span, rate-unit scaling, or attribution-model selection; none is invented here. Query serialization preserves `false`, numbers, and enum strings, drops undefined values, and URL-encodes timestamps. Client-side data takes no query inputs and is unpaged.

## Live read-only results

Initial pre-patch local-client checks used 2026-10-01T00:00:00Z through 2026-10-02T00:00:00Z, page 1, pageSize 1. Performance returned a real row and totalCount 4. Leads returned a valid empty envelope. Task data returned all eight documented top-level arrays.

A wider query, 2026-09-01T00:00:00Z through 2026-10-19T00:00:00Z, pageSize 1, includeTotal true, returned:

| Query | Observed totalCount | Page / hasMore |
|---|---:|---|
| Campaign | 4 | 1 / true |
| AdGroup | 1 | 1 / false |
| Keyword | 41 | 1 / true |
| Campaign second page | 4 | 2 / true |
| Attributed leads | 90 | 1 / true |

These are result-row counts, not campaign effectiveness metrics. Only field names/counts were logged; no lead/customer records, tokens, or secret headers were saved. Some association objects can be null in actual responses (observed on campaign page 2); consumers must tolerate that.

Actual performance rows contained `campaign`, `adGroup`, `keyword`, `digitalStats`, `leadStats`, `returnOnInvestment`. Actual lead rows contained `dateTime`, `leadType`, `attribution`, `job`, `customer`, `call`, `leadForm`, `booking`. Attribution contained UTM source/medium/campaign, landing/referrer URLs, click IDs, campaign ID, original campaign, overwrite metadata, ad-group IDs/names, and keyword IDs/names. These fields were inspected in actual responses, not inferred from HTTP 200 alone.

## Accessible Ads metrics

| Metric | Native Ads response field / limitation |
|---|---|
| Impressions | `digitalStats.impressions`, plus `impressionShare` |
| Clicks | `digitalStats.clicks`, `clickRate`, `averageCPC` |
| Spend | `digitalStats.cost`; not the general campaign cost list |
| Platform conversions | `digitalStats.conversions`, `allConversions`, `costPerConversion`, `conversionRate` |
| Leads | `leadStats.leads`, `leadCalls`, `onlineBooking`, `manualBooking` |
| Booked / ran / sold jobs | `leadStats.bookedJobs`, `ranJobs`, `soldJobs` |
| Revenue | `leadStats.revenue`, `potentialRevenue`, `avgTicket` |
| Booking rate | `leadStats.bookingRate` |
| ROI | `returnOnInvestment`; nullable, preserve API semantics |
| ROAS | No native ROAS field. Revenue / cost can be a labeled derived ratio only when cost > 0 and attribution, period, and currency align; do not relabel ROI as ROAS. |
| Funnel attribution | Performance aggregates plus lead-level `attribution`, job/customer/call/form/booking links. No documented first-/last-touch selector or complete touch-by-touch journey endpoint in these operations. |

Field presence does not certify completeness, non-null values, or exact dashboard reconciliation. General Campaign Summary report 5201, `intel_campaign_performance`, and `marketing_campaign_costs_list` remain separate sources. They are not substitutes for native Ads digital statistics. **An empty campaign cost list does not mean zero ad spend.** Use native `digitalStats.cost` and distinguish missing/null values from zero.

## Example named tool calls

Validated through the local named-tool implementation; the currently installed connector still needs its deployment verified.

```json
{"name":"people_performance_get","arguments":{"fromUtc":"2026-09-01T00:00:00Z","toUtc":"2026-10-19T00:00:00Z","performanceSegmentationType":"Campaign","page":1,"pageSize":1,"includeTotal":true}}
```

Change segmentation to `AdGroup` or `Keyword`; increment page while `hasMore` is true. Do not sum overlapping segmentation grains together.

```json
{"name":"marketing_attributed_leads_get","arguments":{"fromUtc":"2026-09-01T00:00:00Z","toUtc":"2026-10-19T00:00:00Z","page":1,"pageSize":1,"includeTotal":true}}
```

Optional `leadType: "Call"` (or other documented enum) filters the lead type.

```json
{"name":"marketing_client_side_data_get","arguments":{}}
```

The last call is task reference data, not Ads analytics.

## Verification and next action

`tests/domains/marketing-ads.test.ts` drives the named domain handlers through the real ServiceTitan client and an Axios transport adapter. It verifies exact module/version URLs, GET/no body, URL query serialization, all segmentation/lead enum values, pagination, actual response-shape preservation, malformed/reversed/equal dates, invalid pagination/enums, and sanitized upstream 400/403/404 diagnostics. Before the patch, 12 tests passed (including routing) and 4 validation tests failed. Afterward all 16 pass.

Full unit suite: 50 files / 663 tests passed. Contract check: 580 official operations, 475 handler operations, status OK (26 existing unsupported tools outside this scope). Lint and typecheck passed.

The opt-in `scripts/verify-marketing-ads.mjs` exercises actual MCP discovery/dispatch via in-memory SDK transport, the built server, and live ServiceTitan reads. Run `npm run build`, then `node --env-file=.env scripts/verify-marketing-ads.mjs`. It pins the above historical period, makes six bounded GET calls, asserts field presence, and prints only field names/counts and sanitized error metadata. Empty data arrays verify only the envelope, not row fields. The rebuilt-server run completed successfully for all six calls, with the same counts and observed field names listed above; this verifies the local MCP dispatch path end to end.

Before production deployment, identify the connected plugin's actual MCP URL/build revision and capture sanitized outbound method/path/status for one failing call. Compare against the three paths above and this checkout's error envelope. If its build is stale, obtain deployment approval, deploy the reviewed build, reconnect/refresh tool discovery, then repeat the same named calls. If a correctly routed request gets 403, have an authorized admin verify the exact read scope listed above and tenant Marketing Pro Ads entitlement; ask before expanding access. No access expansion is indicated by the successful local checks alone.
