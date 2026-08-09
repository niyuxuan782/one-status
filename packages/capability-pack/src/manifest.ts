import { z } from "zod";

export const CAPABILITY_PACK_FORMAT = "one-status.capability-pack" as const;
export const CAPABILITY_PACK_SCHEMA_VERSION = 1 as const;

const SEMANTIC_VERSION_SOURCE =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)" +
  "(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?" +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMANTIC_VERSION_PATTERN = new RegExp(`^${SEMANTIC_VERSION_SOURCE}$`);
const VERSION_RANGE_PATTERN = new RegExp(
  `^(?:\\*|(?:\\^|~|>=|<=|>|<|=)?${SEMANTIC_VERSION_SOURCE}` +
    `(?:\\s+(?:>=|<=|>|<|=)?${SEMANTIC_VERSION_SOURCE})*)$`,
);
const CAPABILITY_PACK_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const MEMBER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const DIRECT_ONE_STATUS_MCP_TOOL_IDS = new Set([
  "persona.record",
  "persona.list",
  "persona.profile",
  "persona.update",
  "persona.delete",
  "persona.get_policy",
  "persona.set_policy",
]);

export const semanticVersionSchema = z
  .string()
  .max(128)
  .regex(SEMANTIC_VERSION_PATTERN, "version must be valid SemVer");

export const versionRangeSchema = z
  .string()
  .max(300)
  .regex(
    VERSION_RANGE_PATTERN,
    "version must be *, SemVer, a ^/~ range, or a space-separated comparator range",
  );

export const capabilityPackIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    CAPABILITY_PACK_ID_PATTERN,
    "capability pack ID must use lowercase DNS-style or kebab-case segments",
  );

export const capabilityMemberIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    MEMBER_ID_PATTERN,
    "capability member ID must start with a lowercase letter and use lowercase letters, numbers, dots, underscores, or hyphens",
  );

export const providerIdSchema = capabilityMemberIdSchema;
export const authorizationScopeSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/,
    "authorization scope contains unsupported characters",
  );

export const relativePackPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(isSafePackPath, {
    message:
      "path must be a normalized relative POSIX path without traversal or backslashes",
  });

export const jsonSchemaSchema = z.record(z.string(), z.json());

export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

const toolInputSchemaSchema = jsonSchemaSchema.refine(
  (schema) => schema.type === "object",
  "tool inputSchema must describe an object",
);

const capabilityInstructionDefinitionSchema = z
  .object({
    id: capabilityMemberIdSchema,
    description: z.string().min(1).max(2_000).optional(),
    source: relativePackPathSchema,
    tools: uniqueStringArray(capabilityMemberIdSchema, 200),
    memoryScopes: uniqueStringArray(capabilityMemberIdSchema, 100),
  })
  .strict();

export interface CapabilityInstruction {
  id: string;
  description?: string;
  source: string;
  tools: string[];
  memoryScopes: string[];
}

export const capabilityInstructionSchema = z
  .union([capabilityMemberIdSchema, capabilityInstructionDefinitionSchema])
  .transform((instruction): CapabilityInstruction => {
    if (typeof instruction !== "string") return instruction;
    return {
      id: instruction,
      source: `instructions/${instruction}.md`,
      tools: [],
      memoryScopes: [],
    };
  });

