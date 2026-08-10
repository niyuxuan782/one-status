import packageMetadata from "../../../package.json" with { type: "json" };
import { z } from "zod";

export const ONE_STATUS_VERSION = packageMetadata.version;

const timestampSchema = z.iso.datetime({ offset: true });

export const memoryScopeSchema = z.enum(["user", "project", "session"]);

export const memoryOriginSchema = z
  .object({
    type: z.enum(["manual", "agent", "imported", "generated"]),
    label: z.string().min(1).max(200),
    reference: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const memoryEntryObjectSchema = z
  .object({
    id: z.string().min(1),
    scope: memoryScopeSchema,
    projectId: z.string().min(1).optional(),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    state: z.enum(["candidate", "confirmed"]),
    origin: memoryOriginSchema.optional(),
    createdByAgentId: z.string().min(1).max(120).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const memoryEntrySchema = memoryEntryObjectSchema.superRefine(
  (entry, context) => {
    if (entry.scope === "project" && !entry.projectId) {
      context.addIssue({
        code: "custom",
        message: "projectId is required for project memory",
        path: ["projectId"],
      });
    }
  },
);

export const projectHandoffSchema = z
  .object({
    provider: z.literal("github"),
    repositoryUrl: z.url().refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "github.com";
      } catch {
        return false;
      }
    }, "repositoryUrl must be an HTTPS github.com URL"),
    branch: z.string().min(1).max(255),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    fileDigests: z
      .object({
        handoffMarkdownSha256: z.string().regex(/^[0-9a-f]{64}$/),
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
    publishedAt: timestampSchema,
    sourceDeviceId: z.string().min(1),
    statusVersion: z.number().int().positive(),
  })
  .strict();

export const projectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().default(""),
    techStack: z.array(z.string().min(1)).default([]),
    currentGoal: z.string().default(""),
    decisions: z.array(z.string().min(1)).default([]),
    handoff: projectHandoffSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict();

export const taskSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1).optional(),
    title: z.string().min(1),
    status: z.enum(["todo", "in_progress", "blocked", "done"]),
    completed: z.array(z.string()).default([]),
    next: z.array(z.string()).default([]),
    updatedAt: timestampSchema,
  })
  .strict();

export const actionPermissionSchema = z
  .object({
    service: z.string().min(1),
    actions: z.array(z.string().min(1)),
  })
  .strict();

export const agentGrantSchema = z
  .object({
    agentId: z.string().min(1),
    permissions: z.array(actionPermissionSchema),
    expiresAt: timestampSchema.optional(),
  })
  .strict();

export const encryptedPermissionVaultSchema = z
  .object({
    format: z.literal("one-status.encrypted-permission-vault"),
    version: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    updatedAt: timestampSchema,
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
    authTag: z.string().min(1),
  })
  .strict();

const preferenceValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const capabilityTargetSchema = z.enum([
  "chatgpt",
  "codex",
  "claude-code",
  "cursor",
  "ide",
  "markdown",
  "sdk",
]);

export const capabilityInstallationSchema = z
  .object({
    packId: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/,
      ),
    version: z.string().min(1).max(64),
    manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source: z
      .object({
        type: z.enum(["builtin", "file", "url"]),
        reference: z.string().min(1).max(2_000).optional(),
      })
      .strict(),
    targets: z
      .array(capabilityTargetSchema)
      .min(1)
      .max(capabilityTargetSchema.options.length)
      .refine((targets) => new Set(targets).size === targets.length, {
        message: "capability installation targets must be unique",
      }),
    enabled: z.boolean(),
    installedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((installation, context) => {
    if (installation.source.type !== "builtin" && !installation.source.reference) {
      context.addIssue({
        code: "custom",
        message: "reference is required for file and URL capability sources",
        path: ["source", "reference"],
      });
    }
  });

const capabilityInstallationsSchema = z
  .record(z.string(), capabilityInstallationSchema)
  .superRefine((installations, context) => {
    for (const [packId, installation] of Object.entries(installations)) {
      if (installation.packId !== packId) {
        context.addIssue({
          code: "custom",
          message: "capability installation key must match packId",
          path: [packId, "packId"],
        });
      }
    }
  });

export const personaCategorySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "persona category must use lowercase letters, numbers, and underscores",
  );

