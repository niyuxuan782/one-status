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

export const statusDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
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
    tasks: z.record(z.string(), taskSchema),
  })
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
const legacyStatusDocumentSchema = statusDocumentSchema
  .extend({
    schemaVersion: z.literal(1),
    memory: z.array(legacyMemoryEntrySchema),
    projects: z.record(z.string(), legacyProjectSchema),
  })
  .strict();

export type StatusDocument = z.infer<typeof statusDocumentSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
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
    schemaVersion: 2,
    identity: {},
    preferences: {},
    memory: [],
    projects: {},
    workspace: {},
    permissions: { grants: [] },
    tools: { enabled: [] },
    tasks: {},
  };
}

export function parseStatusDocument(value: unknown): StatusDocument {
  const current = statusDocumentSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyStatusDocumentSchema.parse(value);
  return {
    ...legacy,
    schemaVersion: 2,
    memory: legacy.memory.map((entry) => ({
      ...entry,
      state: "confirmed" as const,
    })),
  };
}
