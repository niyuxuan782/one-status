import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { describe, expect, it } from "vitest";
import {
  createRemoteMcpServer,
  effectiveRemoteMcpScopes,
  remoteMcpDefaultScopes,
  remoteMcpScopes,
  type RemoteMcpAgentSession,
  type RemoteMcpGateway,
} from "./remote-server.js";
import type { Vault } from "./server.js";

describe("One Status Remote MCP tools", () => {
  it("defaults to the complete read-only Status surface", () => {
    expect(remoteMcpDefaultScopes).toEqual([
      remoteMcpScopes.profile,
      remoteMcpScopes.context,
      remoteMcpScopes.memory,
    ]);
    expect(
      effectiveRemoteMcpScopes([
        remoteMcpScopes.all,
        remoteMcpScopes.devices,
        "unknown:scope",
      ]),
    ).toEqual([
      remoteMcpScopes.profile,
      remoteMcpScopes.context,
      remoteMcpScopes.memory,
      remoteMcpScopes.devices,
    ]);
    expect(remoteMcpDefaultScopes).not.toContain(remoteMcpScopes.devices);
    expect(remoteMcpDefaultScopes).not.toContain(remoteMcpScopes.toolsRead);
    expect(remoteMcpDefaultScopes).not.toContain(remoteMcpScopes.toolsExecute);
    expect(remoteMcpDefaultScopes).not.toContain(remoteMcpScopes.vaultRead);
    expect(remoteMcpDefaultScopes).not.toContain(remoteMcpScopes.vaultWrite);
  });

  it("exposes only scoped read tools and filters private state", async () => {
    const vault = new MemoryVault();
    vault.status.preferences = {
      language: "zh-CN",
      "__one_status_internal:local": "hidden",
      apiToken: "must-not-leak",
    };
    vault.status.memory = [
      memory("confirmed", "Confirmed memory"),
      memory("candidate", "Candidate memory"),
      {
        ...memory("confirmed", "Session handoff memory"),
        id: "session-memory",
        scope: "session",
      },
    ];
    vault.status.workspace = {
      activeProjectId: "one-status",
      currentContext: "Prepare the public plugin",
      lastAgentId: "codex",
    };
    vault.status.projects["one-status"] = {
      id: "one-status",
      name: "One Status",
      summary: "Portable Agent state",
      techStack: ["TypeScript"],
      currentGoal: "Publish the plugin",
      decisions: ["Expose a narrow read-only surface"],
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    vault.status.tasks["review"] = {
      id: "review",
      projectId: "one-status",
      title: "Prepare app review",
      status: "in_progress",
      completed: [],
      next: ["Scan tools"],
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    vault.status.persona.policy.blockedCategories = ["personal_info"];
    vault.status.persona.profile = {
      language_style: personaProfile(
        "language_style",
        "Prefer concise Chinese answers",
      ),
      personal_info: personaProfile("personal_info", "Private profile detail"),
    };
    const client = await connect(
      vault,
      {
        agentId: "chatgpt",
        clientId: "chatgpt-client",
        scopes: [...remoteMcpDefaultScopes],
        subject: "user-1",
      },
      undefined,
      { publicStatusProjection: true },
    );

    try {
      expect(client.getInstructions()).toContain("read-only portable profile");
      expect(client.getInstructions()).not.toContain("tools_list");
      expect(client.getInstructions()).not.toContain("Credential access");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "status_get_profile",
        "status_get_context",
        "status_get_memory",
      ]);
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
        true,
      );
      expect(
        tools.tools.every(
          (tool) =>
            tool.annotations?.destructiveHint === false &&
            tool.annotations?.openWorldHint === false &&
            tool.outputSchema?.type === "object",
        ),
      ).toBe(true);
      expect(
        Object.fromEntries(
          tools.tools.map((tool) => [
            tool.name,
            tool._meta?.securitySchemes,
          ]),
        ),
      ).toEqual({
        status_get_profile: [
          { type: "oauth2", scopes: [remoteMcpScopes.profile] },
        ],
        status_get_context: [
          { type: "oauth2", scopes: [remoteMcpScopes.context] },
        ],
        status_get_memory: [
          { type: "oauth2", scopes: [remoteMcpScopes.memory] },
        ],
      });
      expect(tools.tools.map((tool) => tool.name)).not.toContain("write_status");
      expect(tools.tools.map((tool) => tool.name)).not.toContain(
        "credentials_get",
      );

      const profile = await client.callTool({
        name: "status_get_profile",
        arguments: {},
      });
      expect(JSON.stringify(profile.structuredContent)).toContain("zh-CN");
      expect(JSON.stringify(profile.structuredContent)).toContain(
        "Prefer concise Chinese answers",
      );
      expect(JSON.stringify(profile.structuredContent)).not.toContain("hidden");
      expect(JSON.stringify(profile.structuredContent)).not.toContain(
        "Private profile detail",
      );
      expect(JSON.stringify(profile.structuredContent)).not.toContain(
        "must-not-leak",
      );
      expect(JSON.stringify(profile.structuredContent)).not.toContain(
        "sourceEventIds",
      );
      expect(JSON.stringify(profile.structuredContent)).not.toContain(
        "lastObservedAt",
      );

      const context = await client.callTool({
        name: "status_get_context",
        arguments: {},
      });
      expect(context.structuredContent).toEqual({
        workspace: {
          currentContext: "Prepare the public plugin",
        },
        project: {
          name: "One Status",
          summary: "Portable Agent state",
          techStack: ["TypeScript"],
          currentGoal: "Publish the plugin",
          decisions: ["Expose a narrow read-only surface"],
        },
        openTasks: [
          {
            title: "Prepare app review",
            status: "in_progress",
            completed: [],
            next: ["Scan tools"],
          },
        ],
        sessionMemory: [
          {
            scope: "session",
            content: "Session handoff memory",
            tags: [],
          },
        ],
      });

      const memories = await client.callTool({
        name: "status_get_memory",
        arguments: {},
      });
      expect(JSON.stringify(memories.structuredContent)).toContain(
        "Confirmed memory",
      );
      expect(JSON.stringify(memories.structuredContent)).not.toContain(
        "Candidate memory",
      );
      expect(memories.structuredContent).toEqual({
        memory: [
          { scope: "user", content: "Confirmed memory", tags: [] },
          {
            scope: "session",
            content: "Session handoff memory",
            tags: [],
          },
        ],
      });
      expect(JSON.stringify(memories.structuredContent)).not.toContain(
        "confirmed-memory",
      );
      expect(JSON.stringify(memories.structuredContent)).not.toContain(
        "createdAt",
      );
    } finally {
      await client.close();
    }
  });

  it("registers only the tools granted to the Agent session", async () => {
    const client = await connect(new MemoryVault(), {
      agentId: "research-agent",
      clientId: "research-client",
      scopes: [remoteMcpScopes.memory],
      subject: "user-1",
    });

    try {
      expect(client.getInstructions()).not.toContain("tools_list");
      expect(client.getInstructions()).not.toContain("Credential access");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "status_get_memory",
      ]);
    } finally {
      await client.close();
    }
  });

  it("advertises top-level and compatibility OAuth security schemes", async () => {
    const server = createRemoteMcpServer(
      new MemoryVault(),
      {
        agentId: "chatgpt",
        clientId: "chatgpt-client",
        scopes: [...remoteMcpDefaultScopes],
        subject: "user-1",
      },
      undefined,
      { publicStatusProjection: true },
    );
    const handlers = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (request: unknown, extra: unknown) => Promise<unknown>
        >;
      }
    )._requestHandlers;
    const listTools = handlers.get("tools/list");
    expect(listTools).toBeDefined();
    const result = (await listTools?.(
      { method: "tools/list", params: {} },
      {},
    )) as {
      tools: Array<{
        name: string;
        securitySchemes?: unknown;
        _meta?: Record<string, unknown>;
      }>;
    };

    expect(
      Object.fromEntries(
        result.tools.map((tool) => [tool.name, tool.securitySchemes]),
      ),
    ).toEqual({
      status_get_profile: [
        { type: "oauth2", scopes: [remoteMcpScopes.profile] },
      ],
      status_get_context: [
        { type: "oauth2", scopes: [remoteMcpScopes.context] },
      ],
      status_get_memory: [
        { type: "oauth2", scopes: [remoteMcpScopes.memory] },
      ],
    });
    expect(
      result.tools.every(
        (tool) =>
          JSON.stringify(tool.securitySchemes) ===
          JSON.stringify(tool._meta?.securitySchemes),
      ),
    ).toBe(true);
  });

  it("routes scoped device and connected-service tools through the bound Gateway", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gateway: RemoteMcpGateway = {
      async credential(operation, input) {
        calls.push({ operation, ...input });
        return { credential: { id: input.credentialId ?? "credential-1" } };
      },
      async listDevices() {
        return { devices: [{ id: "device-a", online: true }] };
      },
      async listTools(input) {
        calls.push({ operation: "list", ...input });
        return { deviceId: input.deviceId, actions: ["calendar.list_events"] };
      },
      async requestToolApproval(input) {
        calls.push({ operation: "approval", ...input });
        return { approval: { id: "approval-1", state: "pending" } };
      },
      async executeTool(input) {
        calls.push({ operation: "execute", ...input });
        return { result: { events: [] } };
      },
    };
    const client = await connect(
      new MemoryVault(),
      {
        agentId: "claude-web",
        clientId: "claude-client",
        scopes: [
          remoteMcpScopes.all,
          remoteMcpScopes.devices,
          remoteMcpScopes.toolsRead,
          remoteMcpScopes.toolsExecute,
          remoteMcpScopes.vaultRead,
          remoteMcpScopes.vaultWrite,
        ],
        subject: "user-1",
      },
      gateway,
    );
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const connectionId = "22222222-2222-4222-8222-222222222222";

    try {
      expect(client.getInstructions()).toContain("tools_list");
      expect(client.getInstructions()).toContain("Credential access");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "status_get_profile",
        "status_get_context",
        "status_get_memory",
        "devices_list",
        "tools_list",
        "tools_request_approval",
        "tools_execute",
        "credentials_request_approval",
        "credentials_list",
        "credentials_resolve",
        "credentials_get",
        "credentials_register",
        "credentials_update",
        "credentials_delete",
      ]);
      await client.callTool({ name: "devices_list", arguments: {} });
      await client.callTool({ name: "tools_list", arguments: { deviceId } });
      await client.callTool({
        name: "tools_execute",
        arguments: {
          deviceId,
          connectionId,
          action: "calendar.list_events",
          arguments: { date: "2026-08-12" },
        },
      });
      await client.callTool({
        name: "credentials_request_approval",
        arguments: {
          operation: "credential.get",
          request: {
            credentialId: "33333333-3333-4333-8333-333333333333",
            purpose: "dns.manage",
          },
        },
      });
      await client.callTool({
        name: "credentials_resolve",
        arguments: { purpose: "dns.manage", kinds: ["cloud_console"] },
      });
      await client.callTool({
        name: "credentials_get",
        arguments: {
          credentialId: "33333333-3333-4333-8333-333333333333",
          purpose: "dns.manage",
        },
      });
      expect(calls).toEqual([
        { operation: "list", deviceId },
        {
          operation: "execute",
          deviceId,
          connectionId,
          action: "calendar.list_events",
          arguments: { date: "2026-08-12" },
          approvalId: undefined,
        },
        {
          operation: "credential.get",
          request: {
            credentialId: "33333333-3333-4333-8333-333333333333",
            purpose: "dns.manage",
          },
        },
        {
          operation: "credentials.resolve",
          purpose: "dns.manage",
          kinds: ["cloud_console"],
          tags: [],
          limit: 20,
        },
        {
          operation: "credentials.get",
          credentialId: "33333333-3333-4333-8333-333333333333",
          purpose: "dns.manage",
        },
      ]);
    } finally {
      await client.close();
    }
  });
});

