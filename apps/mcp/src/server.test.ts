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

  it("keeps candidate memory out of normal Agent reads", async () => {
    const shared = new MemoryVault();
    shared.status.memory = [
      {
        id: "candidate-1",
        scope: "user",
        content: "Unconfirmed inference",
        tags: ["candidate"],
        state: "candidate",
        origin: { type: "agent", label: "codex" },
        createdByAgentId: "codex",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "confirmed-1",
        scope: "user",
        content: "Confirmed preference",
        tags: ["confirmed"],
        state: "confirmed",
        origin: { type: "manual", label: "One Status Dashboard" },
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
    ];

    const normal = await callTool(shared, "claude-code", "status_get_memory", {});
    expect(JSON.stringify(normal)).toContain("Confirmed preference");
    expect(JSON.stringify(normal)).not.toContain("Unconfirmed inference");

    const rawStatus = await callTool(shared, "claude-code", "read_status", {});
    expect(JSON.stringify(rawStatus)).toContain("Confirmed preference");
    expect(JSON.stringify(rawStatus)).not.toContain("Unconfirmed inference");

    const review = await callTool(shared, "claude-code", "status_get_memory", {
      includeCandidates: true,
    });
    expect(JSON.stringify(review)).toContain("Unconfirmed inference");

    const rawReview = await callTool(shared, "claude-code", "read_status", {
      includeCandidates: true,
    });
    expect(JSON.stringify(rawReview)).toContain("Unconfirmed inference");
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
      "capabilities_get",
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

    const capabilities = await client.callTool({
      name: "capabilities_get",
      arguments: {},
    });
    expect(JSON.stringify(capabilities.structuredContent)).toContain(
      "google-workspace",
    );
    expect(JSON.stringify(capabilities.structuredContent)).not.toContain(
      "calendar.events.list",
    );

    const capabilityTools = await client.callTool({
      name: "capabilities_get",
      arguments: { includeTools: true },
    });
    expect(JSON.stringify(capabilityTools.structuredContent)).toContain(
      "calendar.events.list",
    );

    await client.close();
    await server.close();
  });

  it("exposes approved OAuth actions without exposing credentials", async () => {
    let executedInput: unknown;
    let approvalInput: unknown;
    const server = createMcpServer(new MemoryVault(), "codex", {
      async list() {
        return { connections: [{ id: "connection-1" }] };
      },
      async execute(input) {
        executedInput = input;
        return { action: input.action, ok: true };
      },
      async requestApproval(input) {
        approvalInput = input;
        return {
          approval: {
            id: "8aac7c59-f780-4ebb-a72e-b3c9ecbbf999",
            status: "pending",
          },
          dashboardUrl: "http://127.0.0.1:8787/integrations",
        };
      },
    });
    const client = new Client({ name: "tool-gateway-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("tools_list");
    expect(tools.tools.map((tool) => tool.name)).toContain("tools_execute");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "tools_request_approval",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain("capabilities_get");
    expect(client.getInstructions()).toContain(
      "call tools_list first and prefer the One Status Gateway",
    );
    expect(client.getInstructions()).toContain(
      "instead of requesting provider credentials",
    );

    const listTool = tools.tools.find((tool) => tool.name === "tools_list");
    expect(listTool?.description).toContain(
      "Call this first for email, calendar, files, collaboration",
    );
    expect(listTool?.description).toContain("inputSchema");
    expect(listTool?.description).toContain("never returns provider credentials");
    const executeTool = tools.tools.find((tool) => tool.name === "tools_execute");
    expect(executeTool?.inputSchema).toMatchObject({
      properties: {
        approvalId: { format: "uuid", type: "string" },
      },
    });
    expect(executeTool?.inputSchema.properties).not.toHaveProperty("confirmed");

    const listResult = await client.callTool({
      name: "tools_list",
      arguments: {},
    });
    expect(listResult.structuredContent).toEqual({
      connections: [{ id: "connection-1" }],
    });
    const approvalResult = await client.callTool({
      name: "tools_request_approval",
      arguments: {
        connectionId: "2cc16694-140d-4575-8189-3283163c15c7",
        action: "github.issues.create",
        arguments: { title: "Approved once" },
      },
    });
    expect(JSON.stringify(approvalResult)).toContain(
      "8aac7c59-f780-4ebb-a72e-b3c9ecbbf999",
    );
    expect(approvalInput).toEqual({
      action: "github.issues.create",
      arguments: { title: "Approved once" },
      connectionId: "2cc16694-140d-4575-8189-3283163c15c7",
    });
    const executeResult = await client.callTool({
      name: "tools_execute",
      arguments: {
        connectionId: "2cc16694-140d-4575-8189-3283163c15c7",
        action: "calendar.events.list",
        arguments: {},
        approvalId: "8aac7c59-f780-4ebb-a72e-b3c9ecbbf999",
      },
    });
    expect(JSON.stringify(executeResult)).toContain("calendar.events.list");
    expect(executedInput).toEqual({
      action: "calendar.events.list",
      arguments: {},
      approvalId: "8aac7c59-f780-4ebb-a72e-b3c9ecbbf999",
      connectionId: "2cc16694-140d-4575-8189-3283163c15c7",
    });

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