export const personaConfidenceSchema = z.enum([
  "explicit",
  "observed",
  "inferred",
]);

export const personaObservationSchema = z
  .object({
    observedAt: timestampSchema,
    sourceAgent: z.string().min(1).max(120),
    sourceProject: z.string().min(1).max(200).optional(),
    confidence: personaConfidenceSchema,
  })
  .strict();

export const personaEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    category: personaCategorySchema,
    content: z.string().trim().min(1).max(10_000),
    observedAt: timestampSchema,
    lastObservedAt: timestampSchema,
    observationCount: z.number().int().positive(),
    observations: z.array(personaObservationSchema).min(1).max(10_000),
    sourceAgent: z.string().min(1).max(120),
    sourceProject: z.string().min(1).max(200).optional(),
    confidence: personaConfidenceSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.observationCount !== event.observations.length) {
      context.addIssue({
        code: "custom",
        message: "observationCount must match observations length",
        path: ["observationCount"],
      });
    }
    const first = event.observations[0];
    const last = event.observations[event.observations.length - 1];
    if (first?.observedAt !== event.observedAt) {
      context.addIssue({
        code: "custom",
        message: "observedAt must match the first observation",
        path: ["observedAt"],
      });
    }
    if (last?.observedAt !== event.lastObservedAt) {
      context.addIssue({
        code: "custom",
        message: "lastObservedAt must match the last observation",
        path: ["lastObservedAt"],
      });
    }
    if (
      first &&
      (first.sourceAgent !== event.sourceAgent ||
        first.sourceProject !== event.sourceProject ||
        first.confidence !== event.confidence)
    ) {
      context.addIssue({
        code: "custom",
        message: "event provenance must match the first observation",
        path: ["observations", 0],
      });
    }
    for (let index = 1; index < event.observations.length; index += 1) {
      const previous = event.observations[index - 1];
      const current = event.observations[index];
      if (
        previous &&
        current &&
        Date.parse(current.observedAt) < Date.parse(previous.observedAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "observations must be ordered by observedAt",
          path: ["observations", index, "observedAt"],
        });
      }
    }
  });

export const personaProfileEntrySchema = z
  .object({
    category: personaCategorySchema,
    content: z.string().trim().min(1).max(10_000),
    confidence: personaConfidenceSchema,
    sourceEventIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(10_000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "sourceEventIds must be unique",
      }),
    firstObservedAt: timestampSchema,
    lastObservedAt: timestampSchema,
    observationCount: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (Date.parse(entry.lastObservedAt) < Date.parse(entry.firstObservedAt)) {
      context.addIssue({
        code: "custom",
        message: "lastObservedAt cannot precede firstObservedAt",
        path: ["lastObservedAt"],
      });
    }
  });

const personaProfileSchema = z
  .record(z.string(), personaProfileEntrySchema)
  .superRefine((profile, context) => {
    for (const [category, entry] of Object.entries(profile)) {
      if (entry.category !== category) {
        context.addIssue({
          code: "custom",
          message: "persona profile key must match category",
          path: [category, "category"],
        });
      }
    }
  });

export const personaPolicySchema = z
  .object({
    enabled: z.boolean(),
    blockedCategories: z
      .array(personaCategorySchema)
      .max(200)
      .refine((categories) => new Set(categories).size === categories.length, {
        message: "blockedCategories must be unique",
      }),
    allowedConfidences: z
      .array(personaConfidenceSchema)
      .min(1)
      .max(personaConfidenceSchema.options.length)
      .refine((values) => new Set(values).size === values.length, {
        message: "allowedConfidences must be unique",
      }),
    updatedAt: timestampSchema.optional(),
  })
  .strict();

