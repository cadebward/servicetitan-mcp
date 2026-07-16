import { z } from "zod";

import type { ServiceTitanClient } from "../../client.js";

type PricebookItem = {
  id?: unknown;
  code?: unknown;
  displayName?: unknown;
  name?: unknown;
  price?: unknown;
  memberPrice?: unknown;
  active?: unknown;
};

type PricebookSearchInput = Record<string, unknown> & {
  code?: string;
  codes?: string;
  name?: string;
  lean?: boolean;
  page?: number;
  pageSize?: number;
};

type PricebookPage = {
  data?: unknown;
  hasMore?: unknown;
};

const API_SCAN_PAGE_SIZE = 500;

export const pricebookSearchFilterParams = {
  code: z.string().optional().describe("Exact pricebook item code/SKU filter"),
  codes: z.string().optional().describe("Comma-separated pricebook item codes/SKUs"),
  name: z
    .string()
    .optional()
    .describe("Name or displayName substring search filter"),
  lean: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return summary fields only: id, code, displayName, price, memberPrice, active"),
};

export function hasPricebookSearchFilter(params: Record<string, unknown>): boolean {
  return typeof params.code === "string" || typeof params.codes === "string" || typeof params.name === "string";
}

export function withoutMcpSearchParams(params: Record<string, unknown>): Record<string, unknown> {
  const {
    code: _code,
    codes: _codes,
    name: _name,
    lean: _lean,
    page: _page,
    pageSize: _pageSize,
    includeTotal: _includeTotal,
    ...queryParams
  } = params;
  return queryParams;
}

export async function searchPricebookItems(
  client: ServiceTitanClient,
  path: string,
  input: PricebookSearchInput,
): Promise<unknown> {
  const matches: unknown[] = [];
  const returnPage = input.page ?? 1;
  const returnPageSize = input.pageSize ?? 50;
  let apiPage = 1;
  let hasMore = true;

  while (hasMore) {
    const response = (await client.get(path, {
      ...withoutMcpSearchParams(input),
      page: apiPage,
      pageSize: API_SCAN_PAGE_SIZE,
      includeTotal: false,
    })) as PricebookPage;

    const items = Array.isArray(response.data) ? response.data : [];
    matches.push(...items.filter((item) => matchesPricebookSearch(item, input)));

    hasMore = response.hasMore === true && items.length > 0;
    apiPage += 1;
  }

  const start = (returnPage - 1) * returnPageSize;
  const data = matches.slice(start, start + returnPageSize);

  return {
    page: returnPage,
    pageSize: returnPageSize,
    totalCount: matches.length,
    hasMore: start + returnPageSize < matches.length,
    data: input.lean === false ? data : data.map(summarizePricebookItem),
  };
}

export function summarizePricebookResponse(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  const items = data.data;
  if (!Array.isArray(items)) {
    return data;
  }

  return {
    ...data,
    data: items.map(summarizePricebookItem),
  };
}

function summarizePricebookItem(item: unknown): Record<string, unknown> | unknown {
  if (!isRecord(item)) {
    return item;
  }

  const pricebookItem = item as PricebookItem;
  return {
    id: pricebookItem.id,
    code: pricebookItem.code,
    displayName: pricebookItem.displayName ?? pricebookItem.name,
    price: pricebookItem.price,
    memberPrice: pricebookItem.memberPrice,
    active: pricebookItem.active,
  };
}

function matchesPricebookSearch(item: unknown, input: PricebookSearchInput): boolean {
  if (!isRecord(item)) {
    return false;
  }

  const itemCode = stringValue(item.code).toLowerCase();
  const displayName = stringValue(item.displayName ?? item.name).toLowerCase();
  const exactCodes = new Set(
    [
      ...(input.code ? [input.code] : []),
      ...(input.codes?.split(",") ?? []),
    ]
      .map((code) => code.trim().toLowerCase())
      .filter(Boolean),
  );
  const name = input.name?.trim().toLowerCase();

  if (exactCodes.size > 0 && !exactCodes.has(itemCode)) {
    return false;
  }

  if (name && !displayName.includes(name)) {
    return false;
  }

  return exactCodes.size > 0 || Boolean(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
