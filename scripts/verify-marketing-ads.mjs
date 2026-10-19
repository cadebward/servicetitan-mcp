// Opt-in, bounded production/integration reads using the existing .env credentials.
// Run after npm run build: node --env-file=.env scripts/verify-marketing-ads.mjs
// Only field names/counts are printed; never records, credentials, or Axios errors.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, loadConfig } from '../build/server.js';
const names = ['people_performance_get', 'marketing_attributed_leads_get', 'marketing_client_side_data_get'];
const config = loadConfig({...process.env, ST_READONLY:'true', ST_LOG_LEVEL:'error', ST_TOOL_PROFILE:'full', ST_DOMAINS:'people,marketing', ST_TOOLS:names.join(',')});
const {server} = await createMcpServer(config);
const client = new Client({name:'ads-read-verification',version:'1.0.0'});
const [a,b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);
const period = {fromUtc:'2026-09-01T00:00:00Z',toUtc:'2026-10-19T00:00:00Z',page:1,pageSize:1,includeTotal:true};
try {
  for (const [name,args] of [
    ...['Campaign','AdGroup','Keyword'].map(performanceSegmentationType => [names[0],{...period,performanceSegmentationType}]),
    [names[0],{...period,performanceSegmentationType:'Campaign',page:2}],
    [names[1],period], [names[2],{}],
  ]) {
    const result = await client.callTool({name,arguments:args});
    if (result.isError) {
      const error = result.structuredContent?.error;
      console.log(JSON.stringify({name,error:{status:error?.status,code:error?.code,phase:error?.phase}}));
      process.exitCode = 1;
      continue;
    }
    const data = result.structuredContent;
    assert.ok(data && typeof data === 'object', `${name}: missing structured response`);
    if (name === names[2]) {
      for (const field of ['employees','businessUnits','taskPriorities','taskStatuses','taskTypes','taskSources','taskResolutions','taskResolutionTypes']) assert.ok(Array.isArray(data[field]), `${name}: missing ${field}`);
    } else {
      assert.ok(Array.isArray(data.data));
      assert.equal(data.page,args.page);
      assert.equal(typeof data.hasMore,'boolean');
      for (const row of data.data) {
        const required = name === names[0] ? ['campaign','adGroup','keyword','digitalStats','leadStats','returnOnInvestment'] : ['dateTime','leadType','attribution','job','customer','call','leadForm','booking'];
        for (const field of required) assert.ok(field in row, `${name}: missing ${field}`);
      }
    }
    const row = data.data?.[0];
    console.log(JSON.stringify({name,args,environment:config.environment,keys:Object.keys(data),page:data.page,hasMore:data.hasMore,totalCount:data.totalCount,rowKeys:row?Object.keys(row):[],nestedKeys:row?Object.fromEntries(Object.entries(row).filter(([,v])=>v && typeof v==='object').map(([k,v])=>[k,Object.keys(v)])):{} }));
  }
} finally { await client.close(); await server.close(); }