export const personaStateSchema = z
  .object({
    events: z.array(personaEventSchema),
    profile: personaProfileSchema,
    policy: personaPolicySchema,
  })
  .strict();

export const agentToolIdSchema = z.enum([
  "codex",
  "claude-code",
  "cursor",
]);

export const modelSourceKindSchema = z.enum([
  "official-account",
  "official-api",
  "compatible-api",
  "local-service",
  "custom-endpoint",
]);

export const modelApiProtocolSchema = z.enum([
  "openai",
  "anthropic",
  "ollama",
  "azure-openai",
  "custom",
]);

const controlIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const modelSourceSchema = z
  .object({
    id: controlIdSchema,
    label: z.string().trim().min(1).max(200),
    kind: modelSourceKindSchema,
    protocol: modelApiProtocolSchema,
    endpoint: z.url().optional(),
    supportedTools: z
      .array(agentToolIdSchema)
      .min(1)
      .max(agentToolIdSchema.options.length)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: "supportedTools must be unique",
      }),
    credentialRef: z.string().min(1).max(240).optional(),
    credentialStatus: z.enum([
      "available",
      "missing",
      "not-required",
      "unverified",
    ]),
    lastVerifiedAt: timestampSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((source, context) => {
    const requiresEndpoint =
      source.kind === "compatible-api" ||
      source.kind === "local-service" ||
      source.kind === "custom-endpoint";
    if (requiresEndpoint && !source.endpoint) {
      context.addIssue({
        code: "custom",
        message: "endpoint is required for this model source kind",
        path: ["endpoint"],
      });
    }
    if (source.endpoint) {
      const endpoint = new URL(source.endpoint);
      const protocol = endpoint.protocol;
      if (protocol !== "https:" && protocol !== "http:") {
        context.addIssue({
          code: "custom",
          message: "model source endpoint must use HTTP or HTTPS",
          path: ["endpoint"],
        });
      }
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      ) {
        context.addIssue({
          code: "custom",
          message:
            "model source endpoint cannot include user info, query, or fragment",
          path: ["endpoint"],
        });
      }
    }
  });

export const modelDefinitionSchema = z
  .object({
    id: controlIdSchema,
    sourceId: controlIdSchema,
    name: z.string().trim().min(1).max(200),
    modelId: z.string().trim().min(1).max(500),
    supportedTools: z
      .array(agentToolIdSchema)
      .min(1)
      .max(agentToolIdSchema.options.length)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: "supportedTools must be unique",
      }),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const deviceToolReportSchema = z
  .object({
    toolId: agentToolIdSchema,
    name: z.string().min(1).max(120),
    installed: z.boolean(),
    version: z.string().max(120).optional(),
    currentModelRef: controlIdSchema.optional(),
    currentModelId: z.string().max(500).optional(),
    sourceId: controlIdSchema.optional(),
    sourceLabel: z.string().max(200).optional(),
    sourceKind: modelSourceKindSchema.optional(),
    protocol: modelApiProtocolSchema.optional(),
    endpointHost: z.string().max(500).optional(),
    health: z.enum([
      "healthy",
      "unconfigured",
      "pending",
      "error",
      "unknown",
    ]),
    lastConfiguredAt: timestampSchema.optional(),
  })
  .strict();

export const deviceModelUsageEntrySchema = z
  .object({
    toolId: agentToolIdSchema,
    modelId: z.string().min(1).max(500),
    dataSource: z.enum(["codex-session", "claude-session"]),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cachedInputTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    cacheCreationInputTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requests: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    latestAt: timestampSchema.optional(),
  })
  .strict();

export const deviceModelUsageSchema = z
  .object({
    scannedAt: timestampSchema,
    scope: z.string().min(1).max(120),
    filesScanned: z.number().int().nonnegative().max(1_000),
    truncated: z.boolean(),
    entries: z.array(deviceModelUsageEntrySchema).max(2_000),
  })
  .strict();

