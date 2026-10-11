import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolRegistry } from "../src/registry.js";
import { OAuthAccess } from "../src/oauth.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { AuditLogger } from "../src/audit.js";
const config = loadConfig({ ST_CLIENT_ID:"test",ST_CLIENT_SECRET:"test",ST_APP_KEY:"test",ST_TENANT_ID:"test",ST_READONLY:"false",ST_EXPERIMENTAL_WRITES:"true" });
const oauth = new OAuthAccess({ issuer:"https://tenant.auth0.com/",resource:"https://mcp.example.com/mcp",scope:"servicetitan:read",
  allowedSubjects:["auth0|Alice"],allowedClientIds:["client"] },async () => {throw new Error("unused");});
const logger = new Logger("error");

describe("OAuth tool policy", () => {
  it("advertises OAuth tool metadata through the real SDK and rejects unverified metadata", async () => {
    const server = new McpServer({name:"test",version:"1"});
    const registry = new ToolRegistry(server,config,logger,new AuditLogger(logger),oauth);
    const handler = vi.fn(async () => ({content:[{type:"text" as const,text:"private data"}]}));
    registry.register({name:"read_data",domain:"crm",operation:"read",schema:{},handler});
    const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({name:"test",version:"1"});
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const list = await client.listTools();
      expect(list.tools[0]._meta?.securitySchemes).toEqual([{type:"oauth2",scopes:["servicetitan:read"]}]);
      const result = await client.callTool({name:"read_data",arguments:{},_meta:{caller:"auth0|Alice"}});
      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toBeDefined();
      expect(handler).not.toHaveBeenCalled();
    } finally {await client.close();await server.close();}
  });
  const verified = () => ({authInfo:{clientId:"client",scopes:["servicetitan:read"],expiresAt:Date.now()/1000+60,extra:{sub:"auth0|Alice"}}});

  function setup(readonlyMode = false, confirmWrites = false) {
    const server = {registerTool:vi.fn()};
    const audit = {log:vi.fn()};
    const registry = new ToolRegistry(server as any,{...config,readonlyMode,confirmWrites},logger,audit as any,oauth);
    const handlers = {read:vi.fn(),write:vi.fn(),delete:vi.fn()};
    for (const operation of ["read","write","delete"] as const) {
      handlers[operation].mockResolvedValue({content:[{type:"text",text:"ok"}]});
      registry.register({name:operation,domain:"crm",operation,schema:{},handler:handlers[operation]});
    }
    const call = (operation: string, params: unknown = {}, extra: any = verified()) =>
      server.registerTool.mock.calls.find(([name]) => name === operation)![2](params,extra);
    return {handlers,call,audit,server};
  }

  it("permits verified reads, writes, and confirmed deletes when readonly is disabled", async () => {
    const {handlers,call,audit} = setup();
    for (const operation of ["read","write","delete"] as const) {
      expect((await call(operation,{confirm:true})).isError).not.toBe(true);
      expect(handlers[operation]).toHaveBeenCalledOnce();
    }
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it("blocks writes and deletes when readonly is enabled", async () => {
    const {handlers,call,server} = setup(true);
    expect((await call("read")).isError).not.toBe(true);
    for (const operation of ["write","delete"] as const) {
      expect(server.registerTool.mock.calls.some(([name]) => name === operation)).toBe(false);
      expect(handlers[operation]).not.toHaveBeenCalled();
    }
  });

  it("preserves write and delete confirmation requirements", async () => {
    const {handlers,call} = setup(false,true);
    await call("write");
    await call("delete");
    expect(handlers.write).not.toHaveBeenCalled();
    expect(handlers.delete).not.toHaveBeenCalled();
    expect((await call("write",{_confirmed:true})).isError).not.toBe(true);
    expect((await call("delete",{confirm:true})).isError).not.toBe(true);
    expect(handlers.write).toHaveBeenCalledOnce();
    expect(handlers.delete).toHaveBeenCalledOnce();
  });

  it("rejects mutations for missing, spoofed, expired, or unauthorized identity", async () => {
    const {handlers,call} = setup();
    const auth = verified().authInfo;
    const denied = [
      {}, {_meta:{sub:"auth0|Alice",clientId:"client",scopes:["servicetitan:read"]}},
      {authInfo:{...auth,clientId:"other"}},
      {authInfo:{...auth,extra:{sub:"auth0|Mallory"}}},
      {authInfo:{...auth,scopes:[]}},
      {authInfo:{...auth,expiresAt:Date.now()/1000-60}},
    ];
    for (const extra of denied) {
      for (const operation of ["write","delete"]) {
        expect((await call(operation,{confirm:true,_confirmed:true},extra)).isError).toBe(true);
      }
    }
    expect(handlers.write).not.toHaveBeenCalled();
    expect(handlers.delete).not.toHaveBeenCalled();
  });
});
