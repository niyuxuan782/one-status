import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isCredentialPublicFieldName,
  ONE_STATUS_VERSION,
} from "@one-status/protocol";
import { z } from "zod";

export type RemoteMcpStatusReadRequest =
  | { view: "profile" }
  | { view: "context" }
  | {
      view: "memory";
      scope?: "user" | "project" | "session";
      projectId?: string;
      limit: number;
    };

export interface RemoteMcpStatusReader {
  read(request: RemoteMcpStatusReadRequest): Promise<Record<string, unknown>>;
}

export const remoteMcpScopes = {
  all: "status:read",
  context: "status:context:read",
  devices: "devices:read",
  memory: "status:memory:read",
  profile: "status:profile:read",
  toolsExecute: "tools:execute",
  toolsRead: "tools:read",
  vaultRead: "vault:read",
  vaultWrite: "vault:write",
} as const;

export const remoteMcpSupportedScopes = [
  remoteMcpScopes.all,
  remoteMcpScopes.profile,
  remoteMcpScopes.context,
  remoteMcpScopes.memory,
  remoteMcpScopes.devices,
  remoteMcpScopes.toolsRead,
  remoteMcpScopes.toolsExecute,
  remoteMcpScopes.vaultRead,
  remoteMcpScopes.vaultWrite,
] as const;

export const remoteMcpDefaultScopes = [
  remoteMcpScopes.profile,
  remoteMcpScopes.context,
  remoteMcpScopes.memory,
] as const;