export const deviceReportSchema = z
  .object({
    deviceId: z.string().min(1).max(200),
    deviceName: z.string().min(1).max(120),
    operatingSystem: z.enum(["macos", "windows", "linux", "other"]),
    osVersion: z.string().min(1).max(200),
    architecture: z.string().min(1).max(80),
    backgroundVersion: z.string().min(1).max(64),
    tools: z.array(deviceToolReportSchema).max(agentToolIdSchema.options.length),
    reportedAt: timestampSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (new Set(report.tools.map((tool) => tool.toolId)).size !== report.tools.length) {
      context.addIssue({
        code: "custom",
        message: "device tools must be unique",
        path: ["tools"],
      });
    }
  });

export const configurationIntentStatusSchema = z.enum([
  "pending",
  "applying",
  "applied",
  "failed",
  "rollback",
]);

const configurationSnapshotSchema = z
  .object({
    model: modelDefinitionSchema,
    source: modelSourceSchema,
  })
  .strict();

export const configurationIntentSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.string().min(1).max(200),
    toolId: agentToolIdSchema,
    modelId: controlIdSchema,
    sourceId: controlIdSchema,
    status: configurationIntentStatusSchema,
    requestedAt: timestampSchema,
    requestedByDeviceId: z.string().min(1).max(200),
    updatedAt: timestampSchema,
    attempts: z.number().int().nonnegative(),
    configuration: configurationSnapshotSchema.optional(),
    claimId: z.uuid().optional(),
    claimedAt: timestampSchema.optional(),
    claimExpiresAt: timestampSchema.optional(),
    previous: z
      .object({
        modelId: z.string().max(500).optional(),
        sourceId: controlIdSchema.optional(),
      })
      .strict()
      .optional(),
    appliedAt: timestampSchema.optional(),
    rollbackAt: timestampSchema.optional(),
    expectedPlanId: z.string().regex(/^plan_[a-f0-9]{64}$/).optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    const claimValues = [
      intent.claimId,
      intent.claimedAt,
      intent.claimExpiresAt,
    ];
    const claimFieldCount = claimValues.filter(
      (value) => value !== undefined,
    ).length;
    if (claimFieldCount !== 0 && claimFieldCount !== claimValues.length) {
      context.addIssue({
        code: "custom",
        message: "configuration intent claim fields must be supplied together",
        path: ["claimId"],
      });
    }
    if (
      intent.claimedAt &&
      intent.claimExpiresAt &&
      Date.parse(intent.claimExpiresAt) <= Date.parse(intent.claimedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "configuration intent claim must expire after it is acquired",
        path: ["claimExpiresAt"],
      });
    }
    if (intent.configuration) {
      if (
        intent.configuration.model.id !== intent.modelId ||
        intent.configuration.source.id !== intent.sourceId ||
        intent.configuration.model.sourceId !== intent.sourceId
      ) {
        context.addIssue({
          code: "custom",
          message: "configuration snapshot IDs must match the intent",
          path: ["configuration"],
        });
      }
      if (
        !intent.configuration.model.supportedTools.includes(intent.toolId) ||
        !intent.configuration.source.supportedTools.includes(intent.toolId)
      ) {
        context.addIssue({
          code: "custom",
          message: "configuration snapshot must support the intent tool",
          path: ["configuration"],
        });
      }
    }
  });