class MemoryVault implements Vault {
  status: StatusDocument = createEmptyStatus();

  async read() {
    return { version: 1, status: structuredClone(this.status), updatedAt: null };
  }

  async mutate(mutation: (draft: StatusDocument) => void) {
    mutation(this.status);
    return this.read();
  }
}

async function connect(
  vault: Vault,
  session: RemoteMcpAgentSession,
  gateway?: RemoteMcpGateway,
  options: { publicStatusProjection?: boolean } = {},
) {
  const server = createRemoteMcpServer(
    {
      async read(request) {
        const snapshot = await vault.read();
        if (request.view === "profile") {
          const blocked = new Set(
            snapshot.status.persona.policy.blockedCategories,
          );
          return {
            version: snapshot.version,
            identity: snapshot.status.identity,
            preferences: Object.fromEntries(
              Object.entries(snapshot.status.preferences).filter(
                ([key]) => !key.startsWith("__one_status_internal:"),
              ),
            ),
            personaProfile: Object.fromEntries(
              Object.entries(snapshot.status.persona.profile).filter(
                ([category]) => !blocked.has(category),
              ),
            ),
          };
        }
        if (request.view === "context") {
          const projectId = snapshot.status.workspace.activeProjectId;
          return {
            version: snapshot.version,
            workspace: snapshot.status.workspace,
            project: projectId
              ? snapshot.status.projects[projectId] ?? null
              : null,
            openTasks: Object.values(snapshot.status.tasks).filter(
              (task) => task.status !== "done",
            ),
            sessionMemory: snapshot.status.memory.filter(
              (entry) =>
                entry.state === "confirmed" && entry.scope === "session",
            ),
          };
        }
        return {
          version: snapshot.version,
          memory: snapshot.status.memory
            .filter(
              (entry) =>
                entry.state === "confirmed" &&
                (!request.scope || entry.scope === request.scope) &&
                (!request.projectId || entry.projectId === request.projectId),
            )
            .slice(0, request.limit),
        };
      },
    },
    session,
    gateway,
    options,
  );
  const client = new Client({ name: session.agentId, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function memory(
  state: "candidate" | "confirmed",
  content: string,
): StatusDocument["memory"][number] {
  return {
    id: `${state}-memory`,
    scope: "user",
    content,
    tags: [],
    state,
    origin: { type: "manual", label: "test" },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function personaProfile(
  category: "language_style" | "personal_info",
  content: string,
): StatusDocument["persona"]["profile"][string] {
  return {
    category,
    confidence: "explicit",
    content,
    firstObservedAt: "2026-08-11T00:00:00.000Z",
    lastObservedAt: "2026-08-11T00:00:00.000Z",
    observationCount: 1,
    sourceEventIds: [`${category}-event`],
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}