const capabilityToolDefinitionSchema = z
  .object({
    id: capabilityMemberIdSchema,
    description: z.string().min(1).max(2_000).optional(),
    inputSchema: toolInputSchemaSchema.optional(),
    outputSchema: jsonSchemaSchema.optional(),
    readOnly: z.boolean().optional(),
    requiresConfirmation: z.boolean().optional(),
    requiredScopes: uniqueStringArray(authorizationScopeSchema, 100).default(
      [],
    ),
    metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict();

export interface CapabilityTool {
  id: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  readOnly?: boolean;
  requiresConfirmation?: boolean;
  requiredScopes: string[];
  metadata?: JsonSchema;
}

export const capabilityToolSchema = z
  .union([capabilityMemberIdSchema, capabilityToolDefinitionSchema])
  .transform((tool): CapabilityTool => {
    if (typeof tool !== "string") return tool;
    return { id: tool, requiredScopes: [] };
  });

export const capabilitySkillsSchema = z
  .object({
    source: relativePackPathSchema,
    files: uniqueStringArray(relativePackPathSchema, 500).default([]),
  })
  .strict();

export const capabilityMemorySchema = z
  .object({
    scopes: uniqueStringArray(capabilityMemberIdSchema, 100).default([]),
  })
  .strict();

export const capabilityAuthorizationSchema = z
  .object({
    provider: providerIdSchema,
    requiredScopes: uniqueStringArray(authorizationScopeSchema, 200).min(1),
  })
  .strict();

export const capabilityAdapterSchema = z.enum([
  "chatgpt-plugin",
  "remote-mcp",
  "local-mcp",
  "claude-skill",
  "codex-plugin",
  "cursor-rules",
  "native-extension",
  "one-status-sdk",
  "markdown",
]);

export const capabilityDependencySchema = z
  .object({
    name: capabilityPackIdSchema,
    version: versionRangeSchema,
    optional: z.boolean(),
  })
  .strict();

export const runtimeDependencySchema = z
  .object({
    name: capabilityMemberIdSchema,
    version: versionRangeSchema,
    optional: z.boolean(),
  })
  .strict();

export const capabilityDependenciesSchema = z
  .object({
    packs: z.array(capabilityDependencySchema).max(100),
    runtimes: z.array(runtimeDependencySchema).max(100),
  })
  .strict();

const uiSettingSchema = z
  .object({
    id: capabilityMemberIdSchema,
    label: z.string().min(1).max(200),
    type: z.enum(["string", "number", "boolean", "select"]),
    required: z.boolean(),
    secret: z.boolean(),
    default: z.json().optional(),
    options: uniqueStringArray(z.string().min(1).max(200), 100).optional(),
  })
  .strict()
  .superRefine((setting, context) => {
    if (setting.type === "select" && !setting.options?.length) {
      context.addIssue({
        code: "custom",
        message: "select settings require at least one option",
        path: ["options"],
      });
    }
    if (setting.type !== "select" && setting.options) {
      context.addIssue({
        code: "custom",
        message: "options are only valid for select settings",
        path: ["options"],
      });
    }
    if (setting.secret && setting.type !== "string") {
      context.addIssue({
        code: "custom",
        message: "secret settings must use the string type",
        path: ["secret"],
      });
    }
    if (setting.secret && setting.default !== undefined) {
      context.addIssue({
        code: "custom",
        message: "secret settings cannot define a default value",
        path: ["default"],
      });
    }
    if (
      setting.default !== undefined &&
      !settingDefaultMatchesType(setting.type, setting.default)
    ) {
      context.addIssue({
        code: "custom",
        message: `default value must match the ${setting.type} setting type`,
        path: ["default"],
      });
    }
    if (
      setting.type === "select" &&
      typeof setting.default === "string" &&
      !setting.options?.includes(setting.default)
    ) {
      context.addIssue({
        code: "custom",
        message: "select default must be one of the declared options",
        path: ["default"],
      });
    }
  });

const uiActionSchema = z
  .object({
    id: capabilityMemberIdSchema,
    label: z.string().min(1).max(200),
    tool: capabilityMemberIdSchema,
  })
  .strict();

export const capabilityUiSchema = z
  .object({
    icon: relativePackPathSchema.optional(),
    settings: z.array(uiSettingSchema).max(100),
    actions: z.array(uiActionSchema).max(100),
  })
  .strict();

export const capabilityEventSchema = z
  .object({
    id: capabilityMemberIdSchema,
    direction: z.enum(["emit", "consume", "both"]),
    description: z.string().min(1).max(2_000).optional(),
    payloadSchema: jsonSchemaSchema,
  })
  .strict();

const hookHandlerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tool"),
      tool: capabilityMemberIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("instruction"),
      instruction: capabilityMemberIdSchema,
    })
    .strict(),
]);

export const capabilityHookSchema = z
  .object({
    id: capabilityMemberIdSchema,
    event: capabilityMemberIdSchema,
    mode: z.enum(["automatic", "confirmation"]),
    handler: hookHandlerSchema,
  })
  .strict();