export const deviceControlStateSchema = z
  .object({
    sources: z.record(z.string(), modelSourceSchema),
    models: z.record(z.string(), modelDefinitionSchema),
    reports: z.record(z.string(), deviceReportSchema),
    intents: z.record(z.string(), configurationIntentSchema),
  })
  .strict()
  .superRefine((state, context) => {
    for (const [id, source] of Object.entries(state.sources)) {
      if (id !== source.id) {
        context.addIssue({
          code: "custom",
          message: "model source key must match id",
          path: ["sources", id, "id"],
        });
      }
    }
    for (const [id, model] of Object.entries(state.models)) {
      if (id !== model.id) {
        context.addIssue({
          code: "custom",
          message: "model key must match id",
          path: ["models", id, "id"],
        });
      }
      if (!state.sources[model.sourceId]) {
        context.addIssue({
          code: "custom",
          message: "model source was not found",
          path: ["models", id, "sourceId"],
        });
      }
    }
    for (const [deviceId, report] of Object.entries(state.reports)) {
      if (deviceId !== report.deviceId) {
        context.addIssue({
          code: "custom",
          message: "device report key must match deviceId",
          path: ["reports", deviceId, "deviceId"],
        });
      }
    }
    for (const [id, intent] of Object.entries(state.intents)) {
      if (id !== intent.id) {
        context.addIssue({
          code: "custom",
          message: "configuration intent key must match id",
          path: ["intents", id, "id"],
        });
      }
      const model = state.models[intent.modelId];
      if (!model || model.sourceId !== intent.sourceId) {
        context.addIssue({
          code: "custom",
          message: "configuration intent model and source do not match",
          path: ["intents", id, "modelId"],
        });
      }
    }
  });

