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
): McpServer {
  const server = new McpServer(
    { name: "one-status-remote", version: ONE_STATUS_VERSION },
    {
      instructions:
        "One Status Remote MCP provides the current user's read-only portable profile, context, and confirmed memory. " +
        "Use status_get_context when the user asks to continue work, status_get_profile for durable identity and preferences, and status_get_memory for confirmed user, project, or session memory. " +
        "For calendar, email, files, collaboration, and other connected services, call tools_list and use tools_execute through an online One Status Desktop. " +
        "When a task needs a stored credential, call credentials_resolve and then credentials_get for immediate use. If a credential requires approval, or before every credential register, update, or delete, call credentials_request_approval with the exact planned input; wait for the user to approve it in One Status, then retry with the returned approvalToken. Register or update reusable credentials when the user provides or rotates them. " +
        "Never echo, log, persist, or copy a returned secret into Status, Memory, Persona, tool arguments unrelated to its purpose, or error text. Connected-service provider credentials remain in the One Status Vault. Write actions can require approval in the Desktop App. Remote MCP cannot change local Agent configuration.",
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
        annotations: readOnlyAnnotations,
      },
      async () => toolResult(await vault.read({ view: "profile" })),
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
        annotations: readOnlyAnnotations,
      },
      async () => toolResult(await vault.read({ view: "context" })),
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
        annotations: readOnlyAnnotations,
      },
      async ({ scope, projectId, limit }) =>
        toolResult(
          await vault.read({
            view: "memory",
            ...(scope ? { scope } : {}),
            ...(projectId ? { projectId } : {}),
            limit,
          }),
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
