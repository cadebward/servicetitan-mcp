import { z } from "zod";

import type { ServiceTitanClient } from "../../client.js";
import type { ToolRegistry } from "../../registry.js";
import {
  activeFilterParam,
  buildParams,
  dateFilterParams,
  paginationParams,
  toolError,
  toolResult,
  getErrorMessage,
} from "../../utils.js";
import {
  estimateItemRequestSchema,
  normalizeEstimateItemRequest,
} from "./item-request.js";

const estimateItemPayloadSchema = estimateItemRequestSchema.omit({ id: true });

const estimateItemsListSchema = dateFilterParams(
  paginationParams(
    z.object({
      estimateId: z.number().int().optional().describe("Filter by estimate ID"),
      ids: z
        .string()
        .optional()
        .describe("Comma-separated estimate item IDs (maximum 50)"),
    }).extend(activeFilterParam()),
  ),
);

const estimateItemUpdateSchema = estimateItemPayloadSchema.extend({
  estimateId: z.number().int().optional().describe("Estimate ID"),
  id: z
    .number()
    .int()
    .optional()
    .describe("Legacy estimate ID alias. Prefer estimateId."),
  itemId: z
    .number()
    .int()
    .optional()
    .describe("Existing estimate item ID to update; omit to add a new line item"),
});

const estimateItemDeleteSchema = z.object({
  id: z.number().int().describe("Estimate ID"),
  itemId: z.number().int().describe("Estimate item ID"),
});

type EstimateItemPayload = z.infer<typeof estimateItemPayloadSchema>;

type EstimateItemRecord = Record<string, unknown> & {
  id?: number;
  sku?: {
    id?: number;
    displayName?: string;
  };
};

type EstimateItemsListResponse = {
  data?: unknown;
};

const UPDATE_VERIFY_ATTEMPTS = 5;
const UPDATE_VERIFY_DELAY_MS = process.env.NODE_ENV === "test" ? 0 : 1_000;

function mergeEstimateItemUpdate(
  current: EstimateItemRecord,
  item: EstimateItemPayload,
): EstimateItemPayload {
  return {
    skuId: item.skuId ?? current.sku?.id,
    skuName: item.skuName ?? current.sku?.displayName,
    parentItemId: item.parentItemId ?? numberValue(current.parentItemId),
    description: item.description ?? stringValue(current.description),
    isAddOn: item.isAddOn ?? booleanValue(current.isAddOn ?? current.addOn),
    quantity:
      item.quantity ?? item.qty ?? numberValue(current.quantity ?? current.qty),
    unitPrice:
      item.unitPrice ?? item.unitRate ?? numberValue(current.unitPrice ?? current.unitRate),
    unitCost: item.unitCost ?? numberValue(current.unitCost),
    skipUpdatingMembershipPrices:
      item.skipUpdatingMembershipPrices ??
      booleanValue(current.skipUpdatingMembershipPrices),
    itemGroupName: item.itemGroupName ?? stringValue(current.itemGroupName),
    itemGroupRootId: item.itemGroupRootId ?? numberValue(current.itemGroupRootId),
    chargeable: item.chargeable ?? booleanValue(current.chargeable),
    useDefaultProjectLabels:
      item.useDefaultProjectLabels ?? booleanValue(current.useDefaultProjectLabels),
    budgetCodeId: item.budgetCodeId ?? numberValue(current.budgetCodeId),
    membershipDurationBillingId:
      item.membershipDurationBillingId ??
      numberValue(current.membershipDurationBillingId),
  };
}

async function getEstimateItem(
  client: ServiceTitanClient,
  itemId: number,
): Promise<EstimateItemRecord | null> {
  const response = (await client.get(
    "/tenant/{tenant}/estimates/items",
    buildParams({
      ids: String(itemId),
      active: "Any",
      pageSize: 5,
    }),
  )) as EstimateItemsListResponse;
  const data = Array.isArray(response.data) ? response.data : [];
  const item = data.find((entry) => isRecord(entry) && entry.id === itemId);
  return isRecord(item) ? item : null;
}

async function getVerifiedEstimateItem(
  client: ServiceTitanClient,
  itemId: number,
  requested: Partial<EstimateItemPayload>,
): Promise<EstimateItemRecord | null> {
  for (let attempt = 1; attempt <= UPDATE_VERIFY_ATTEMPTS; attempt += 1) {
    const item = await getEstimateItem(client, itemId);
    if (item && estimateItemMatchesRequested(item, requested)) {
      return item;
    }

    if (attempt < UPDATE_VERIFY_ATTEMPTS) {
      await sleep(UPDATE_VERIFY_DELAY_MS);
    }
  }

  return null;
}

function estimateItemMatchesRequested(
  item: EstimateItemRecord,
  requested: Partial<EstimateItemPayload>,
): boolean {
  const requestedQuantity = requested.quantity ?? requested.qty;
  const requestedUnitPrice = requested.unitPrice ?? requested.unitRate;

  return (
    matchesNumber(item.quantity ?? item.qty, requestedQuantity) &&
    matchesNumber(item.unitPrice ?? item.unitRate, requestedUnitPrice) &&
    matchesNumber(item.unitCost, requested.unitCost) &&
    matchesBoolean(item.chargeable, requested.chargeable) &&
    matchesString(item.description, requested.description)
  );
}

