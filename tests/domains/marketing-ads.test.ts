import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { ServiceTitanClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { registerMarketingAttributionTools } from '../../src/domains/marketing/attributions.js';
import { registerPeopleTechnicianTools } from '../../src/domains/people/technicians.js';
import type { ToolDefinition, ToolRegistry } from '../../src/registry.js';

const period = { fromUtc: '2026-10-01T00:00:00Z', toUtc: '2026-10-02T00:00:00Z' };
const performance = 'people_performance_get';
const leads = 'marketing_attributed_leads_get';
const reference = 'marketing_client_side_data_get';
const response = (config: InternalAxiosRequestConfig, data: unknown, status = 200) => ({ config, data, status, statusText: String(status), headers: {} });
function setup(payload: unknown = { page: 1, pageSize: 1, hasMore: false, data: [] }, status = 200) {
  const requests: InternalAxiosRequestConfig[] = [];
  const config = loadConfig({ ST_CLIENT_ID: 'fixture', ST_CLIENT_SECRET: 'secret-fixture', ST_APP_KEY: 'key-fixture', ST_TENANT_ID: '42', ST_READONLY: 'true' });
  const client = new ServiceTitanClient(config, {
    authAdapter: async c => response(c, { access_token: 'token-fixture', expires_in: 900 }),
    adapter: async c => {
      requests.push(c);
      if (status !== 200) throw new AxiosError('HTTP failure', 'ERR_BAD_REQUEST', c, undefined, response(c, payload, status));
      return response(c, payload);
    },
  });
  const tools = new Map<string, ToolDefinition>();
  const registry = { register: (t: ToolDefinition) => tools.set(t.name, t) } as ToolRegistry;
  registerMarketingAttributionTools(client, registry);
  registerPeopleTechnicianTools(client, registry);
  return { requests, call: (name: string, args: unknown) => tools.get(name)!.handler(args) };
}

describe('Marketing Ads named handlers through real HTTP client', () => {
  it.each(['Campaign', 'AdGroup', 'Keyword'])('serializes %s segmentation and pagination without a body', async segmentation => {
    const payload = { page: 2, pageSize: 1, hasMore: true, totalCount: 4, data: [{ digitalStats: { impressions: 20, clicks: 3, cost: 4.5 }, leadStats: { leads: 2, bookedJobs: 1, revenue: 100 }, returnOnInvestment: null }] };
    const { call, requests } = setup(payload);
    const args = { ...period, performanceSegmentationType: segmentation, page: 2, pageSize: 1, includeTotal: false };
    const result = await call(performance, args);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'get', url: '/marketingads/v2/tenant/42/performance', params: args });
    expect(requests[0].data).toBeUndefined();
    const url = new URL(axios.getUri(requests[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(Object.entries(args).map(([k,v]) => [k,String(v)])));
  });
  it.each([undefined, 'Call', 'WebBooking', 'WebLeadForm', 'ManualJob'])('serializes lead filter %s and preserves pagination', async leadType => {
    const { call, requests } = setup();
    await call(leads, { ...period, leadType, page: 3, pageSize: 2, includeTotal: true });
    expect(requests[0].url).toBe('/marketingads/v2/tenant/42/attributed-leads');
    const query = new URL(axios.getUri(requests[0])).searchParams;
    expect(query.get('leadType')).toBe(leadType ?? null);
    expect(query.get('page')).toBe('3');
    expect(query.get('fromUtc')).toBe(period.fromUtc);
    expect(query.get('toUtc')).toBe(period.toUtc);
    expect(requests[0].data).toBeUndefined();
  });
  it('keeps the legacy reference tool on Task Management, without date or pagination inputs', async () => {
    const payload = { employees: [], businessUnits: [], taskPriorities: [], taskResolutionTypes: [], taskStatuses: [], taskTypes: [], taskSources: [], taskResolutions: [] };
    const { call, requests } = setup(payload);
    expect((await call(reference, {})).structuredContent).toEqual(payload);
    expect(requests[0]).toMatchObject({ method: 'get', url: '/taskmanagement/v2/tenant/42/data' });
    expect(requests[0].params).toBeUndefined();
  });
  it.each([performance, leads])('rejects invalid ranges and pagination before HTTP for %s', async name => {
    for (const invalid of [{fromUtc:'bad'}, {toUtc:'2026-09-01T00:00:00Z'}, {toUtc:period.fromUtc}, {page:0}, {pageSize:0}, {page:1.5}]) {
      const { call, requests } = setup();
      const result = await call(name, {...period, ...(name === performance ? {performanceSegmentationType:'Campaign'} : {}), ...invalid});
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    }
  });
  it.each([[performance, {...period, performanceSegmentationType:'Other'}], [leads, {...period,leadType:'Other'}]])('rejects invalid enum for %s', async (name,args) => {
    const {call,requests} = setup();
    expect((await call(name as string,args)).isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
  it.each([400,403,404])('retains upstream diagnostics and redacts secrets for HTTP %s', async status => {
    const {call} = setup({message:'Unable to match incoming request to an operation. secret-fixture key-fixture token-fixture',traceId:'trace-test'},status);
    const result = await call(performance,{...period,performanceSegmentationType:'Campaign'});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({error:{status,path:'/marketingads/v2/tenant/42/performance',phase:'resource',traceId:'trace-test',retryable:false}});
    const text = JSON.stringify(result);
    expect(text).toContain('Unable to match incoming request');
    for (const secret of ['secret-fixture','key-fixture','token-fixture']) expect(text).not.toContain(secret);
  });
});
