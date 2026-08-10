import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  DecryptedStatusSnapshot,
  SyncedStatusVault,
} from "@one-status/client";
import { listBuiltInCapabilityPacks } from "@one-status/capability-pack";
import {
  ONE_STATUS_VERSION,
  personaCategorySchema,
  personaConfidenceSchema,
  type StatusDocument,
} from "@one-status/protocol";
import { z } from "zod";
import {
  applyStatusMutation,
  digestStatusMutation,
  statusMutationSchema,
} from "./operations.js";
import {
  deletePersonaEvent,
  personaPolicyInputSchema,
  personaRecordInputSchema,
  personaUpdateInputSchema,
  recordPersonaEvent,
  setPersonaPolicy,
  updatePersonaEvent,
} from "./persona.js";
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
        "For every request involving email, calendar, files, collaboration, project management, design, or another connected service, call tools_list first and prefer the One Status Gateway over direct provider APIs, shell CLIs, or asking the user for a token. " +
        "Use capabilities_get to discover installed Capability Packs and the built-in cross-Agent capability catalog. " +
        "When the user states a durable personal preference, behavior, work habit, technical habit, long-term goal, future plan, or explicitly asks you to remember personal information, call persona.record with a concise structured observation. " +
        "Use persona.profile to load the current effective Persona. Respect persona.get_policy, never record blocked categories or secrets, and never send raw messages, transcripts, credentials, or unrelated conversation text to Persona tools. " +
        "Only call a connection and action returned by the latest tools_list result, and construct arguments from that action's inputSchema; then use tools_execute so provider credentials remain inside One Status. " +
        "Read-only actions may run immediately. For an action marked requiresConfirmation, call tools_request_approval and ask the user to approve the exact request in the One Status Dashboard before calling tools_execute with the returned approvalId. " +
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
            "capabilities",
            "persona",
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
      const visiblePersona = filterPersonaForAgent(snapshot.status.persona);
      const visiblePreferences = filterInternalPreferences(
        snapshot.status.preferences,
      );
      const data = section === "all"
        ? {
            ...snapshot.status,
            memory: visibleMemory,
            persona: visiblePersona,
            preferences: visiblePreferences,
          }
        : section === "memory"
          ? visibleMemory
          : section === "persona"
            ? visiblePersona
            : section === "preferences"
              ? visiblePreferences
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
        preferences: filterInternalPreferences(snapshot.status.preferences),
        personaProfile: filterPersonaProfileForAgent(snapshot.status.persona),
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
        capabilityInstallations: Object.values(
          snapshot.status.capabilities.installations,
        ).filter((installation) => installation.enabled),
        sessionMemory: snapshot.status.memory.filter(
          (entry) => entry.state === "confirmed" && entry.scope === "session",
        ),
      });
    },
  );

  server.registerTool(
    "capabilities_get",
    {
      title: "Get installed One Status Capability Packs",
      description:
        "Read synchronized Capability Pack installation intent and a compact built-in catalog. Set includeTools only when exact pack action IDs are needed; use tools_list for actions currently available to this Agent. This does not expose OAuth credentials or modify local Agent files.",
      inputSchema: {
        target: z
          .enum([
            "chatgpt",
            "codex",
            "claude-code",
            "cursor",
            "ide",
            "markdown",
            "sdk",
          ])
          .optional(),
        includeDisabled: z.boolean().default(false),
        includeCatalog: z.boolean().default(true),
        includeTools: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target, includeDisabled, includeCatalog, includeTools }) => {
      const snapshot = await vault.read();
      const installations = Object.values(
        snapshot.status.capabilities.installations,
      ).filter(
        (installation) =>
          (includeDisabled || installation.enabled) &&
          (!target || installation.targets.includes(target)),
      );
      const catalog = includeCatalog
        ? listBuiltInCapabilityPacks().map(({ manifest, digest }) => ({
            name: manifest.name,
            version: manifest.version,
            displayName: manifest.displayName,
            actionCount: manifest.tools.length,
            writeActionCount: manifest.tools.filter(
              (tool) => tool.readOnly === false,
            ).length,
            ...(includeTools
              ? {
                  tools: manifest.tools.map((tool) => ({
                    id: tool.id,
                    readOnly: tool.readOnly ?? null,
                    requiresConfirmation: tool.requiresConfirmation ?? null,
                  })),
                }
              : {}),
            authorizationProvider: manifest.authorization?.provider ?? null,
            digest,
          }))
        : undefined;
      return toolResult({
        version: snapshot.version,
        installations,
        ...(catalog ? { catalog } : {}),
      });
    },
  );

  server.registerTool(
    "persona.record",
    {
      title: "Record a structured Persona observation",
      description:
        "Record one concise, durable observation about the user's personality, behavior, language or output style, work or technical habits, long-term goals, future plans, or explicitly requested personal memory. Duplicate category/content observations update timestamps, sources, and counts. Send only the structured observation; never send raw chat messages, transcripts, secrets, credentials, or unrelated conversation text.",
      inputSchema: personaRecordInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const now = new Date().toISOString();
      let result: ReturnType<typeof recordPersonaEvent> | undefined;
      const snapshot = await vault.mutate((status) => {
        result = recordPersonaEvent(status, input, agentId, now);
      });
      if (!result) throw new Error("Persona observation was not recorded.");
      const event = snapshot.status.persona.events.find(
        (candidate) => candidate.id === result?.event.id,
      );
      return toolResult({
        version: snapshot.version,
        created: result.created,
        observationAdded: result.observationAdded,
        event: event ?? result.event,
        profile: snapshot.status.persona.profile[input.category],
      });
    },
  );

  server.registerTool(
    "persona.list",
    {
      title: "List Persona events",
      description:
        "List encrypted Persona observations with their source Agent, source project, confidence, observation timestamps, and duplicate count. Raw conversations are not stored here.",
      inputSchema: {
        category: personaCategorySchema.optional(),
        sourceAgent: z.string().min(1).max(120).optional(),
        sourceProject: z.string().min(1).max(200).optional(),
        confidence: personaConfidenceSchema.optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category, sourceAgent, sourceProject, confidence, limit }) => {
      const snapshot = await vault.read();
      const blockedCategories = new Set(
        snapshot.status.persona.policy.blockedCategories,
      );
      const events = snapshot.status.persona.events
        .filter(
          (event) =>
            !blockedCategories.has(event.category) &&
            (!category || event.category === category) &&
            (!sourceAgent ||
              event.observations.some(
                (observation) => observation.sourceAgent === sourceAgent,
              )) &&
            (!sourceProject ||
              event.observations.some(
                (observation) => observation.sourceProject === sourceProject,
              )) &&
            (!confidence ||
              event.observations.some(
                (observation) => observation.confidence === confidence,
              )),
        )
        .sort(
          (left, right) =>
            right.lastObservedAt.localeCompare(left.lastObservedAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, limit);
      return toolResult({ version: snapshot.version, events });
    },
  );

  server.registerTool(
    "persona.profile",
    {
      title: "Get the current Persona profile",
      description:
        "Read the current effective Persona profile derived from timestamped Persona events. Optionally select one category.",
      inputSchema: {
        category: personaCategorySchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category }) => {
      const snapshot = await vault.read();
      const profile = filterPersonaProfileForAgent(snapshot.status.persona);
      return toolResult({
        version: snapshot.version,
        profile: category
          ? profile[category] ?? null
          : profile,
      });
    },
  );

  server.registerTool(
    "persona.update",
    {
      title: "Update a Persona event",
      description:
        "Edit the category, concise content, or confidence of one Persona event. Provenance and observation timestamps remain attached; matching events are merged.",
      inputSchema: personaUpdateInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      let eventId = input.id;
      const snapshot = await vault.mutate((status) => {
        eventId = updatePersonaEvent(status, input).id;
      });
      return toolResult({
        version: snapshot.version,
        event: snapshot.status.persona.events.find(
          (event) => event.id === eventId,
        ),
        profile: snapshot.status.persona.profile,
      });
    },
  );

  server.registerTool(
    "persona.delete",
    {
      title: "Delete a Persona event",
      description:
        "Delete one Persona event and rebuild the affected current profile. This does not touch local raw conversation history.",
      inputSchema: {
        id: z.string().min(1).max(200),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      let deletedCategory: string | undefined;
      const snapshot = await vault.mutate((status) => {
        deletedCategory = deletePersonaEvent(status, id).category;
      });
      return toolResult({
        version: snapshot.version,
        deleted: true,
        id,
        profile: deletedCategory
          ? snapshot.status.persona.profile[deletedCategory] ?? null
          : null,
      });
    },
  );

  server.registerTool(
    "persona.get_policy",
    {
      title: "Get Persona recording policy",
      description:
        "Read whether Persona recording is enabled and which categories or confidence levels the user permits.",
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
      return toolResult({
        version: snapshot.version,
        policy: snapshot.status.persona.policy,
      });
    },
  );

  server.registerTool(
    "persona.set_policy",
    {
      title: "Set Persona recording policy",
      description:
        "Update the user's Persona recording switch, blocked categories, or allowed confidence levels. Existing events remain available until deleted explicitly.",
      inputSchema: personaPolicyInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const snapshot = await vault.mutate((status) => {
        setPersonaPolicy(status, input);
      });
      return toolResult({
        version: snapshot.version,
        policy: snapshot.status.persona.policy,
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
          "Call this first for email, calendar, files, collaboration, project management, design, and other third-party requests. " +
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
      "tools_request_approval",
      {
        title: "Request approval for a One Status write action",
        description:
          "Create a short-lived Dashboard approval request bound to this Agent, connection, action, and exact arguments. Use only for actions marked requiresConfirmation by tools_list. This tool cannot approve its own request.",
        inputSchema: {
          connectionId: z.uuid(),
          action: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ connectionId, action, arguments: arguments_ }) =>
        toolResult({
          approval: await toolGateway.requestApproval({
            connectionId,
            action,
            arguments: arguments_,
          }),
        }),
    );

    server.registerTool(
      "tools_execute",
      {
        title: "Execute an approved One Status action",
        description:
          "Execute one connection/action pair from the latest tools_list result through the One Status Gateway. " +
          "OAuth credentials remain inside One Status. Actions marked requiresConfirmation require a current approvalId returned by tools_request_approval after Dashboard approval.",
        inputSchema: {
          connectionId: z.uuid(),
          action: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
          approvalId: z.uuid().optional(),
        },
      },
      async ({ connectionId, action, arguments: arguments_, approvalId }) =>
        toolResult({
          result: await toolGateway.execute({
            connectionId,
            action,
            arguments: arguments_,
            approvalId,
          }),
        }),
    );
  }

  return server;
}

function filterPersonaForAgent(
  persona: StatusDocument["persona"],
): StatusDocument["persona"] {
  const blockedCategories = new Set(persona.policy.blockedCategories);
  return {
    ...persona,
    events: persona.events.filter(
      (event) => !blockedCategories.has(event.category),
    ),
    profile: filterPersonaProfileForAgent(persona),
  };
}

function filterPersonaProfileForAgent(
  persona: StatusDocument["persona"],
): StatusDocument["persona"]["profile"] {
  const blockedCategories = new Set(persona.policy.blockedCategories);
  return Object.fromEntries(
    Object.entries(persona.profile).filter(
      ([category]) => !blockedCategories.has(category),
    ),
  );
}

function filterInternalPreferences(
  preferences: StatusDocument["preferences"],
): StatusDocument["preferences"] {
  return Object.fromEntries(
    Object.entries(preferences).filter(
      ([key]) => !key.startsWith("__one_status_internal:"),
    ),
  );
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
