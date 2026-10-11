import { z } from "zod";

import type { ServiceTitanClient } from "../../client.js";
import type { ToolRegistry } from "../../registry.js";
import { buildParams, paginationParams, toolError, toolResult, getErrorMessage } from "../../utils.js";

const reportCategorySchema = z.string()
  .regex(/^[a-zA-Z0-9_-]+$/, "Report category must be a single ID or slug")
  .describe("Report category ID");

const reportGetSchema = z.object({
  reportCategory: reportCategorySchema,
  reportId: z.number().int().describe("Report ID"),
});

const reportListSchema = paginationParams(
  z.object({
    reportCategory: reportCategorySchema,
  }),
);

const reportParameterSchema = z.object({
  name: z.string().describe("Parameter name (from report definition)"),
  value: z.string().describe("Parameter value"),
});

const reportDataSchema = z.object({
  reportCategory: reportCategorySchema,
  reportId: z.number().int().describe("Report ID"),
  parameters: z
    .array(reportParameterSchema)
    .optional()
    .describe("Report parameters (name/value pairs from report definition)"),
  page: z.number().int().optional().describe("Page number (starts at 1)"),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(25000)
    .optional()
    .describe("Records per page"),
  includeTotal: z.boolean().optional().describe("Include total count"),
});
export function registerReportTools(client: ServiceTitanClient, registry: ToolRegistry): void {
  registry.register({
    name: "reporting_reports_list",
    domain: "reporting",
    operation: "read",
    description: "List reports in a report category",
    schema: reportListSchema.shape,
    handler: async (params) => {
      const { reportCategory, ...query } = reportListSchema.parse(params);

      try {
        const data = await client.get(
          `/tenant/{tenant}/report-category/${reportCategory}/reports`,
          buildParams(query),
        );
        return toolResult(data);
      } catch (error) {
        return toolError(getErrorMessage(error));
      }
    },
  });

  registry.register({
    name: "reporting_reports_get",
    domain: "reporting",
    operation: "read",
    description: "Get a report definition in a category",
    schema: reportGetSchema.shape,
    handler: async (params) => {
      const { reportCategory, reportId } = reportGetSchema.parse(params);

      try {
        const data = await client.get(
          `/tenant/{tenant}/report-category/${reportCategory}/reports/${reportId}`,
        );
        return toolResult(data);
      } catch (error) {
        return toolError(getErrorMessage(error));
      }
    },
  });

  registry.register({
    name: "reporting_reports_data_create",
    domain: "reporting",
    operation: "read",
    description:
      "Fetch report data rows. Use the report definition to discover required parameters. Date parameters use YYYY-MM-DD format.",
    schema: reportDataSchema.shape,
    handler: async (params) => {
      const { reportCategory, reportId, parameters, ...query } = reportDataSchema.parse(params);

      try {
        const data = await client.post(
          `/tenant/{tenant}/report-category/${reportCategory}/reports/${reportId}/data`,
          parameters ? { parameters } : {},
          buildParams(query),
        );
        return toolResult(data);
      } catch (error) {
        return toolError(getErrorMessage(error));
      }
    },
  });
}