export const statusDocumentSchema = z
  .object({
    schemaVersion: z.literal(4),
    identity: z
      .object({
        displayName: z.string().optional(),
        locale: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict(),
    preferences: z.record(z.string(), preferenceValueSchema),
    memory: z.array(memoryEntrySchema),
    projects: z.record(z.string(), projectSchema),
    workspace: z
      .object({
        activeProjectId: z.string().optional(),
        currentContext: z.string().optional(),
        lastAgentId: z.string().optional(),
      })
      .strict(),
    permissions: z
      .object({
        grants: z.array(agentGrantSchema),
        vault: encryptedPermissionVaultSchema.optional(),
      })
      .strict(),
    tools: z
      .object({
        enabled: z.array(z.string()),
      })
      .strict(),
    capabilities: z
      .object({
        installations: capabilityInstallationsSchema,
      })
      .strict(),
    persona: personaStateSchema,
    deviceControl: deviceControlStateSchema,
    tasks: z.record(z.string(), taskSchema),
  })
  .strict();

const legacyPersonaStatusDocumentV4Schema = statusDocumentSchema
  .omit({ deviceControl: true })
  .strict();

const legacyStatusDocumentV3Schema = statusDocumentSchema
  .omit({ persona: true, deviceControl: true })
  .extend({ schemaVersion: z.literal(3) })
  .strict();

const legacyStatusDocumentV2Schema = legacyStatusDocumentV3Schema
  .omit({ capabilities: true })
  .extend({ schemaVersion: z.literal(2) })
  .strict();

const legacyMemoryEntrySchema = memoryEntryObjectSchema
  .omit({ state: true, origin: true, createdByAgentId: true })
  .superRefine((entry, context) => {
    if (entry.scope === "project" && !entry.projectId) {
      context.addIssue({
        code: "custom",
        message: "projectId is required for project memory",
        path: ["projectId"],
      });
    }
  });
const legacyProjectHandoffSchema = projectHandoffSchema
  .omit({ sourceCommit: true, fileDigests: true })
  .strict();
const legacyProjectSchema = projectSchema
  .extend({ handoff: legacyProjectHandoffSchema.optional() })
  .strict();
const legacyStatusDocumentSchema = legacyStatusDocumentV2Schema
  .extend({
    schemaVersion: z.literal(1),
    memory: z.array(legacyMemoryEntrySchema),
    projects: z.record(z.string(), legacyProjectSchema),
  })
  .strict();

export type StatusDocument = z.infer<typeof statusDocumentSchema>;
export type CapabilityInstallation = z.infer<
  typeof capabilityInstallationSchema
>;
export type CapabilityTarget = z.infer<typeof capabilityTargetSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type PersonaCategory = z.infer<typeof personaCategorySchema>;
export type PersonaConfidence = z.infer<typeof personaConfidenceSchema>;
export type PersonaEvent = z.infer<typeof personaEventSchema>;
export type PersonaObservation = z.infer<typeof personaObservationSchema>;
export type PersonaPolicy = z.infer<typeof personaPolicySchema>;
export type PersonaProfileEntry = z.infer<typeof personaProfileEntrySchema>;
export type PersonaState = z.infer<typeof personaStateSchema>;
export type AgentToolId = z.infer<typeof agentToolIdSchema>;
export type ConfigurationIntent = z.infer<typeof configurationIntentSchema>;
export type ConfigurationIntentStatus = z.infer<
  typeof configurationIntentStatusSchema
>;
export type DeviceControlState = z.infer<typeof deviceControlStateSchema>;
export type DeviceReport = z.infer<typeof deviceReportSchema>;
export type DeviceToolReport = z.infer<typeof deviceToolReportSchema>;
export type DeviceModelUsage = z.infer<typeof deviceModelUsageSchema>;
export type DeviceModelUsageEntry = z.infer<
  typeof deviceModelUsageEntrySchema
>;
export type ModelApiProtocol = z.infer<typeof modelApiProtocolSchema>;
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;
export type ModelSource = z.infer<typeof modelSourceSchema>;
export type ModelSourceKind = z.infer<typeof modelSourceKindSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectHandoff = z.infer<typeof projectHandoffSchema>;
export type Task = z.infer<typeof taskSchema>;
export type EncryptedPermissionVault = z.infer<
  typeof encryptedPermissionVaultSchema
>;

export const encryptedEnvelopeSchema = z
  .object({
    format: z.literal("one-status.encrypted-status"),
    version: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    revision: z.number().int().positive(),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
    authTag: z.string().min(1),
  })
  .strict();

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export const authRequestSchema = z
  .object({
    email: z.email().transform((value) => value.toLowerCase()),
    password: z.string().min(10).max(256),
    deviceName: z.string().min(1).max(120),
    installationId: z.uuid().optional(),
  })
  .strict();

export const registerRequestSchema = authRequestSchema.extend({
  initialEnvelope: encryptedEnvelopeSchema,
}).superRefine((request, context) => {
  if (request.initialEnvelope.revision !== 1) {
    context.addIssue({
      code: "custom",
      message: "initialEnvelope revision must be 1",
      path: ["initialEnvelope", "revision"],
    });
  }
});

export const authResponseSchema = z
  .object({
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    token: z.string().min(1),
    expiresAt: timestampSchema,
  })
  .strict();

export const accountResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        email: z.email(),
        createdAt: timestampSchema,
      })
      .strict(),
    devices: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          createdAt: timestampSchema,
          lastSeenAt: timestampSchema,
          online: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const deviceHeartbeatResponseSchema = z
  .object({
    deviceId: z.string().min(1),
    lastSeenAt: timestampSchema,
    serverTime: timestampSchema,
  })
  .strict();

export const sessionRevocationResponseSchema = z
  .object({ revoked: z.literal(true) })
  .strict();

export const deviceRevocationResponseSchema = z
  .object({
    revoked: z.literal(true),
    deviceId: z.string().min(1),
  })
  .strict();

export const statusSnapshotSchema = z
  .object({
    version: z.number().int().nonnegative(),
    envelope: encryptedEnvelopeSchema.nullable(),
    updatedAt: timestampSchema.nullable(),
    deduplicated: z.boolean().optional(),
  })
  .strict();

export const putStatusRequestSchema = z
  .object({
    mutationId: z.uuid(),
    mutationDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    baseVersion: z.number().int().nonnegative(),
    envelope: encryptedEnvelopeSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.envelope.revision !== request.baseVersion + 1) {
      context.addIssue({
        code: "custom",
        message: "envelope revision must equal baseVersion + 1",
        path: ["envelope", "revision"],
      });
    }
  });