function buildVerificationError(
  itemId: number,
  requested: Partial<EstimateItemPayload>,
  apiResponse: unknown,
  freshItem: EstimateItemRecord | null,
): string {
  return JSON.stringify(
    {
      message: "Estimate item update was not persisted by ServiceTitan",
      itemId,
      requested: buildParams({
        quantity: requested.quantity ?? requested.qty,
        unitPrice: requested.unitPrice ?? requested.unitRate,
        unitCost: requested.unitCost,
        chargeable: requested.chargeable,
        description: requested.description,
      }),
      apiResponse: summarizeEstimateItem(apiResponse),
      freshItem: summarizeEstimateItem(freshItem),
    },
    null,
    2,
  );
}

function summarizeEstimateItem(item: unknown): unknown {
  if (!isRecord(item)) {
    return item;
  }

  return buildParams({
    id: item.id,
    skuId: isRecord(item.sku) ? item.sku.id : undefined,
    qty: item.qty,
    unitRate: item.unitRate,
    total: item.total,
    unitCost: item.unitCost,
    totalCost: item.totalCost,
    chargeable: item.chargeable,
    description: item.description,
    modifiedOn: item.modifiedOn,
  });
}

export function registerEstimateItemTools(client: ServiceTitanClient, registry: ToolRegistry) {
  registry.register({
    name: "estimates_items_list",
    domain: "estimates",
    operation: "read",
    description: "List estimate items with optional filters",
    schema: estimateItemsListSchema.shape,
    handler: async (params) => {
      const parsed = estimateItemsListSchema.parse(params);

      try {
        const data = await client.get(
          "/tenant/{tenant}/estimates/items",
          buildParams({
            estimateId: parsed.estimateId,
            ids: parsed.ids,
            active: parsed.active,
            createdBefore: parsed.createdBefore,
            createdOnOrAfter: parsed.createdOnOrAfter,
            modifiedBefore: parsed.modifiedBefore,
            modifiedOnOrAfter: parsed.modifiedOnOrAfter,
            page: parsed.page,
            pageSize: parsed.pageSize,
            includeTotal: parsed.includeTotal,
          }),
        );

        return toolResult(data);
      } catch (error: unknown) {
        return toolError(getErrorMessage(error));
      }
    },
  });

  registry.register({
    name: "estimates_items_update",
    domain: "estimates",
    operation: "write",
    description: "Add a new SKU line or update an existing item on an estimate",
    schema: estimateItemUpdateSchema.shape,
    handler: async (params) => {
      const parsed = estimateItemUpdateSchema.parse(params);
      const { estimateId, id, itemId, ...item } = parsed;
      const resolvedEstimateId = estimateId ?? id;

      if (resolvedEstimateId === undefined) {
        return toolError("estimateId is required");
      }

      try {
        const currentItem = itemId === undefined ? null : await getEstimateItem(client, itemId);
        if (itemId !== undefined && currentItem === null) {
          return toolError(`Estimate item ${itemId} was not found`);
        }

        const itemPayload =
          itemId === undefined || currentItem === null
            ? item
            : mergeEstimateItemUpdate(currentItem, item);
        const data = await client.put(
          `/tenant/{tenant}/estimates/${resolvedEstimateId}/items`,
          normalizeEstimateItemRequest({
            id: itemId,
            ...itemPayload,
          }),
        );

        if (itemId === undefined) {
          return toolResult(data);
        }

        const verifiedItem = await getVerifiedEstimateItem(client, itemId, item);
        if (verifiedItem === null) {
          const freshItem = await getEstimateItem(client, itemId);
          return toolError(buildVerificationError(itemId, item, data, freshItem));
        }

        return toolResult(verifiedItem);
      } catch (error: unknown) {
        return toolError(getErrorMessage(error));
      }
    },
  });

  registry.register({
    name: "estimates_items_delete",
    domain: "estimates",
    operation: "delete",
    description: "Delete a single item from an estimate",
    schema: estimateItemDeleteSchema.shape,
    handler: async (params) => {
      const { id, itemId } = estimateItemDeleteSchema.parse(params);

      try {
        await client.delete(`/tenant/{tenant}/estimates/${id}/items/${itemId}`);
        return toolResult({ success: true, message: "Estimate item deleted" });
      } catch (error: unknown) {
        return toolError(getErrorMessage(error));
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function matchesNumber(actual: unknown, expected: number | undefined): boolean {
  return (
    expected === undefined ||
    (typeof actual === "number" && Math.abs(actual - expected) < 0.0001)
  );
}

function matchesBoolean(actual: unknown, expected: boolean | undefined): boolean {
  return expected === undefined || actual === expected;
}

function matchesString(actual: unknown, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
