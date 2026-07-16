import { describe, expect, it, vi } from "vitest";

import type { ServiceTitanClient } from "../../src/client.js";
import type { ServiceTitanConfig } from "../../src/config.js";
import { loadPricebookDomain } from "../../src/domains/pricebook/index.js";
import { ToolRegistry } from "../../src/registry.js";
import type { ToolResponse } from "../../src/types.js";

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

function createContext(): {
  getMock: ReturnType<typeof vi.fn>;
  handlers: Map<string, (params: unknown) => Promise<ToolResponse>>;
  schemas: Map<string, Record<string, unknown>>;
} {
  const server = { tool: vi.fn() };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const registry = new ToolRegistry(server as any, createConfig(), logger as any);
  const getMock = vi.fn();
  const client = {
    get: getMock,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as ServiceTitanClient;

  registry.attachClient(client);
  loadPricebookDomain(client, registry);

  const handlers = new Map<string, (params: unknown) => Promise<ToolResponse>>();
  const schemas = new Map<string, Record<string, unknown>>();
  for (const [name, schema, handler] of server.tool.mock.calls) {
    handlers.set(name as string, handler as (params: unknown) => Promise<ToolResponse>);
    schemas.set(name as string, schema as Record<string, unknown>);
  }

  return { getMock, handlers, schemas };
}

function getHandler(
  handlers: Map<string, (params: unknown) => Promise<ToolResponse>>,
  toolName: string,
): (params: unknown) => Promise<ToolResponse> {
  const handler = handlers.get(toolName);
  if (!handler) {
    throw new Error(`Missing handler for ${toolName}`);
  }
  return handler;
}

function parsePayload(result: ToolResponse): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  const text = result.content[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

describe("pricebook domain", () => {
  it.each([
    ["pricebook_services_list", "/tenant/{tenant}/services"],
    ["pricebook_materials_list", "/tenant/{tenant}/materials"],
    ["pricebook_equipment_list", "/tenant/{tenant}/equipment"],
  ])("%s scans and filters code/name searches inside the MCP server", async (toolName, path) => {
    const { getMock, handlers, schemas } = createContext();
    const handler = getHandler(handlers, toolName);

    expect(schemas.get(toolName)).toMatchObject({
      code: expect.anything(),
      codes: expect.anything(),
      name: expect.anything(),
      lean: expect.anything(),
    });

    getMock.mockResolvedValue({
      page: 1,
      pageSize: 500,
      hasMore: false,
      data: [
        {
          id: 1,
          code: "OTHER",
          displayName: "Other Service",
          price: 1,
          memberPrice: 1,
          active: true,
        },
        {
          id: 26866729,
          code: "GPRR-170",
          displayName: 'Install 1/2" Drip Leg',
          price: 250,
          memberPrice: 225,
          active: true,
          description: "<p>Large HTML description</p>",
        },
      ],
    });

    const result = await handler({
      code: "GPRR-170",
      name: "Drip Leg",
      page: 1,
      pageSize: 10,
    });
    const payload = parsePayload(result);

    expect(getMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        page: 1,
        pageSize: 500,
        includeTotal: false,
      }),
    );
    expect(getMock.mock.calls[0]?.[1]).not.toHaveProperty("code");
    expect(getMock.mock.calls[0]?.[1]).not.toHaveProperty("name");
    expect(getMock.mock.calls[0]?.[1]).not.toHaveProperty("lean");
    expect(payload).toMatchObject({
      page: 1,
      pageSize: 10,
      totalCount: 1,
      hasMore: false,
      data: [
        {
          id: 26866729,
          code: "GPRR-170",
          displayName: 'Install 1/2" Drip Leg',
          price: 250,
          memberPrice: 225,
          active: true,
        },
      ],
    });
  });

  it("pricebook_services_list can return full search results when lean is false", async () => {
    const { getMock, handlers } = createContext();
    const handler = getHandler(handlers, "pricebook_services_list");

    getMock.mockResolvedValue({
      page: 1,
      pageSize: 1,
      totalCount: 1,
      hasMore: false,
      data: [
        {
          id: 26866729,
          code: "GPRR-170",
          displayName: 'Install 1/2" Drip Leg',
          price: 250,
          memberPrice: 225,
          active: true,
          description: "<p>Large HTML description</p>",
          materials: [{ id: 1 }],
          assets: [{ id: 2 }],
        },
      ],
    });

    const result = await handler({ code: "GPRR-170", lean: false });
    const payload = parsePayload(result);
    const data = payload.data as Array<Record<string, unknown>>;

    expect(data).toEqual([
      expect.objectContaining({
        id: 26866729,
        code: "GPRR-170",
        displayName: 'Install 1/2" Drip Leg',
        price: 250,
        memberPrice: 225,
        active: true,
        description: "<p>Large HTML description</p>",
      }),
    ]);
  });
});