export type AuthRequest = z.infer<typeof authRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type AccountResponse = z.infer<typeof accountResponseSchema>;
export type SessionRevocationResponse = z.infer<
  typeof sessionRevocationResponseSchema
>;
export type DeviceRevocationResponse = z.infer<
  typeof deviceRevocationResponseSchema
>;
export type DeviceHeartbeatResponse = z.infer<
  typeof deviceHeartbeatResponseSchema
>;
export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>;
export type PutStatusRequest = z.infer<typeof putStatusRequestSchema>;

export function createEmptyStatus(): StatusDocument {
  return {
    schemaVersion: 4,
    identity: {},
    preferences: {},
    memory: [],
    projects: {},
    workspace: {},
    permissions: { grants: [] },
    tools: { enabled: [] },
    capabilities: { installations: {} },
    persona: createEmptyPersonaState(),
    deviceControl: createEmptyDeviceControlState(),
    tasks: {},
  };
}

export function parseStatusDocument(value: unknown): StatusDocument {
  const compatibleValue = stripTransientDeviceReportUsage(value);
  const current = statusDocumentSchema.safeParse(compatibleValue);
  if (current.success) return current.data;
  const version4 =
    legacyPersonaStatusDocumentV4Schema.safeParse(compatibleValue);
  if (version4.success) {
    return {
      ...version4.data,
      deviceControl: createEmptyDeviceControlState(),
    };
  }
  const version3 = legacyStatusDocumentV3Schema.safeParse(value);
  if (version3.success) {
    return {
      ...version3.data,
      schemaVersion: 4,
      persona: createEmptyPersonaState(),
      deviceControl: createEmptyDeviceControlState(),
    };
  }
  const previous = legacyStatusDocumentV2Schema.safeParse(value);
  if (previous.success) {
    return {
      ...previous.data,
      schemaVersion: 4,
      capabilities: { installations: {} },
      persona: createEmptyPersonaState(),
      deviceControl: createEmptyDeviceControlState(),
    };
  }
  const legacy = legacyStatusDocumentSchema.parse(value);
  return {
    ...legacy,
    schemaVersion: 4,
    capabilities: { installations: {} },
    persona: createEmptyPersonaState(),
    deviceControl: createEmptyDeviceControlState(),
    memory: legacy.memory.map((entry) => ({
      ...entry,
      state: "confirmed" as const,
    })),
  };
}

function stripTransientDeviceReportUsage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  const deviceControl = document.deviceControl;
  if (
    !deviceControl ||
    typeof deviceControl !== "object" ||
    Array.isArray(deviceControl)
  ) {
    return value;
  }
  const reports = (deviceControl as Record<string, unknown>).reports;
  if (!reports || typeof reports !== "object" || Array.isArray(reports)) {
    return value;
  }
  let changed = false;
  const compatibleReports = Object.fromEntries(
    Object.entries(reports).map(([deviceId, report]) => {
      if (
        !report ||
        typeof report !== "object" ||
        Array.isArray(report) ||
        !("modelUsage" in report)
      ) {
        return [deviceId, report];
      }
      changed = true;
      return [
        deviceId,
        Object.fromEntries(
          Object.entries(report).filter(([key]) => key !== "modelUsage"),
        ),
      ];
    }),
  );
  if (!changed) return value;
  return {
    ...document,
    deviceControl: {
      ...(deviceControl as Record<string, unknown>),
      reports: compatibleReports,
    },
  };
}

function createEmptyPersonaState(): PersonaState {
  return {
    events: [],
    profile: {},
    policy: {
      enabled: true,
      blockedCategories: [],
      allowedConfidences: ["explicit", "observed", "inferred"],
    },
  };
}

function createEmptyDeviceControlState(): DeviceControlState {
  return { sources: {}, models: {}, reports: {}, intents: {} };
}
