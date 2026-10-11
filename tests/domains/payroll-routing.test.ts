import { describe, expect, it, vi } from "vitest";

import type { ServiceTitanClient } from "../../src/client.js";
import { registerExportTools } from "../../src/domains/export/exporters.js";
import { registerPayrollSettingsTools } from "../../src/domains/payroll/settings.js";
import { registerPayrollTimesheetTools } from "../../src/domains/payroll/timesheets.js";
import type { ToolDefinition, ToolRegistry } from "../../src/registry.js";

function registerTools(
  register: (client: ServiceTitanClient, registry: ToolRegistry) => void,
): { client: { get: ReturnType<typeof vi.fn> }; tools: Map<string, ToolDefinition> } {
  const client = { get: vi.fn().mockResolvedValue({ data: [] }) };
  const tools = new Map<string, ToolDefinition>();
  const registry = {
    register: (tool: ToolDefinition) => tools.set(tool.name, tool),
  };

  register(client as unknown as ServiceTitanClient, registry as unknown as ToolRegistry);
  return { client, tools };
}

async function callTool(tools: Map<string, ToolDefinition>, name: string, params: unknown) {
  const tool = tools.get(name);
  expect(tool, `Expected ${name} to be registered`).toBeDefined();
  await tool!.handler(params);
}

describe("payroll tool request routing", () => {
  it("builds the single-job timesheets request", async () => {
    const { client, tools } = registerTools(registerPayrollTimesheetTools);

    await callTool(tools, "payroll_timesheets_job_list", { jobId: 78848915 });

    expect(client.get).toHaveBeenCalledWith(
      "/tenant/{tenant}/jobs/78848915/timesheets",
      {},
    );
  });

  it("builds the multi-job timesheets request with jobIds in the query", async () => {
    const { client, tools } = registerTools(registerPayrollTimesheetTools);

    await callTool(tools, "payroll_timesheets_jobs_list", { jobIds: "78848915" });

    expect(client.get).toHaveBeenCalledWith(
      "/tenant/{tenant}/jobs/timesheets",
      { jobIds: "78848915" },
    );
  });

  it("uses the job-timesheet export path and continuation query", async () => {
    const { client, tools } = registerTools(registerExportTools);

    await callTool(tools, "export_timesheets", {
      from: "2026-02-01",
      includeRecentChanges: true,
    });

    expect(client.get).toHaveBeenCalledWith(
      "/tenant/{tenant}/export/jobs/timesheets",
      { from: "2026-02-01", includeRecentChanges: true },
    );
  });

  it("builds the technician payroll-settings request", async () => {
    const { client, tools } = registerTools(registerPayrollSettingsTools);

    await callTool(tools, "payroll_payroll_settings_technician_get", {
      technicianId: 56176835,
    });

    expect(client.get).toHaveBeenCalledWith(
      "/tenant/{tenant}/technicians/56176835/payroll-settings",
    );
  });
});
