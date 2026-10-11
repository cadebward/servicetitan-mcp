import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { ServiceTitanClient } from "../../src/client.js";
import type { ServiceTitanConfig } from "../../src/config.js";
import { loadCrmDomain } from "../../src/domains/crm/index.js";
import { loadReportingDomain } from "../../src/domains/reporting/index.js";
import { loadMarketingDomain } from "../../src/domains/marketing/index.js";
import type { DomainLoader } from "../../src/registry.js";
import { ToolRegistry } from "../../src/registry.js";
import type { ToolResponse } from "../../src/types.js";

interface DomainTestContext {
  getMock: ReturnType<typeof vi.fn>;
  postMock: ReturnType<typeof vi.fn>;
  handlers: Map<string, (params: unknown) => Promise<ToolResponse>>;
  schemas: Map<string, Record<string, z.ZodTypeAny>>;
}

function createConfig(overrides: Partial<ServiceTitanConfig> = {}): ServiceTitanConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    appKey: "app-key",
    tenantId: "tenant-id",
    environment: "integration",
    readonlyMode: false,
    confirmWrites: false,
    maxResponseChars: 100_000,
    enabledDomains: null,
    logLevel: "error",
    timezone: "UTC",
    corsOrigin: "",
    allowedCallers: null,
    ...overrides,
  };
}

function createDomainContext(loader: DomainLoader): DomainTestContext {
  const server = { tool: vi.fn() };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const registry = new ToolRegistry(server as any, createConfig(), logger as any);
  const getMock = vi.fn();
  const postMock = vi.fn();
  const client = {
    get: getMock,
    post: postMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ServiceTitanClient;

  registry.attachClient(client);
  registry.registerDomain("test", loader);

  const handlers = new Map<string, (params: unknown) => Promise<ToolResponse>>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();

  for (const [name, schema, handler] of server.tool.mock.calls) {
    handlers.set(name as string, handler as (params: unknown) => Promise<ToolResponse>);
    schemas.set(name as string, schema as Record<string, z.ZodTypeAny>);
  }

  return { getMock, postMock, handlers, schemas };
}

describe("path validation", () => {
  it.each(["reporting_reports_list", "reporting_reports_get", "reporting_reports_data_create"])(
    "%s rejects category traversal before making any API call", async name => {
      const {schemas,handlers,getMock,postMock} = createDomainContext(loadReportingDomain);
      const schema = z.object(schemas.get(name)!);
      for (const reportCategory of ["../../../../../crm/v2/tenant/999/customers?", "..", "%2e%2e%2f", "a/b", "a\\b", "a?b", "a#b", ""]) {
        const params = {reportCategory,reportId:1};
        expect(schema.safeParse(params).success).toBe(false);
        await expect(handlers.get(name)!(params)).rejects.toThrow();
      }
      expect(getMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
      expect(schema.safeParse({reportCategory:"job_reports-1",reportId:1}).success).toBe(true);
      await handlers.get(name)!({reportCategory:"job_reports-1",reportId:1});
      if (name === "reporting_reports_data_create") {
        expect(postMock).toHaveBeenCalledWith("/tenant/{tenant}/report-category/job_reports-1/reports/1/data", {}, {});
      } else {
        expect(getMock).toHaveBeenCalledOnce();
      }
    },
  );

  it("rejects unsafe CRM relationship type slugs", () => {
    const { schemas } = createDomainContext(loadCrmDomain);
    const schema = z.object(schemas.get("crm_contact_relationships_create") ?? {});

    expect(
      schema.safeParse({
        contactId: "550e8400-e29b-41d4-a716-446655440000",
        relatedEntityId: 12,
        typeSlug: "../account",
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        contactId: "550e8400-e29b-41d4-a716-446655440000",
        relatedEntityId: 12,
        typeSlug: "account_link-1",
      }).success,
    ).toBe(true);
  });

  it("rejects unsafe marketing scheduler IDs", () => {
    const { schemas } = createDomainContext(loadMarketingDomain);
    const schema = z.object(schemas.get("marketing_scheduler_scheduler_performance") ?? {});

    expect(
      schema.safeParse({
        id: "scheduler/../admin",
        sessionCreatedOnOrAfter: "2026-03-01T00:00:00Z",
        sessionCreatedBefore: "2026-03-31T00:00:00Z",
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        id: "scheduler_01-alpha",
        sessionCreatedOnOrAfter: "2026-03-01T00:00:00Z",
        sessionCreatedBefore: "2026-03-31T00:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("encodes suppression emails before interpolating them into the path", async () => {
    const { getMock, handlers } = createDomainContext(loadMarketingDomain);
    const handler = handlers.get("marketing_suppressions_get");

    if (!handler) {
      throw new Error("Missing marketing_suppressions_get handler");
    }

    getMock.mockResolvedValue({ email: "user+alerts@example.com" });

    await handler({ email: "user+alerts@example.com" });

    expect(getMock).toHaveBeenCalledWith(
      "/tenant/{tenant}/suppressions/user%2Balerts%40example.com",
    );
  });
});
