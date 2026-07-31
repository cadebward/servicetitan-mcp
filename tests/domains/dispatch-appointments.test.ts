import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ServiceTitanClient } from "../../src/client.js";
import type { ServiceTitanConfig } from "../../src/config.js";
import { registerDispatchAppointmentTools } from "../../src/domains/dispatch/appointments.js";
import { ToolRegistry } from "../../src/registry.js";

function createConfig(): ServiceTitanConfig {
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
  };
}

async function createContext() {
  const server = new McpServer({ name: "dispatch-appointments-test", version: "1.0.0" });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const registry = new ToolRegistry(server, createConfig(), logger as any);
  const post = vi.fn().mockResolvedValue({
    id: 123,
    appointmentNumber: "81397998-2",
  });
  const serviceTitanClient = {
    get: vi.fn(),
    post,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ServiceTitanClient;

  registerDispatchAppointmentTools(serviceTitanClient, registry);

  const client = new Client({ name: "dispatch-appointments-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    post,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("dispatch appointment creation", () => {
  it("publishes the ServiceTitan request fields and required set", async () => {
    const { client, close } = await createContext();

    try {
      const { tools } = await client.listTools();
      const createTool = tools.find(
        (tool) => tool.name === "dispatch_appointments_create",
      );

      expect(createTool?.inputSchema.required).toEqual(["jobId", "start", "end"]);
      expect(createTool?.inputSchema.properties).toEqual(
        expect.objectContaining({
          jobId: expect.any(Object),
          start: expect.any(Object),
          end: expect.any(Object),
          technicianIds: expect.any(Object),
        }),
      );
      expect(createTool?.inputSchema.properties).not.toHaveProperty("appointmentNumber");
      expect(createTool?.inputSchema.properties).not.toHaveProperty("customerId");
      expect(createTool?.inputSchema.properties).not.toHaveProperty("createdById");
    } finally {
      await close();
    }
  });

  it("creates an appointment with the minimal documented request", async () => {
    const { client, post, close } = await createContext();
    const input = {
      jobId: 81397998,
      start: "2026-07-22T08:00:00-06:00",
      end: "2026-07-22T10:00:00-06:00",
    };

    try {
      const result = await client.callTool({
        name: "dispatch_appointments_create",
        arguments: input,
      });

      expect(result.isError).not.toBe(true);
      expect(post).toHaveBeenCalledWith("/tenant/{tenant}/appointments", input);
    } finally {
      await close();
    }
  });

  it("rejects a create request that omits the required end time", async () => {
    const { client, post, close } = await createContext();

    try {
      const result = await client.callTool({
        name: "dispatch_appointments_create",
        arguments: {
          jobId: 81397998,
          start: "2026-07-22T08:00:00-06:00",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(/end[\s\S]*Required/),
        }),
      ]);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
