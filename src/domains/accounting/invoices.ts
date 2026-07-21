import { z } from "zod";

import type { ServiceTitanClient } from "../../client.js";
import type { ToolRegistry } from "../../registry.js";
import { buildParams, dateFilterParams, paginationParams, sortParam, toolError, toolResult } from "../../utils.js";

const scalarCustomFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const customFieldMapSchema = z
  .object({})
  .catchall(scalarCustomFieldValueSchema)
  .describe("Custom field key/value map");

const invoiceItemPatchSchema = z.object({
  id: z.number().int().optional().describe("Invoice item ID"),
  skuId: z.number().int().optional().describe("SKU ID"),
  skuName: z.string().optional().describe("SKU name"),
  technicianId: z.number().int().optional().describe("Technician ID"),
  description: z.string().describe("Item description"),
  quantity: z.number().describe("Item quantity"),
  unitPrice: z.number().optional().describe("Item unit price"),
  cost: z.number().optional().describe("Item cost"),
  isAddOn: z.boolean().optional().describe("Whether the item is an add-on"),
  signature: z.string().optional().describe("Customer signature"),
  technicianAcknowledgementSignature: z
    .string()
    .optional()
    .describe("Technician acknowledgement signature"),
  installedOn: z.string().optional().describe("Installation date-time"),
  inventoryWarehouseName: z
    .string()
    .optional()
    .describe("Inventory warehouse name"),
  skipUpdatingMembershipPrices: z
    .boolean()
    .optional()
    .describe("Skip membership price updates"),
  itemGroupName: z.string().optional().describe("Item group name"),
  itemGroupRootId: z.number().int().optional().describe("Item group root ID"),
  inventoryLocationId: z
    .number()
    .int()
    .optional()
    .describe("Inventory location ID"),
  durationBillingId: z.number().int().optional().describe("Duration billing ID"),
  budgetCodeId: z.number().int().optional().describe("Budget code ID"),
}).passthrough();

const invoicePaymentSettlementPatchSchema = z.object({
  id: z.number().int().describe("Payment ID"),
  settlementStatus: z
    .enum(["NotSettled", "Settled"])
    .optional()
    .describe("Payment settlement status"),
  settlementDate: z.string().optional().describe("Settlement date-time"),
});

// Keep this schema aligned with Accounting.V2.InvoiceUpdateRequest. ServiceTitan
// accepts unknown JSON properties but ignores them, which otherwise turns schema
// mistakes (such as the old `memo` field) into successful-looking no-op writes.
const invoiceUpdatePayloadSchema = z
  .object({
    number: z.string().optional().describe("Invoice reference number"),
    typeId: z.number().int().optional().describe("Invoice type ID"),
    invoicedOn: z.string().optional().describe("Invoice date-time"),
    subtotal: z.number().optional().describe("Invoice subtotal"),
    tax: z.number().optional().describe("Invoice tax amount"),
    taxZoneId: z.number().int().optional().describe("Tax zone ID"),
    summary: z
      .string()
      .optional()
      .describe("Invoice summary text (HTML supported). Use this field, not memo."),
    royaltyStatus: z.enum(["Pending", "Sent", "Failed"]).optional(),
    royaltyDate: z.string().optional().describe("Royalty date-time"),
    royaltySentOn: z.string().optional().describe("Royalty sent date-time"),
    royaltyMemo: z.string().optional().describe("Royalty memo (not the invoice summary)"),
    exportId: z.string().optional().describe("External export ID"),
    reviewStatus: z
      .enum([
        "NeedsReview",
        "OnHold",
        "Reviewed",
        "PendingApproval",
        "Rejected",
        "ReadyForBilling",
        "Invoiced",
      ])
      .optional(),
    assignedToId: z.number().int().optional().describe("Assigned user ID"),
    budgetCodeId: z.number().int().optional().describe("Budget code ID"),
    items: z.array(invoiceItemPatchSchema).optional().describe("Invoice items"),
    dueDate: z.string().optional().describe("Invoice due date (YYYY-MM-DD)"),
    payments: z
      .array(invoicePaymentSettlementPatchSchema)
      .optional()
      .describe("Payment settlement updates"),
  })
  .strict("Unsupported invoice update field. Use summary for invoice summary text; memo is not writable on this endpoint.")
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one supported invoice field is required",
  });