const remoteMcpProjectScopePattern =
  /^project:([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/u;

export function isRemoteMcpGrantedScope(scope: string): boolean {
  return (
    remoteMcpSupportedScopes.includes(
      scope as (typeof remoteMcpSupportedScopes)[number],
    ) || remoteMcpProjectScopePattern.test(scope)
  );
}

export function effectiveRemoteMcpScopes(scopes: string[]): string[] {
  const effective = new Set<string>();
  for (const scope of scopes) {
    if (!isRemoteMcpGrantedScope(scope)) continue;
    if (scope === remoteMcpScopes.all) {
      effective.add(remoteMcpScopes.profile);
      effective.add(remoteMcpScopes.context);
      effective.add(remoteMcpScopes.memory);
      continue;
    }
    effective.add(scope);
  }
  return [...effective];
}

export function remoteMcpProjectIds(scopes: string[]): string[] {
  return [...new Set(scopes.flatMap((scope) => {
    const match = remoteMcpProjectScopePattern.exec(scope);
    return match?.[1] ? [match[1]] : [];
  }))].sort();
}

export interface RemoteMcpAgentSession {
  agentId: string;
  clientId: string;
  scopes: string[];
  subject: string;
}

export interface RemoteMcpGateway {
  credential(
    operation:
      | "credentials.create"
      | "credentials.delete"
      | "credentials.get"
      | "credentials.list"
      | "credentials.request_approval"
      | "credentials.resolve"
      | "credentials.update",
    input: Record<string, unknown>,
  ): Promise<unknown>;
  executeTool(input: {
    action: string;
    approvalId?: string;
    arguments: Record<string, unknown>;
    connectionId: string;
    deviceId?: string;
  }): Promise<unknown>;
  listDevices(): Promise<unknown>;
  listTools(input: { deviceId?: string }): Promise<unknown>;
  requestToolApproval(input: {
    action: string;
    arguments: Record<string, unknown>;
    connectionId: string;
    deviceId?: string;
  }): Promise<unknown>;
}

export function createRemoteMcpServer(
  vault: RemoteMcpStatusReader,
  session: RemoteMcpAgentSession,
  gateway?: RemoteMcpGateway,
  options: { publicStatusProjection?: boolean } = {},
): McpServer {
  const server = new McpServer(
    { name: "one-status-remote", version: ONE_STATUS_VERSION },
    {
      instructions: remoteMcpInstructions(session.scopes),
    },
  );

  if (hasRemoteScope(session.scopes, remoteMcpScopes.profile)) {
    server.registerTool(
      "status_get_profile",
      {
        title: "Get One Status profile",
        description:
          "Read the user's portable identity, durable preferences, and permitted Persona profile.",
        inputSchema: {},
        ...(options.publicStatusProjection
          ? { outputSchema: statusProfileOutputSchema }
          : {}),
        annotations: readOnlyAnnotations,
        ...oauthToolMetadata(remoteMcpScopes.profile),
      },
      async () =>
        toolResult(
          projectStatusResult(
            await vault.read({ view: "profile" }),
            "profile",
            options.publicStatusProjection,
          ),
        ),
    );
  }

  if (hasRemoteScope(session.scopes, remoteMcpScopes.context)) {
    server.registerTool(
      "status_get_context",
      {
        title: "Get current One Status context",
        description:
          "Read the active workspace, project, open tasks, and confirmed session memory needed to continue work.",
        inputSchema: {},
        ...(options.publicStatusProjection
          ? { outputSchema: statusContextOutputSchema }
          : {}),
        annotations: readOnlyAnnotations,
        ...oauthToolMetadata(remoteMcpScopes.context),
      },
      async () =>
        toolResult(
          projectStatusResult(
            await vault.read({ view: "context" }),
            "context",
            options.publicStatusProjection,
          ),
        ),
    );
  }

  if (hasRemoteScope(session.scopes, remoteMcpScopes.memory)) {
    server.registerTool(
      "status_get_memory",
      {
        title: "Get confirmed One Status memory",
        description:
          "Read confirmed user, project, or session memory. Candidate observations and raw conversations are excluded.",
        inputSchema: {
          scope: z.enum(["user", "project", "session"]).optional(),
          projectId: z.string().min(1).max(500).optional(),
          limit: z.number().int().min(1).max(200).default(100),
        },
        ...(options.publicStatusProjection
          ? { outputSchema: statusMemoryOutputSchema }
          : {}),
        annotations: readOnlyAnnotations,
        ...oauthToolMetadata(remoteMcpScopes.memory),
      },
      async ({ scope, projectId, limit }) =>
        toolResult(
          projectStatusResult(
            await vault.read({
              view: "memory",
              ...(scope ? { scope } : {}),
              ...(projectId ? { projectId } : {}),
              limit,
            }),
            "memory",
            options.publicStatusProjection,
          ),
        ),
    );
  }

  if (gateway && hasRemoteScope(session.scopes, remoteMcpScopes.devices)) {
    server.registerTool(
      "devices_list",
      {
        title: "List One Status devices",
        description:
          "List this account's devices, current Relay availability, and advertised remote capabilities.",
        inputSchema: {},
        annotations: readOnlyAnnotations,
      },
      async () => toolResult(await gateway.listDevices()),
    );
  }

  if (
    gateway &&
    (hasRemoteScope(session.scopes, remoteMcpScopes.toolsRead) ||
      hasRemoteScope(session.scopes, remoteMcpScopes.toolsExecute))
  ) {
    server.registerTool(
      "tools_list",
      {
        title: "List approved One Status tools",
        description:
          "List connected-service actions available to this Remote Agent on an online Desktop. Credentials are excluded.",
        inputSchema: { deviceId: z.string().uuid().optional() },
        annotations: readOnlyAnnotations,
      },
      async ({ deviceId }) => toolResult(await gateway.listTools({ deviceId })),
    );
  }

  if (gateway && hasRemoteScope(session.scopes, remoteMcpScopes.toolsExecute)) {
    server.registerTool(
      "tools_request_approval",
      {
        title: "Request approval for a One Status action",
        description:
          "Create a short-lived approval request for an action that tools_list marks as requiring confirmation.",
        inputSchema: {
          deviceId: z.string().uuid().optional(),
          connectionId: z.string().uuid(),
          action: z.string().min(1).max(160),
          arguments: z.record(z.string(), z.unknown()).default({}),
        },
        annotations: readOnlyAnnotations,
      },
      async ({ deviceId, connectionId, action, arguments: arguments_ }) =>
        toolResult(
          await gateway.requestToolApproval({
            deviceId,
            connectionId,
            action,
            arguments: arguments_,
          }),
        ),
    );

    server.registerTool(
      "tools_execute",
      {
        title: "Execute an approved One Status action",
        description:
          "Execute one action returned by tools_list through the selected or automatically routed online Desktop.",
        inputSchema: {
          deviceId: z.string().uuid().optional(),
          connectionId: z.string().uuid(),
          action: z.string().min(1).max(160),
          arguments: z.record(z.string(), z.unknown()).default({}),
          approvalId: z.string().uuid().optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({
        deviceId,
        connectionId,
        action,
        arguments: arguments_,
        approvalId,
      }) =>
        toolResult(
          await gateway.executeTool({
            deviceId,
            connectionId,
            action,
            arguments: arguments_,
            approvalId,
          }),
        ),
    );
  }

  if (
    gateway &&
    (hasRemoteScope(session.scopes, remoteMcpScopes.vaultRead) ||
      hasRemoteScope(session.scopes, remoteMcpScopes.vaultWrite))
  ) {
    server.registerTool(
      "credentials_request_approval",
      {
        title: "Request approval for a private credential action",
        description:
          "Create a ten-minute approval request bound to the exact credential operation and input. Ask the user to approve it in One Status, then retry the operation with the returned approvalToken.",
        inputSchema: {
          operation: z.enum([
            "credential.create",
            "credential.get",
            "credential.update",
            "credential.delete",
          ]),
          request: z.record(z.string(), z.unknown()),
        },
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        toolResult(
          await gateway.credential("credentials.request_approval", input),
        ),
    );
  }

  if (gateway && hasRemoteScope(session.scopes, remoteMcpScopes.vaultRead)) {
    server.registerTool(
      "credentials_list",
      {
        title: "List private credential metadata",
        description:
          "List permitted credential metadata and masked secret names. Secret values are excluded.",
        inputSchema: {
          kinds: z.array(remoteCredentialKindSchema).max(20).default([]),
          purposes: credentialStringListSchema.max(32).default([]),
          tags: credentialStringListSchema.max(50).default([]),
          limit: z.number().int().min(1).max(200).default(100),
        },
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        toolResult(await gateway.credential("credentials.list", input)),
    );

    server.registerTool(
      "credentials_resolve",
      {
        title: "Resolve a credential for a task",
        description:
          "Select permitted credential metadata for an exact task purpose. Secret values remain masked.",
        inputSchema: {
          purpose: credentialMetadataSchema,
          kinds: z.array(remoteCredentialKindSchema).max(20).default([]),
          tags: credentialStringListSchema.max(50).default([]),
          projectId: credentialMetadataSchema.optional(),
          limit: z.number().int().min(1).max(50).default(20),
        },
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        toolResult(await gateway.credential("credentials.resolve", input)),
    );

    server.registerTool(
      "credentials_get",
      {
        title: "Read a credential for immediate use",
        description:
          "Read one resolved credential for the stated immediate purpose. This action is audited; never echo or persist the returned secret.",
        inputSchema: {
          approvalToken: approvalTokenSchema.optional(),
          credentialId: z.string().uuid(),
          purpose: credentialMetadataSchema,
          projectId: credentialMetadataSchema.optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) =>
        toolResult(await gateway.credential("credentials.get", input)),
    );
  }

  if (gateway && hasRemoteScope(session.scopes, remoteMcpScopes.vaultWrite)) {
    server.registerTool(
      "credentials_register",
      {
        title: "Register a private credential",
        description:
          "Store a reusable credential in the One Status Vault when the user provides it. Put public matching data in fields and secret material only in secrets.",
        inputSchema: {
          approvalToken: approvalTokenSchema,
          ...remoteCredentialCreateShape,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) =>
        toolResult(await gateway.credential("credentials.create", input)),
    );

    server.registerTool(
      "credentials_update",
      {
        title: "Update a private credential",
        description:
          "Update a stored credential when its password, token, key, Endpoint, username, or metadata changes.",
        inputSchema: {
          credentialId: z.string().uuid(),
          approvalToken: approvalTokenSchema,
          ...remoteCredentialUpdateShape,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) =>
        toolResult(await gateway.credential("credentials.update", input)),
    );

    server.registerTool(
      "credentials_delete",
      {
        title: "Delete a private credential",
        description:
          "Delete one credential from the One Status Vault. Use only when the user explicitly requests deletion.",
        inputSchema: {
          approvalToken: approvalTokenSchema,
          credentialId: z.string().uuid(),
          projectId: credentialMetadataSchema.optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) =>
        toolResult(await gateway.credential("credentials.delete", input)),
    );
  }

  advertiseOpenAiToolSecuritySchemes(server);
  return server;
}

export function hasRemoteScope(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  return (
    scopes.includes(remoteMcpScopes.all) &&
    [
      remoteMcpScopes.profile,
      remoteMcpScopes.context,
      remoteMcpScopes.memory,
    ].includes(required as typeof remoteMcpScopes.profile)
  );
}

const remoteCredentialKinds = [
  "account",
  "ssh",
  "cloud_console",
  "github",
  "database",
  "api",
  "license",
  "card_key",
  "model",
  "oauth",
  "email",
  "vpn",
  "certificate",
  "signing",
  "container_registry",
  "package_registry",
  "domain",
  "remote_desktop",
  "webhook",
  "generic",
] as const;
const remoteCredentialKindSchema = z.enum(remoteCredentialKinds);
const credentialMetadataSchema = z.string().trim().min(1).max(500);
const approvalTokenSchema = z.string().regex(/^osvp1_[A-Za-z0-9_-]{43}$/u);
const credentialStringListSchema = z
  .array(credentialMetadataSchema)
  .max(64)
  .refine((values) => new Set(values).size === values.length, {
    message: "Credential metadata values must be unique.",
  });
const credentialMapKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u);
const credentialFieldsSchema = z
  .record(credentialMapKeySchema, z.string().min(1).max(8_000))
  .refine((value) => Object.keys(value).length <= 64, {
    message: "Credential fields cannot contain more than 64 entries.",
  })
  .refine((value) => Object.keys(value).every(isCredentialPublicFieldName), {
    message: "Sensitive values must be stored in secrets.",
  });
const credentialSecretsSchema = z
  .record(credentialMapKeySchema, z.string().min(1).max(128_000))
  .refine(
    (value) =>
      Object.keys(value).length >= 1 && Object.keys(value).length <= 64,
    { message: "Credential secrets must contain between 1 and 64 entries." },
  );
const credentialAccessPolicySchema = z
  .object({
    allowAgentRead: z.boolean().optional(),
    allowedAgentIds: credentialStringListSchema.optional(),
    allowedProjectIds: credentialStringListSchema.optional(),
    deniedAgentIds: credentialStringListSchema.optional(),
    deniedProjectIds: credentialStringListSchema.optional(),
    requireApproval: z.boolean().optional(),
  })
  .strict();
const remoteCredentialCreateShape = {
  accessPolicy: credentialAccessPolicySchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  fields: credentialFieldsSchema.default({}),
  kind: remoteCredentialKindSchema,
  label: credentialMetadataSchema,
  purposes: credentialStringListSchema.min(1).max(32),
  projectId: credentialMetadataSchema.optional(),
  secrets: credentialSecretsSchema,
  tags: credentialStringListSchema.max(50).default([]),
};
const remoteCredentialUpdateShape = {
  accessPolicy: credentialAccessPolicySchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  fields: credentialFieldsSchema.optional(),
  kind: remoteCredentialKindSchema.optional(),
  label: credentialMetadataSchema.optional(),
  purposes: credentialStringListSchema.min(1).max(32).optional(),
  projectId: credentialMetadataSchema.optional(),
  secrets: credentialSecretsSchema.optional(),
  tags: credentialStringListSchema.max(50).optional(),
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function remoteMcpInstructions(scopes: string[]): string {
  const parts = [
    "One Status provides the user's read-only portable profile, active project context, open tasks, and confirmed memory.",
    "Use status_get_context to continue current work, status_get_profile for durable preferences, and status_get_memory for confirmed user, project, or session memory.",
    "Candidate observations, raw conversations, credential-wallet data, and authentication secrets are excluded from Status tool results.",
  ];
  if (
    hasRemoteScope(scopes, remoteMcpScopes.toolsRead) ||
    hasRemoteScope(scopes, remoteMcpScopes.toolsExecute)
  ) {
    parts.push(
      "For connected services, inspect tools_list before requesting approval or calling tools_execute through an online One Status Desktop.",
    );
  }
  if (
    hasRemoteScope(scopes, remoteMcpScopes.vaultRead) ||
    hasRemoteScope(scopes, remoteMcpScopes.vaultWrite)
  ) {
    parts.push(
      "Credential access is purpose-bound and audited. Never echo, log, persist, or copy returned secrets into Status, Memory, Persona, unrelated tool arguments, or error text.",
    );
  }
  return parts.join(" ");
}

const statusIdentityOutputSchema = z
  .object({
    displayName: z.string().optional(),
    locale: z.string().optional(),
    timezone: z.string().optional(),
  })
  .strip();
const statusPreferenceValueOutputSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
const statusPersonaProfileEntryOutputSchema = z
  .object({
    content: z.string(),
    confidence: z.enum(["explicit", "observed", "inferred"]),
  })
  .strip();
const statusMemoryEntryOutputSchema = z
  .object({
    scope: z.enum(["user", "project", "session"]),
    content: z.string(),
    tags: z.array(z.string()),
  })
  .strip();
const statusProjectHandoffOutputSchema = z
  .object({
    provider: z.literal("github"),
    repositoryUrl: z.string(),
    branch: z.string(),
    commit: z.string(),
  })
  .strip();
const statusProjectOutputSchema = z
  .object({
    name: z.string(),
    summary: z.string(),
    techStack: z.array(z.string()),
    currentGoal: z.string(),
    decisions: z.array(z.string()),
    handoff: statusProjectHandoffOutputSchema.optional(),
  })
  .strip();
const statusTaskOutputSchema = z
  .object({
    title: z.string(),
    status: z.enum(["todo", "in_progress", "blocked", "done"]),
    completed: z.array(z.string()),
    next: z.array(z.string()),
  })
  .strip();
const statusWorkspaceOutputSchema = z
  .object({
    currentContext: z.string().optional(),
  })
  .strip();
const statusProfileOutputSchema = z
  .object({
    identity: statusIdentityOutputSchema,
    preferences: z.record(z.string(), statusPreferenceValueOutputSchema),
    personaProfile: z.record(
      z.string(),
      statusPersonaProfileEntryOutputSchema,
    ),
  })
  .strict();
const statusContextOutputSchema = z
  .object({
    workspace: statusWorkspaceOutputSchema,
    project: statusProjectOutputSchema.nullable(),
    openTasks: z.array(statusTaskOutputSchema),
    sessionMemory: z.array(statusMemoryEntryOutputSchema),
  })
  .strict();
const statusMemoryOutputSchema = z
  .object({
    memory: z.array(statusMemoryEntryOutputSchema),
  })
  .strict();

function projectStatusResult(
  value: Record<string, unknown>,
  view: "profile" | "context" | "memory",
  publicStatusProjection = false,
): Record<string, unknown> {
  if (!publicStatusProjection) return value;
  if (view === "profile") return reviewSafeStatusProfile(value);
  if (view === "context") return reviewSafeStatusContext(value);
  return reviewSafeStatusMemory(value);
}

function oauthToolMetadata(scope: string) {
  const securitySchemes = [{ type: "oauth2", scopes: [scope] }] as const;
  return {
    securitySchemes,
    _meta: { securitySchemes },
  };
}

function advertiseOpenAiToolSecuritySchemes(server: McpServer): void {
  type RequestHandler = (
    request: unknown,
    extra: unknown,
  ) => unknown | Promise<unknown>;
  const protocol = server.server as unknown as {
    _requestHandlers: Map<string, RequestHandler>;
  };
  const listTools = protocol._requestHandlers.get("tools/list");
  if (!listTools) return;
  // SDK 1.30 serializes extension auth metadata only through _meta. OpenAI's
  // descriptor contract also requires the same array at the tool's top level.
  protocol._requestHandlers.set("tools/list", async (request, extra) => {
    const result = recordValue(await listTools(request, extra));
    return {
      ...result,
      tools: arrayValue(result.tools).map((value) => {
        const tool = recordValue(value);
        const securitySchemes = recordValue(tool._meta).securitySchemes;
        return Array.isArray(securitySchemes)
          ? { ...tool, securitySchemes }
          : tool;
      }),
    };
  });
}

function reviewSafeStatusProfile(value: Record<string, unknown>) {
  const { status } = statusPayload(value);
  const identity = recordValue(status.identity);
  const preferences = recordValue(status.preferences);
  const persona = recordValue(status.persona);
  const directPersonaProfile = recordValue(status.personaProfile);
  const personaProfile =
    Object.keys(directPersonaProfile).length > 0
      ? directPersonaProfile
      : recordValue(persona.profile);
  const blockedCategories = new Set(
    stringArray(recordValue(persona.policy).blockedCategories),
  );
  const safeIdentity = statusIdentityOutputSchema.safeParse(identity);
  return {
    identity: safeIdentity.success ? safeIdentity.data : {},
    preferences: reviewSafePreferences(preferences),
    personaProfile: Object.fromEntries(
      Object.entries(personaProfile).flatMap(([key, entry]) => {
        if (blockedCategories.has(key)) return [];
        const profile = statusPersonaProfileEntryOutputSchema.safeParse(entry);
        return profile.success ? [[key, profile.data]] : [];
      }),
    ),
  };
}

function reviewSafeStatusContext(value: Record<string, unknown>) {
  const { status } = statusPayload(value);
  const workspace = recordValue(status.workspace);
  const activeProjectId = stringValue(workspace.activeProjectId);
  const projects = recordValue(status.projects);
  const tasks = Object.hasOwn(status, "openTasks")
    ? arrayValue(status.openTasks)
    : Object.values(recordValue(status.tasks)).filter(
        (task) => recordValue(task).status !== "done",
      );
  const memory = Object.hasOwn(status, "sessionMemory")
    ? arrayValue(status.sessionMemory)
    : arrayValue(status.memory).filter((entry) => {
        const candidate = recordValue(entry);
        return candidate.state === "confirmed" && candidate.scope === "session";
      });
  const project = Object.hasOwn(status, "project")
    ? status.project
    : activeProjectId
      ? projects[activeProjectId]
      : null;
  const safeWorkspace = statusWorkspaceOutputSchema.safeParse(workspace);
  return {
    workspace: safeWorkspace.success ? safeWorkspace.data : {},
    project: reviewSafeProject(project),
    openTasks: tasks.flatMap((task) => {
      const safeTask = reviewSafeTask(task);
      return safeTask ? [safeTask] : [];
    }),
    sessionMemory: memory.flatMap((entry) => {
      const safeMemory = reviewSafeMemoryEntry(entry);
      return safeMemory ? [safeMemory] : [];
    }),
  };
}

function reviewSafeStatusMemory(value: Record<string, unknown>) {
  const { status } = statusPayload(value);
  return {
    memory: arrayValue(status.memory).flatMap((entry) => {
      const safeEntry = reviewSafeMemoryEntry(entry);
      return safeEntry ? [safeEntry] : [];
    }),
  };
}

function reviewSafeProject(value: unknown) {
  if (value === null || value === undefined) return null;
  const project = statusProjectOutputSchema.safeParse(value);
  return project.success ? project.data : null;
}

function reviewSafeTask(value: unknown) {
  const task = statusTaskOutputSchema.safeParse(value);
  return task.success ? task.data : undefined;
}

function reviewSafeMemoryEntry(value: unknown) {
  const memory = recordValue(value);
  if (memory.state !== undefined && memory.state !== "confirmed") {
    return undefined;
  }
  const safeMemory = statusMemoryEntryOutputSchema.safeParse(value);
  return safeMemory.success ? safeMemory.data : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function statusPayload(value: Record<string, unknown>) {
  const root = recordValue(value);
  const snapshotStatus = recordValue(root.status);
  return {
    root,
    status: Object.keys(snapshotStatus).length > 0 ? snapshotStatus : root,
  };
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function reviewSafePreferences(value: Record<string, unknown>) {
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, preference] of Object.entries(value)) {
    if (!isReviewSafeStatusKey(key)) continue;
    if (
      typeof preference === "string" ||
      typeof preference === "boolean" ||
      (typeof preference === "number" && Number.isFinite(preference))
    ) {
      result[key] = preference;
      continue;
    }
    if (
      Array.isArray(preference) &&
      preference.every((item) => typeof item === "string")
    ) {
      result[key] = [...preference];
    }
  }
  return result;
}

function isReviewSafeStatusKey(key: string): boolean {
  if (key.startsWith("__one_status_internal:")) return false;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLocaleLowerCase();
  return !/(?:^|[._:-])(password|passphrase|secret|token|api_?key|private_?key|credential)(?:$|[._:-])/u.test(
    normalized,
  );
}

function toolResult(value: unknown) {
  const payload =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
