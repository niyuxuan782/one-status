import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  DecryptedStatusSnapshot,
  SyncedStatusVault,
} from "@one-status/client";
import {
  ONE_STATUS_VERSION,
  type StatusDocument,
} from "@one-status/protocol";
import { z } from "zod";
import {
  applyStatusMutation,
  digestStatusMutation,
  statusMutationSchema,
} from "./operations.js";
import type { RuntimeToolGateway } from "./tool-gateway.js";

type Vault = Pick<SyncedStatusVault, "read" | "mutate">;

export function createMcpServer(
  vault: Vault,
  agentId: string,
  toolGateway?: RuntimeToolGateway,
): McpServer {
  const server = new McpServer(
    {
      name: "one-status",
      version: ONE_STATUS_VERSION,
    },
    {
      instructions:
        "One Status is the authoritative live source for the user's portable state. " +
        "When the user asks to read, load, restore, continue, or show their One Status context, " +
        "call status_get_context before inspecting repository files or using shell commands. " +
        "Use the focused status tools for profile, memory, project, and context requests. " +
        "For every request involving Calendar, Slack, GitHub, or another connected service, call tools_list first and prefer the One Status Gateway over direct provider APIs, shell CLIs, or asking the user for a token. " +
        "Only call a connection and action returned by the latest tools_list result, and construct arguments from that action's inputSchema; then use tools_execute so provider credentials remain inside One Status. " +
        "Read-only actions may run immediately. Before an action marked requiresConfirmation, explain the concrete external change and obtain the user's explicit confirmation. " +
        "When no eligible action is returned, tell the user which service or action must be connected, granted, or reauthorized in One Status instead of requesting provider credentials.",
    },
  );

  server.registerTool(
    "read_status",
    {
      description: "Read the latest decrypted One Status state for this user.",
      inputSchema: {
        section: z
          .enum([
            "all",
            "identity",
            "preferences",
            "memory",
            "projects",
            "workspace",
            "permissions",
            "tools",
            "tasks",
          ])
          .default("all"),
        includeCandidates: z.boolean().default(false),
      },
    },
    async ({ section, includeCandidates }) => {
      const snapshot = await vault.read();
      const visibleMemory = includeCandidates
        ? snapshot.status.memory
        : snapshot.status.memory.filter((entry) => entry.state === "confirmed");
      const data = section === "all"
        ? { ...snapshot.status, memory: visibleMemory }
        : section === "memory"
          ? visibleMemory
          : snapshot.status[section];
      return toolResult({ version: snapshot.version, section, data });
    },
  );

  server.registerTool(
    "write_status",
    {
      description:
        "Apply one validated status mutation, preserving concurrent changes from other devices.",
      inputSchema: {
        mutationId: z
          .uuid()
          .describe("Stable UUID for retrying the same logical mutation."),
        mutation: statusMutationSchema,
      },
    },
    async ({ mutationId, mutation }) => {
      const snapshot = await vault.mutate(
        (status) => {
          applyStatusMutation(
            status,
            mutation,
            agentId,
            new Date().toISOString(),
            mutationId,
          );
        },
        { mutationId, mutationDigest: digestStatusMutation(mutation) },
      );
      return toolResult({
        version: snapshot.version,
        mutation: mutation.type,
        deduplicated: snapshot.deduplicated ?? false,
      });
    },
  );

  server.registerTool(
    "status_get_profile",
    {
      description: "Get the user's identity and durable preferences.",
      inputSchema: {},
    },
    async () => {
      const snapshot = await vault.read();
      return toolResult({
        version: snapshot.version,
        identity: snapshot.status.identity,
        preferences: snapshot.status.preferences,
      });
    },
  );

  server.registerTool(
    "status_get_memory",
    {
      description: "Get user, project, or session memory from the latest status.",
      inputSchema: {
        scope: z.enum(["user", "project", "session"]).optional(),
        projectId: z.string().min(1).optional(),
        includeCandidates: z.boolean().default(false),
      },
    },
    async ({ scope, projectId, includeCandidates }) => {
      const snapshot = await vault.read();
      const memory = snapshot.status.memory.filter(
        (entry) =>
          (includeCandidates || entry.state === "confirmed") &&
          (!scope || entry.scope === scope) &&
          (!projectId || entry.projectId === projectId),
      );
      return toolResult({ version: snapshot.version, memory });
    },
  );

  server.registerTool(
    "status_search_memory",
    {
      description: "Search decrypted memory locally by content or tag.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
        includeCandidates: z.boolean().default(false),
      },
    },
    async ({ query, limit, includeCandidates }) => {
      const snapshot = await vault.read();
      const normalizedQuery = query.toLocaleLowerCase();
      const memory = snapshot.status.memory
        .filter(
          (entry) =>
            (includeCandidates || entry.state === "confirmed") &&
            [entry.content, ...entry.tags].some((value) =>
              value.toLocaleLowerCase().includes(normalizedQuery),
            ),
        )
        .slice(0, limit);
      return toolResult({ version: snapshot.version, memory });
    },
  );

  server.registerTool(
    "status_get_project",
    {
      description: "Get a project and its active tasks and project memory.",
      inputSchema: {
        projectId: z.string().min(1).optional(),
      },
    },
    async ({ projectId }) => {
      const snapshot = await vault.read();
      const id = projectId ?? snapshot.status.workspace.activeProjectId;
      if (!id || !snapshot.status.projects[id]) {
        throw new Error("Project was not found and no active project is set.");
      }
      return toolResult(projectView(snapshot, id));
    },
  );

  server.registerTool(
    "status_get_context",
    {
      title: "Get current One Status context",
      description:
        "Call this when the user asks for their One Status context, wants to continue a project, " +
        "or needs state restored in a new session. Returns the live handoff context, active project, " +
        "open tasks, and session memory; repository files and chat history are not substitutes.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const snapshot = await vault.read();
      const projectId = snapshot.status.workspace.activeProjectId;
      return toolResult({
        version: snapshot.version,
        workspace: snapshot.status.workspace,
        project: projectId ? snapshot.status.projects[projectId] ?? null : null,
        openTasks: Object.values(snapshot.status.tasks).filter(
          (task) => task.status !== "done",
        ),
        sessionMemory: snapshot.status.memory.filter(
          (entry) => entry.state === "confirmed" && entry.scope === "session",
        ),
      });
    },
  );

  server.registerTool(
    "status_update_context",
    {
      description: "Update the handoff context after meaningful task progress.",
      inputSchema: {
        currentContext: z.string().min(1),
        projectId: z.string().min(1).optional(),
      },
    },
    async ({ currentContext, projectId }) => {
      const snapshot = await vault.mutate((status) => {
        applyStatusMutation(
          status,
          { type: "update_context", currentContext, projectId },
          agentId,
        );
      });
      return toolResult({
        version: snapshot.version,
        workspace: snapshot.status.workspace,
      });
    },
  );

  if (toolGateway) {
    server.registerTool(
      "tools_list",
      {
        title: "List approved One Status tools",
        description:
          "Call this first for Calendar, Slack, GitHub, and other third-party requests. " +
          "Returns only connections and actions approved for this Agent, including inputSchema, read-only, and confirmation metadata; it never returns provider credentials.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => toolResult(await toolGateway.list()),
    );

    server.registerTool(
      "tools_execute",
      {
        title: "Execute an approved One Status action",
        description:
          "Execute one connection/action pair from the latest tools_list result through the One Status Gateway. " +
          "OAuth credentials remain inside One Status. Obtain explicit user confirmation before actions marked requiresConfirmation.",
        inputSchema: {
          connectionId: z.uuid(),
          action: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
          confirmed: z
            .boolean()
            .default(false)
            .describe(
              "Set true only after the user explicitly confirms an action marked requiresConfirmation.",
            ),
        },
      },
      async ({ connectionId, action, arguments: arguments_, confirmed }) =>
        toolResult({
          result: await toolGateway.execute({
            connectionId,
            action,
            arguments: arguments_,
            confirmed,
          }),
        }),
    );
  }

  return server;
}

function projectView(snapshot: DecryptedStatusSnapshot, projectId: string) {
  return {
    version: snapshot.version,
    project: snapshot.status.projects[projectId],
    tasks: Object.values(snapshot.status.tasks).filter(
      (task) => task.projectId === projectId,
    ),
    memory: snapshot.status.memory.filter(
      (entry) =>
        entry.state === "confirmed" &&
        entry.scope === "project" &&
        entry.projectId === projectId,
    ),
  };
}

function toolResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export type { Vault, StatusDocument };