const invoicesListSchema = paginationParams(
  dateFilterParams(
    z.object({
      ids: z.string().optional().describe("Comma-delimited invoice IDs"),
      statuses: z.array(z.string()).optional().describe("Invoice statuses"),
      batchId: z.number().int().optional().describe("Batch ID"),
      batchNumber: z.number().int().optional().describe("Batch number"),
      customFieldFields: z
        .record(z.string())
        .optional()
        .describe("Custom field name/value filters"),
      customFieldOperator: z
        .enum(["And", "Or"])
        .optional()
        .describe("Operator for custom field filters"),
      jobId: z.number().int().optional().describe("Job ID"),
      jobNumber: z.string().optional().describe("Job number"),
      businessUnitId: z.number().int().optional().describe("Business unit ID"),
      customerId: z.number().int().optional().describe("Customer ID"),
      invoicedOnOrAfter: z
        .string()
        .optional()
        .describe("Invoiced on or after RFC3339 date-time"),
      invoicedOnBefore: z
        .string()
        .optional()
        .describe("Invoiced on or before RFC3339 date-time"),
      adjustmentToId: z.number().int().optional().describe("Adjusted invoice ID"),
      number: z.string().optional().describe("Invoice number"),
      totalGreater: z.number().optional().describe("Minimum invoice total"),
      totalLess: z.number().optional().describe("Maximum invoice total"),
      balanceFilterBalance: z.number().optional().describe("Balance filter value"),
      balanceFilterComparer: z
        .enum(["Equals", "NotEquals", "Greater", "Less"])
        .optional()
        .describe("Balance comparison operator"),
      dueDateBefore: z
        .string()
        .optional()
        .describe("Due date before RFC3339 date-time"),
      dueDateOnOrAfter: z
        .string()
        .optional()
        .describe("Due date on or after RFC3339 date-time"),
      orderBy: z.string().optional().describe("Order by field"),
      orderByDirection: z
        .string()
        .optional()
        .describe("Order direction: asc|desc"),
      reviewStatuses: z.array(z.string()).optional().describe("Review statuses"),
      assignedToIds: z
        .array(z.number().int())
        .optional()
        .describe("Assignee user IDs"),
      ...sortParam([
        "Id",
        "ModifiedOn",
        "CreatedOn",
        "Number",
        "InvoicedOn",
        "DueDate",
        "Total",
        "Balance",
      ]),
    }),
  ),
);

const invoiceUpdateSchema = z.object({
  id: z.number().int().describe("Invoice ID"),
  payload: invoiceUpdatePayloadSchema
    .describe("Supported Accounting v2 InvoiceUpdateRequest fields to patch"),
});

const invoiceCustomFieldsUpdateSchema = z.object({
  customFields: customFieldMapSchema.describe("Invoice custom fields payload"),
});

const invoiceIdItemIdSchema = z.object({
  invoiceId: z.number().int().describe("Invoice ID"),
  itemId: z.number().int().describe("Invoice item ID"),
});

const invoiceItemsUpdateSchema = z.object({
  invoiceId: z.number().int().describe("Invoice ID"),
  payload: invoiceItemPatchSchema.describe(
    "Invoice item patch payload (single item upsert). Omit id to add a line; include it to update.",
  ),
});

const invoiceCustomFieldTypesSchema = dateFilterParams(
  paginationParams(
    z.object({
      ...sortParam(["Id", "Name", "CreatedOn", "ModifiedOn"]),
    }),
  ),
);

const invoiceAdjustmentCreateSchema = z.object({
  payload: z.object({}).passthrough().describe("Invoice adjustment payload"),
});

const invoiceMarkAsExportedSchema = z.object({
  items: z
    .array(z.object({
      invoiceId: z.number().int().describe("Invoice ID"),
      externalId: z.string().nullable().optional(),
      externalMessage: z.string().nullable().optional(),
    }))
    .min(1)
    .describe("Invoices to mark as exported (sent as the API's top-level array)"),
});

