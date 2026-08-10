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
      "persona.record",
      "persona.list",
      "persona.profile",
      "persona.update",
      "persona.delete",
      "persona.get_policy",
      "persona.set_policy",
      "status_update_context",
    ]);
    expect(client.getInstructions()).toContain(
      "call status_get_context before inspecting repository files",
    );
    expect(client.getInstructions()).toContain(
      "call persona.record with a concise structured observation",
    );
    expect(client.getInstructions()).toContain("never send raw messages");

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

  it("shares a deduplicated Persona across Agents with editable policy", async () => {
    const shared = new MemoryVault();
    await callTool(shared, "codex", "persona.record", {
      category: "language_style",
      content: "Prefer concise Chinese technical answers",
      observedAt: "2026-08-09T14:30:00.000Z",
      sourceProject: "one-status",
      confidence: "explicit",
    });
    await callTool(shared, "claude-code", "persona.record", {
      category: "language_style",
      content: "  PREFER CONCISE CHINESE TECHNICAL ANSWERS ",
      observedAt: "2026-08-09T15:30:00.000Z",
      sourceProject: "one-status",
      confidence: "observed",
    });

    const profile = await callTool(shared, "codex", "persona.profile", {});
    expect(profile.structuredContent).toMatchObject({
      version: 2,
      profile: {
        language_style: {
          content: "Prefer concise Chinese technical answers",
          observationCount: 2,
          confidence: "explicit",
        },
      },
    });
    const events = await callTool(shared, "claude-code", "persona.list", {
      sourceAgent: "claude-code",
    });
    expect(events.structuredContent).toMatchObject({
      events: [
        {
          sourceAgent: "codex",
          observationCount: 2,
          lastObservedAt: "2026-08-09T15:30:00.000Z",
          observations: [
            { sourceAgent: "codex", confidence: "explicit" },
            { sourceAgent: "claude-code", confidence: "observed" },
          ],
        },
      ],
    });

    const eventId = shared.status.persona.events[0]!.id;
    await callTool(shared, "codex", "persona.update", {
      id: eventId,
      content: "Prefer direct Chinese technical answers",
    });
    expect(shared.status.persona.profile.language_style?.content).toBe(
      "Prefer direct Chinese technical answers",
    );

    const policy = await callTool(shared, "codex", "persona.set_policy", {
      blockedCategories: ["personal_info"],
      allowedConfidences: ["explicit", "observed"],
    });
    expect(policy.structuredContent).toMatchObject({
      policy: {
        enabled: true,
        blockedCategories: ["personal_info"],
        allowedConfidences: ["explicit", "observed"],
      },
    });

    await callTool(shared, "codex", "persona.delete", { id: eventId });
    expect(shared.status.persona.events).toEqual([]);
    expect(shared.status.persona.profile).toEqual({});
  });

  it("hides user-blocked Persona categories from every Agent read path", async () => {
    const shared = new MemoryVault();
    await callTool(shared, "codex", "persona.record", {
      category: "language_style",
      content: "Prefer concise Chinese answers",
      confidence: "explicit",
    });
    await callTool(shared, "codex", "persona.record", {
      category: "personal_info",
      content: "Preferred display name is Ryan",
      confidence: "explicit",
    });
    await callTool(shared, "codex", "persona.set_policy", {
      blockedCategories: ["personal_info"],
    });

    const listed = await callTool(shared, "claude-code", "persona.list", {});
    const profile = await callTool(shared, "claude-code", "persona.profile", {});
    const blockedProfile = await callTool(
      shared,
      "claude-code",
      "persona.profile",
      { category: "personal_info" },
    );
    const status = await callTool(shared, "claude-code", "read_status", {
      section: "persona",
    });
    const durableProfile = await callTool(
      shared,
      "claude-code",
      "status_get_profile",
      {},
    );

    for (const response of [listed, profile, status, durableProfile]) {
      expect(JSON.stringify(response.structuredContent)).toContain(
        "language_style",
      );
      expect(JSON.stringify(response.structuredContent)).not.toContain(
        "Preferred display name is Ryan",
      );
    }
    expect(listed.structuredContent).toMatchObject({
      events: [expect.objectContaining({ category: "language_style" })],
    });
    expect(
      Object.keys(
        (profile.structuredContent as {
          profile: Record<string, unknown>;
        }).profile,
      ),
    ).toEqual(["language_style"]);
    expect(status.structuredContent).toMatchObject({
      data: {
        events: [expect.objectContaining({ category: "language_style" })],
        policy: { blockedCategories: ["personal_info"] },
      },
    });
    expect(
      Object.keys(
        (status.structuredContent as {
          data: { profile: Record<string, unknown> };
        }).data.profile,
      ),
    ).toEqual(["language_style"]);
    expect(
      Object.keys(
        (durableProfile.structuredContent as {
          personaProfile: Record<string, unknown>;
        }).personaProfile,
      ),
    ).toEqual(["language_style"]);
    expect(blockedProfile.structuredContent).toMatchObject({ profile: null });
    expect(shared.status.persona.events).toHaveLength(2);
    expect(shared.status.persona.profile.personal_info?.content).toBe(
      "Preferred display name is Ryan",
    );
  });

  it("exposes approved OAuth actions without exposing credentials", async () => {
    let executedInput: unknown;
    let approvalInput: unknown;
    const server = createMcpServer(new MemoryVault(), "codex", {
      async deleteCredential() {
        return { deleted: true };
      },
      async list() {
        return { connections: [{ id: "connection-1" }] };
      },
      async listCredentials() {
        return { credentials: [] };
      },
      async registerCredential() {
        return { credential: {} };
      },
      async resolveCredential() {
        return { credentials: [] };
      },
      async getCredential() {
        return { credential: {} };
      },
      async updateCredential() {
        return { credential: {} };
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

  it("registers, resolves, reads, updates, and deletes private credentials", async () => {
    const secret = "ssh-password-private-value";
    const credentialId = "fca88ca5-f8a1-4fe1-8c35-f89bb5664a2d";
    const calls: Array<{ input: unknown; operation: string }> = [];
    const masked = {
      id: credentialId,
      kind: "ssh",
      label: "One Status production server",
      purposes: ["ssh.connect"],
      fields: { host: "124.220.104.225", username: "ubuntu" },
      secrets: { password: "********" },
      tags: ["one-status", "production"],
    };
    const server = createMcpServer(new MemoryVault(), "codex", {
      async deleteCredential(id) {
        calls.push({ operation: "delete", input: id });
        return { credentialId: id, deleted: true };
      },
      async execute() {
        return {};
      },
      async getCredential(input) {
        calls.push({ operation: "get", input });
        return {
          credential: { ...masked, secrets: { password: secret } },
          audit: { decision: "allow", purpose: input.purpose },
        };
      },
      async list() {
        return { connections: [] };
      },
      async listCredentials(input) {
        calls.push({ operation: "list", input });
        return {
          credentials: [{ ...masked, secrets: { password: secret } }],
        };
      },
      async registerCredential(input) {
        calls.push({ operation: "register", input });
        return {
          credential: { ...masked, secrets: { password: secret } },
          audit: { action: "register", credentialId },
        };
      },
      async requestApproval() {
        return {};
      },
      async resolveCredential(input) {
        calls.push({ operation: "resolve", input });
        return {
          credentials: [{ ...masked, secrets: { password: secret } }],
        };
      },
      async updateCredential(input) {
        calls.push({ operation: "update", input });
        return {
          credential: { ...masked, secrets: { password: secret } },
        };
      },
    });
    const client = new Client({ name: "credential-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const name of [
      "credentials_register",
      "credentials_list",
      "credentials_resolve",
      "credentials_get",
      "credentials_update",
      "credentials_delete",
    ]) {
      expect(names).toContain(name);
    }
    expect(client.getInstructions()).toContain(
      "call credentials_register in the same turn",
    );
    expect(client.getInstructions()).toContain(
      "call credentials_resolve with its exact purpose",
    );
    expect(client.getInstructions()).toContain(
      "call credentials_update in the same turn",
    );
    expect(client.getInstructions()).toContain("purpose model.api");
    expect(client.getInstructions()).toContain(
      "Never echo, summarize, log, write to Status or Persona",
    );
    expect(
      tools.tools.find((tool) => tool.name === "credentials_get"),
    ).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    });
    expect(
      tools.tools.find((tool) => tool.name === "credentials_delete"),
    ).toMatchObject({ annotations: { destructiveHint: true } });
    expect(
      (
        tools.tools.find((tool) => tool.name === "credentials_register")
          ?.inputSchema.properties?.kind as { enum?: string[] }
      ).enum,
    ).toEqual(expect.arrayContaining(["account", "card_key", "model"]));

    const registered = await client.callTool({
      name: "credentials_register",
      arguments: {
        kind: "ssh",
        label: "One Status production server",
        purposes: ["ssh.connect"],
        fields: { host: "124.220.104.225", username: "ubuntu" },
        secrets: { password: secret },
        tags: ["one-status", "production"],
        projectId: "one-status",
      },
    });
    expect(JSON.stringify(registered.structuredContent)).toContain("********");
    expect(JSON.stringify(registered.structuredContent)).not.toContain(secret);

    const listed = await client.callTool({
      name: "credentials_list",
      arguments: { kinds: ["ssh"], purposes: ["ssh.connect"] },
    });
    const resolved = await client.callTool({
      name: "credentials_resolve",
      arguments: {
        purpose: "ssh.connect",
        kinds: ["ssh"],
        tags: ["production"],
        projectId: "one-status",
      },
    });
    for (const response of [listed, resolved]) {
      expect(JSON.stringify(response.structuredContent)).toContain("********");
      expect(JSON.stringify(response.structuredContent)).not.toContain(secret);
    }

    const read = await client.callTool({
      name: "credentials_get",
      arguments: {
        credentialId,
        purpose: "ssh.connect",
        projectId: "one-status",
      },
    });
    expect(read.structuredContent).toMatchObject({
      credential: { secrets: { password: secret } },
      audit: { decision: "allow", purpose: "ssh.connect" },
    });

    const updated = await client.callTool({
      name: "credentials_update",
      arguments: {
        credentialId,
        fields: { host: "ssh.os.example" },
        secrets: { password: "rotated-private-value" },
      },
    });
    expect(JSON.stringify(updated.structuredContent)).toContain("********");
    expect(JSON.stringify(updated.structuredContent)).not.toContain(secret);
    await client.callTool({
      name: "credentials_delete",
      arguments: { credentialId },
    });

    expect(calls).toEqual([
      expect.objectContaining({ operation: "register" }),
      expect.objectContaining({ operation: "list" }),
      expect.objectContaining({ operation: "resolve" }),
      {
        operation: "get",
        input: { credentialId, projectId: "one-status", purpose: "ssh.connect" },
      },
      expect.objectContaining({ operation: "update" }),
      { operation: "delete", input: credentialId },
    ]);
    const registration = calls[0]?.input as Record<string, unknown>;
    expect(registration).not.toHaveProperty("agentId");
    expect(registration).not.toHaveProperty("source");

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