const capabilityPackManifestObjectSchema = z
  .object({
    format: z.literal(CAPABILITY_PACK_FORMAT),
    schemaVersion: z.literal(CAPABILITY_PACK_SCHEMA_VERSION),
    name: capabilityPackIdSchema,
    version: semanticVersionSchema,
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    instructions: z.array(capabilityInstructionSchema).max(500),
    tools: z.array(capabilityToolSchema).max(500),
    skills: capabilitySkillsSchema.optional(),
    memory: capabilityMemorySchema,
    authorization: capabilityAuthorizationSchema.optional(),
    adapters: uniqueStringArray(capabilityAdapterSchema, 20).min(1),
    dependencies: capabilityDependenciesSchema.default(() => ({
      packs: [],
      runtimes: [],
    })),
    ui: capabilityUiSchema.default(() => ({ settings: [], actions: [] })),
    events: z.array(capabilityEventSchema).max(200).default([]),
    hooks: z.array(capabilityHookSchema).max(200).default([]),
  })
  .strict();

export const capabilityPackManifestSchema =
  capabilityPackManifestObjectSchema.superRefine(validateManifestSemantics);

export type CapabilitySkills = z.infer<typeof capabilitySkillsSchema>;
export type CapabilityMemory = z.infer<typeof capabilityMemorySchema>;
export type CapabilityAuthorization = z.infer<
  typeof capabilityAuthorizationSchema
>;
export type CapabilityAdapter = z.infer<typeof capabilityAdapterSchema>;
export type CapabilityDependency = z.infer<
  typeof capabilityDependencySchema
>;
export type RuntimeDependency = z.infer<typeof runtimeDependencySchema>;
export type CapabilityEvent = z.infer<typeof capabilityEventSchema>;
export type CapabilityHook = z.infer<typeof capabilityHookSchema>;
export type CapabilityPackManifest = z.output<
  typeof capabilityPackManifestSchema
>;
export type CapabilityPackManifestInput = z.input<
  typeof capabilityPackManifestSchema
>;

export function parseCapabilityPackManifest(
  value: unknown,
): CapabilityPackManifest {
  return capabilityPackManifestSchema.parse(value);
}

function uniqueStringArray<T extends z.ZodType<string>>(
  itemSchema: T,
  maximum: number,
) {
  return z
    .array(itemSchema)
    .max(maximum)
    .superRefine((items, context) => {
      reportDuplicateValues(items, context);
    });
}