export function registerInvoiceTools(
  client: ServiceTitanClient,
  registry: ToolRegistry,
): void {
  registry.register({
    name: "accounting_invoices_create_adjustment",
    domain: "accounting",
    operation: "write",
    description: "Create an adjustment invoice",
    schema: invoiceAdjustmentCreateSchema.shape,
    handler: async (params) => {
      const input = invoiceAdjustmentCreateSchema.parse(params);

      try {
        const data = await client.post("/tenant/{tenant}/invoices", input.payload);
        return toolResult(data);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoices_update_custom_fields",
    domain: "accounting",
    operation: "write",
    description: "Update invoice custom fields",
    schema: invoiceCustomFieldsUpdateSchema.shape,
    handler: async (params) => {
      const input = params as z.infer<typeof invoiceCustomFieldsUpdateSchema>;

      try {
        const data = await client.patch(
          "/tenant/{tenant}/invoices/custom-fields",
          input.customFields,
        );
        return toolResult(data);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoices_update",
    domain: "accounting",
    operation: "write",
    description:
      "Patch an invoice using Accounting v2. Set invoice summary text with payload.summary; payload.memo is unsupported by ServiceTitan.",
    schema: invoiceUpdateSchema.shape,
    handler: async (params) => {
      try {
        const input = invoiceUpdateSchema.parse(params);
        const data = await client.patch(`/tenant/{tenant}/invoices/${input.id}`, input.payload);
        return toolResult(
          data === "" || data === undefined
            ? {
                accepted: true,
                invoiceId: input.id,
                updatedFields: Object.keys(input.payload),
              }
            : data,
        );
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoices_list",
    domain: "accounting",
    operation: "read",
    description: "List one requested page of customer invoice headers using customer, job, business-unit, invoice, date, amount, balance, review, and assignment filters. Use this for filtered invoice search; use estimates or invoice-item tools when the required grain is an estimate or individual line item.",
    schema: invoicesListSchema.shape,
    handler: async (params) => {
      const input = params as z.infer<typeof invoicesListSchema>;

      try {
        const data = await client.get(
          "/tenant/{tenant}/invoices",
          buildParams({
            ids: input.ids,
            modifiedBefore: input.modifiedBefore,
            modifiedOnOrAfter: input.modifiedOnOrAfter,
            statuses: input.statuses,
            batchId: input.batchId,
            batchNumber: input.batchNumber,
            page: input.page,
            pageSize: input.pageSize,
            "customField.Fields": input.customFieldFields,
            "customField.Operator": input.customFieldOperator,
            includeTotal: input.includeTotal,
            jobId: input.jobId,
            jobNumber: input.jobNumber,
            businessUnitId: input.businessUnitId,
            customerId: input.customerId,
            invoicedOnOrAfter: input.invoicedOnOrAfter,
            invoicedOnBefore: input.invoicedOnBefore,
            adjustmentToId: input.adjustmentToId,
            number: input.number,
            createdOnOrAfter: input.createdOnOrAfter,
            createdBefore: input.createdBefore,
            totalGreater: input.totalGreater,
            totalLess: input.totalLess,
            "balanceFilter.Balance": input.balanceFilterBalance,
            "balanceFilter.Comparer": input.balanceFilterComparer,
            dueDateBefore: input.dueDateBefore,
            dueDateOnOrAfter: input.dueDateOnOrAfter,
            orderBy: input.orderBy,
            orderByDirection: input.orderByDirection,
            reviewStatuses: input.reviewStatuses,
            assignedToIds: input.assignedToIds,
            sort: input.sort,
          }),
        );

        return toolResult(data);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoices_custom_field_types_list",
    domain: "accounting",
    operation: "read",
    description: "List one requested page of invoice custom-field definitions, with paging and total-count controls. Use this to resolve the metadata for invoice custom fields; use accounting_invoices_list to retrieve invoice records and their values.",
    schema: invoiceCustomFieldTypesSchema.shape,
    handler: async (params) => {
      const input = params as z.infer<typeof invoiceCustomFieldTypesSchema>;

      try {
        const data = await client.get(
          "/tenant/{tenant}/invoices/custom-fields",
          buildParams({
            page: input.page,
            pageSize: input.pageSize,
            includeTotal: input.includeTotal,
            createdBefore: input.createdBefore,
            createdOnOrAfter: input.createdOnOrAfter,
            modifiedBefore: input.modifiedBefore,
            modifiedOnOrAfter: input.modifiedOnOrAfter,
            sort: input.sort,
          }),
        );

        return toolResult(data);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoice_items_delete",
    domain: "accounting",
    operation: "delete",
    description: "Delete an invoice item",
    schema: invoiceIdItemIdSchema.shape,
    handler: async (params) => {
      const input = params as z.infer<typeof invoiceIdItemIdSchema>;

      try {
        await client.delete(
          `/tenant/{tenant}/invoices/${input.invoiceId}/items/${input.itemId}`,
        );

        return toolResult({
          success: true,
          message: "Invoice item deleted successfully",
        });
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoice_items_update",
    domain: "accounting",
    operation: "write",
    description: "Patch invoice items",
    schema: invoiceItemsUpdateSchema.shape,
    handler: async (params) => {
      const input = params as z.infer<typeof invoiceItemsUpdateSchema>;

      try {
        const data = await client.patch(
          `/tenant/{tenant}/invoices/${input.invoiceId}/items`,
          input.payload,
        );

        return toolResult(data);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: "accounting_invoices_mark_as_exported",
    domain: "accounting",
    operation: "write",
    description: "Mark invoices as exported",
    schema: invoiceMarkAsExportedSchema.shape,
    handler: async (params) => {
      const input = invoiceMarkAsExportedSchema.parse(params);

      try {
        const data = await client.post("/tenant/{tenant}/invoices/markasexported", input.items);
        return toolResult(data);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  });
}
