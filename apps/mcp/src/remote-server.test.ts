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
    };
    vault.status.memory = [
      memory("confirmed", "Confirmed memory"),
      memory("candidate", "Candidate memory"),
    ];
    vault.status.persona.policy.blockedCategories = ["personal_info"];
    vault.status.persona.profile = {
      language_style: personaProfile(
        "language_style",
        "Prefer concise Chinese answers",
      ),
      personal_info: personaProfile("personal_info", "Private profile detail"),
    };
    const client = await connect(vault, {
      agentId: "chatgpt",
      clientId: "chatgpt-client",
      scopes: [...remoteMcpDefaultScopes],
      subject: "user-1",
    });

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "status_get_profile",
        "status_get_context",
        "status_get_memory",
      ]);
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
        true,
      );
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
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "status_get_memory",
      ]);
    } finally {
      await client.close();
    }
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
