import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { createMcpServer, type Vault } from "./server.js";

describe("One Status MCP", () => {
  it("writes with one MCP client and reads with another", async () => {
    const shared = new MemoryVault();
    await callTool(shared, "claude-code", "write_status", {
      mutationId: "0bcd9fa9-b1e4-48b6-8420-f623c8d8523e",
      mutation: {
        type: "upsert_project",
        id: "one-status",
        name: "One Status",
        techStack: ["TypeScript", "SQLite"],
        currentGoal: "Build MCP Gateway",
      },
    });
    await callTool(shared, "claude-code", "write_status", {
      mutationId: "7ce185e3-7c2e-4827-a641-883d59c46df1",
      mutation: {
        type: "set_preference",
        key: "packageManager",
        value: "pnpm",
      },
    });

    const response = await callTool(shared, "codex", "status_get_context", {});
    expect(JSON.stringify(response)).toContain("One Status");
    expect(shared.status.preferences.packageManager).toBe("pnpm");
  });

  it("lists the focused Phase 1 tool surface", async () => {
    const server = createMcpServer(new MemoryVault(), "codex");
    const client = new Client({ name: "tool-list-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "read_status",
      "write_status",
      "status_get_profile",
      "status_get_memory",
      "status_search_memory",
      "status_get_project",
      "status_get_context",
      "status_update_context",
    ]);
    expect(client.getInstructions()).toContain(
      "call status_get_context before inspecting repository files",
    );

    const contextTool = tools.tools.find(
      (tool) => tool.name === "status_get_context",
    );
    expect(contextTool).toMatchObject({
      title: "Get current One Status context",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });

    await client.close();
    await server.close();
  });

  it("exposes approved OAuth actions without exposing credentials", async () => {
    const server = createMcpServer(new MemoryVault(), "codex", {
      async list() {
        return { connections: [{ id: "connection-1" }] };
      },
      async execute(input) {
        return { action: input.action, ok: true };
      },
    });
    const client = new Client({ name: "tool-gateway-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("tools_list");
    expect(tools.tools.map((tool) => tool.name)).toContain("tools_execute");

    const listResult = await client.callTool({
      name: "tools_list",
      arguments: {},
    });
    expect(listResult.structuredContent).toEqual({
      connections: [{ id: "connection-1" }],
    });
    const executeResult = await client.callTool({
      name: "tools_execute",
      arguments: {
        connectionId: "2cc16694-140d-4575-8189-3283163c15c7",
        action: "calendar.events.list",
        arguments: {},
      },
    });
    expect(JSON.stringify(executeResult)).toContain("calendar.events.list");

    await client.close();
    await server.close();
  });
});

class MemoryVault implements Vault {
  status: StatusDocument = createEmptyStatus();
  version = 0;

  async read() {
    return {
      version: this.version,
      status: structuredClone(this.status),
      updatedAt: null,
    };
  }

  async mutate(mutation: (draft: StatusDocument) => void) {
    const next = structuredClone(this.status);
    mutation(next);
    this.status = next;
    this.version += 1;
    return this.read();
  }
}

async function callTool(
  vault: Vault,
  agentId: string,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const server = createMcpServer(vault, agentId);
  const client = new Client({ name: agentId, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({ name, arguments: arguments_ });
  await client.close();
  await server.close();
  return response;
}