function validateManifestSemantics(
  manifest: z.infer<typeof capabilityPackManifestObjectSchema>,
  context: z.RefinementCtx,
): void {
  reportDuplicateIds(manifest.instructions, "instructions", context);
  reportDuplicateIds(manifest.tools, "tools", context);
  reportDuplicateNames(manifest.dependencies.packs, "packs", context);
  reportDuplicateNames(manifest.dependencies.runtimes, "runtimes", context);
  reportDuplicateIds(manifest.ui.settings, "settings", context, ["ui"]);
  reportDuplicateIds(manifest.ui.actions, "actions", context, ["ui"]);
  reportDuplicateIds(manifest.events, "events", context);
  reportDuplicateIds(manifest.hooks, "hooks", context);

  const toolById = new Map(manifest.tools.map((tool) => [tool.id, tool]));
  const instructionIds = new Set(
    manifest.instructions.map((instruction) => instruction.id),
  );
  const memoryScopes = new Set(manifest.memory.scopes);
  const declaredScopes = new Set(
    manifest.authorization?.requiredScopes ?? [],
  );
  const eventById = new Map(manifest.events.map((event) => [event.id, event]));

  manifest.tools.forEach((tool, index) => {
    const directOneStatusMcp =
      tool.metadata?.execution === "one-status-mcp";
    if (directOneStatusMcp && !DIRECT_ONE_STATUS_MCP_TOOL_IDS.has(tool.id)) {
      addIssue(
        context,
        ["tools", index, "metadata", "execution"],
        `direct One Status MCP execution is not available for ${tool.id}`,
      );
    }
    if (
      tool.readOnly === false &&
      tool.requiresConfirmation !== true &&
      !directOneStatusMcp
    ) {
      addIssue(
        context,
        ["tools", index, "requiresConfirmation"],
        "write tools must require confirmation",
      );
    }
    if (tool.requiredScopes.length > 0 && !manifest.authorization) {
      addIssue(
        context,
        ["tools", index, "requiredScopes"],
        "tool scopes require a manifest authorization provider",
      );
    }
    tool.requiredScopes.forEach((scope, scopeIndex) => {
      if (!declaredScopes.has(scope)) {
        addIssue(
          context,
          ["tools", index, "requiredScopes", scopeIndex],
          `scope ${scope} is not declared by authorization.requiredScopes`,
        );
      }
    });
  });

  manifest.instructions.forEach((instruction, index) => {
    instruction.tools.forEach((tool, toolIndex) => {
      if (!toolById.has(tool)) {
        addIssue(
          context,
          ["instructions", index, "tools", toolIndex],
          `instruction references unknown tool ${tool}`,
        );
      }
    });
    instruction.memoryScopes.forEach((scope, scopeIndex) => {
      if (!memoryScopes.has(scope)) {
        addIssue(
          context,
          ["instructions", index, "memoryScopes", scopeIndex],
          `instruction references undeclared memory scope ${scope}`,
        );
      }
    });
  });

  manifest.dependencies.packs.forEach((dependency, index) => {
    if (dependency.name === manifest.name) {
      addIssue(
        context,
        ["dependencies", "packs", index, "name"],
        "a capability pack cannot depend on itself",
      );
    }
  });

  manifest.ui.actions.forEach((action, index) => {
    if (!toolById.has(action.tool)) {
      addIssue(
        context,
        ["ui", "actions", index, "tool"],
        `UI action references unknown tool ${action.tool}`,
      );
    }
  });

  manifest.hooks.forEach((hook, index) => {
    const event = eventById.get(hook.event);
    if (!event) {
      addIssue(
        context,
        ["hooks", index, "event"],
        `hook references unknown event ${hook.event}`,
      );
    } else if (event.direction === "emit") {
      addIssue(
        context,
        ["hooks", index, "event"],
        `hook cannot consume emit-only event ${hook.event}`,
      );
    }

    if (hook.handler.type === "instruction") {
      if (!instructionIds.has(hook.handler.instruction)) {
        addIssue(
          context,
          ["hooks", index, "handler", "instruction"],
          `hook references unknown instruction ${hook.handler.instruction}`,
        );
      }
      return;
    }

    const tool = toolById.get(hook.handler.tool);
    if (!tool) {
      addIssue(
        context,
        ["hooks", index, "handler", "tool"],
        `hook references unknown tool ${hook.handler.tool}`,
      );
    } else if (hook.mode === "automatic" && tool.requiresConfirmation) {
      addIssue(
        context,
        ["hooks", index, "mode"],
        `automatic hook cannot invoke confirmation-gated tool ${tool.id}`,
      );
    }
  });
}

function reportDuplicateValues(
  values: readonly string[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      addIssue(context, [index], `duplicate value ${value}`);
    }
    seen.add(value);
  });
}

function reportDuplicateIds(
  values: readonly { id: string }[],
  field: string,
  context: z.RefinementCtx,
  prefix: PropertyKey[] = [],
): void {
  reportDuplicates(values, "id", [...prefix, field], context);
}

function reportDuplicateNames(
  values: readonly { name: string }[],
  field: string,
  context: z.RefinementCtx,
): void {
  reportDuplicates(values, "name", ["dependencies", field], context);
}

function reportDuplicates<
  K extends "id" | "name",
  T extends Record<K, string>,
>(
  values: readonly T[],
  key: K,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const identifier = value[key];
    if (seen.has(identifier)) {
      addIssue(
        context,
        [...path, index, key],
        `duplicate ${key} ${identifier}`,
      );
    }
    seen.add(identifier);
  });
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", message, path });
}

function isSafePackPath(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!normalized) return false;
  return normalized
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function settingDefaultMatchesType(
  type: "string" | "number" | "boolean" | "select",
  value: z.infer<ReturnType<typeof z.json>>,
): boolean {
  switch (type) {
    case "string":
    case "select":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}
