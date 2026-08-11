import { createHash, timingSafeEqual } from "node:crypto";
import {
  CloudVaultAccessDeniedError,
  CloudVaultAgentApi,
  CloudVaultApprovalRequiredError,
  CloudVaultConflictError,
  CloudVaultMigrationConflictError,
  cloudVaultCredentialKinds,
  cloudVaultApprovalOperations,
  credentialSetDigest,
  isCredentialPublicFieldName,
  type CloudVaultCredentialPlaintext,
  type CloudVaultService,
} from "@one-status/api/cloud-vault";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import {
  OpaquePasswordAuthority,
  type OpaquePasswordRecord,
} from "@one-status/pake/authority";
import { createOpaqueServerSetup } from "@one-status/pake";
import { z, ZodError } from "zod";

const agentTokenHeader = "x-one-status-agent-token";

export interface VaultServiceAppOptions {
  bodyLimit?: number;
  kmsVerifiedAt: string;
  logger?: boolean;
  service: CloudVaultService;
  serviceToken: string;
  walletPake?: OpaquePasswordAuthority;
}

export function createVaultServiceApp(
  options: VaultServiceAppOptions,
): FastifyInstance {
  const expectedServiceToken = tokenDigest(
    requiredServiceToken(options.serviceToken),
  );
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger
      ? {
          level: "info",
          redact: {
            paths: [
              "req.headers.authorization",
              `req.headers[\"${agentTokenHeader}\"]`,
              "request.headers.authorization",
              `request.headers[\"${agentTokenHeader}\"]`,
              "body",
              "req.body",
              "request.body",
            ],
            remove: true,
          },
        }
      : false,
  });
  const agentApi = new CloudVaultAgentApi(options.service);
  const walletPake = options.walletPake ?? new OpaquePasswordAuthority({
    serverSetup: createOpaqueServerSetup(),
    store: cloudWalletPakeStore(options.service),
  });

  app.addHook("onClose", () => walletPake.close());

  app.addHook("onRequest", async (request, reply) => {
    if (!validServiceAuthorization(request, expectedServiceToken)) {
      await reply.code(401).send({
        error: { code: "service_auth_required", message: "Unauthorized." },
      });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store, private");
    reply.header("pragma", "no-cache");
    reply.header("expires", "0");
    reply.header("x-content-type-options", "nosniff");
    reply.removeHeader("etag");
    return payload;
  });

  app.get("/health", async () => ({
    kms: "ready",
    kmsVerifiedAt: options.kmsVerifiedAt,
    service: "one-status-vault",
    status: "ok",
  }));

  app.post("/v1/internal/agent-sessions", async (request, reply) => {
    const input = issueSessionSchema.parse(request.body);
    const issued = await options.service.issueAgentSession({
      agentId: input.agentId,
      clientId: input.clientId,
      projectIds: [
        ...new Set([
          ...input.projectIds,
          ...input.grants.flatMap((grant) => grant.projectIds),
        ]),
      ],
      ttlMs: input.ttlSeconds ? input.ttlSeconds * 1_000 : undefined,
      userId: input.userId,
    });
    const createdGrantIds: string[] = [];
    try {
      for (const grant of input.grants) {
        const created = await options.service.createAgentGrant({
          actor: { id: "vault-service", type: "system" },
          agentId: input.agentId,
          credentialId: grant.credentialId,
          expiresAt: issued.expiresAt,
          projectIds: grant.projectIds,
          purposes: grant.purposes,
          userId: input.userId,
        });
        createdGrantIds.push(created.id);
      }
    } catch (error) {
      await Promise.all(
        createdGrantIds.map((grantId) =>
          options.service.revokeAgentGrant({
            actor: { id: "vault-service", type: "system" },
            grantId,
            userId: input.userId,
          }),
        ),
      );
      await options.service.revokeAgentSession({
        sessionId: issued.id,
        userId: input.userId,
      });
      throw error;
    }
    return reply.code(201).send({ session: issued });
  });

  app.post("/v1/internal/approvals", async (request, reply) => {
    const input = approvalRequestSchema.parse(request.body);
    const approval = await agentApi.requestApproval(agentToken(request), input);
    return reply.code(201).send(approval);
  });

  app.get("/v1/internal/users/:userId/approvals", async (request) => {
    const { userId } = userParameterSchema.parse(request.params);
    const { limit } = approvalListSchema.parse(request.query);
    return {
      approvals: await options.service.listAgentApprovals(userId, limit),
    };
  });

  app.patch(
    "/v1/internal/users/:userId/approvals/:approvalId",
    async (request, reply) => {
      const { approvalId, userId } = userApprovalParameterSchema.parse(
        request.params,
      );
      const { decision } = approvalDecisionSchema.parse(request.body);
      const decided = await options.service.decideAgentApproval({
        approvalId,
        decision,
        userId,
      });
      if (!decided) {
        return reply.code(409).send({
          error: {
            code: "approval_unavailable",
            message: "Approval is no longer pending.",
          },
        });
      }
      return { approvalId, decision };
    },
  );

  app.post("/v1/internal/users/:userId/credentials/list", async (request) => {
    const { userId } = userParameterSchema.parse(request.params);
    const input = listCredentialSchema.parse(request.body);
    return {
      credentials: await options.service.listCredentials(
        { ...input, userId },
        { id: userId, type: "user" },
      ),
    };
  });

  app.post(
    "/v1/internal/users/:userId/credentials/:credentialId/reveal",
    async (request, reply) => {
      const { credentialId, userId } = userCredentialParameterSchema.parse(
        request.params,
      );
      const { walletGrant } = walletGrantSchema.parse(request.body);
      if (!walletPake.consumeGrant(userId, walletGrant)) {
        return reply.code(403).send({
          error: { code: "wallet_pake_grant_invalid", message: "Forbidden." },
        });
      }
      return {
        credential: await options.service.revealForUserAuthorized({
          credentialId,
          userId,
        }),
      };
    },
  );

  app.post(
    "/v1/internal/users/:userId/wallet-pake/login/start",
    async (request) => {
      const { userId } = userParameterSchema.parse(request.params);
      const input = walletPakeLoginStartSchema.parse(request.body);
      return walletPake.startLogin({
        startLoginRequest: input.startLoginRequest,
        userId,
      });
    },
  );

  app.post(
    "/v1/internal/users/:userId/wallet-pake/login/finish",
    async (request) => {
      const { userId } = userParameterSchema.parse(request.params);
      const input = walletPakeLoginFinishSchema.parse(request.body);
      return walletPake.finishLogin({
        finishLoginRequest: input.finishLoginRequest,
        flowId: input.flowId,
        userId,
      });
    },
  );

  app.post(
    "/v1/internal/users/:userId/wallet-pake/register/start",
    async (request) => {
      const { userId } = userParameterSchema.parse(request.params);
      const input = walletPakeRegistrationStartSchema.parse(request.body);
      return walletPake.startRegistration({ ...input, userId });
    },
  );

  app.put(
    "/v1/internal/users/:userId/wallet-pake/register/finish",
    async (request) => {
      const { userId } = userParameterSchema.parse(request.params);
      const input = walletPakeRegistrationFinishSchema.parse(request.body);
      const record = await walletPake.finishRegistration({ ...input, userId });
      return { registered: true, updatedAt: record.updatedAt };
    },
  );

  app.post(
    "/v1/internal/users/:userId/migrations/backfill",
    { bodyLimit: 8 * 1024 * 1024, logLevel: "silent" },
    async (request, reply) => {
      const { userId } = userParameterSchema.parse(request.params);
      const input = migrationBackfillSchema.parse(request.body);
      const credentials: CloudVaultCredentialPlaintext[] = input.credentials.map(
        (credential) => ({ ...credential, userId }),
      );
      const validationKey = Buffer.from(input.validationKey, "base64url");
      try {
        const uploadedById = new Map(
          credentials.map((credential) => [credential.id, credential]),
        );
        const existing = await options.service.exportPlaintextForMigration(userId);
        for (const credential of existing) {
          const uploaded = uploadedById.get(credential.id);
          if (
            !uploaded ||
            credentialSetDigest([credential], validationKey) !==
              credentialSetDigest([uploaded], validationKey)
          ) {
            throw new CloudVaultMigrationConflictError();
          }
        }
        const existingIds = new Set(existing.map((credential) => credential.id));
        for (const credential of credentials) {
          if (!existingIds.has(credential.id)) {
            await options.service.importMigratedCredential(credential);
          }
        }
        const cloud = await options.service.exportPlaintextForMigration(userId);
        const digest = credentialSetDigest(
          cloud,
          validationKey,
        );
        const verified =
          cloud.length === credentials.length && digest === input.digest;
        if (!verified) {
          return reply.code(409).send({
            error: {
              code: "migration_verification_failed",
              message: "Migration verification failed.",
            },
          });
        }
        return {
          count: cloud.length,
          digest,
          verified: true,
        };
      } finally {
        validationKey.fill(0);
      }
    },
  );

  app.post("/v1/internal/credentials", async (request, reply) => {
    const input = createCredentialSchema.parse(request.body);
    const credential = await agentApi.register(agentToken(request), input);
    return reply.code(201).send({ credential });
  });

  app.post("/v1/internal/credentials/list", async (request) => {
    const input = listCredentialSchema.parse(request.body);
    return { credentials: await agentApi.list(agentToken(request), input) };
  });

  app.post("/v1/internal/credentials/resolve", async (request) => {
    const input = resolveCredentialSchema.parse(request.body);
    return agentApi.resolve(agentToken(request), input);
  });

  app.post(
    "/v1/internal/credentials/:credentialId/get",
    async (request) => {
      const { credentialId } = credentialParameterSchema.parse(request.params);
      const input = credentialUseSchema.parse(request.body);
      return {
        credential: await agentApi.get(agentToken(request), {
          credentialId,
          ...input,
        }),
      };
    },
  );

  app.patch(
    "/v1/internal/credentials/:credentialId",
    async (request) => {
      const { credentialId } = credentialParameterSchema.parse(request.params);
      const input = updateCredentialSchema.parse(request.body);
      return {
        credential: await agentApi.update(agentToken(request), {
          approvalToken: input.approvalToken,
          credentialId,
          patch: input.patch,
          projectId: input.projectId,
          purpose: input.purpose,
        }),
      };
    },
  );

  app.delete(
    "/v1/internal/credentials/:credentialId",
    async (request) => {
      const { credentialId } = credentialParameterSchema.parse(request.params);
      const input = credentialMutationUseSchema.parse(request.body);
      return {
        credentialId,
        deleted: await agentApi.delete(agentToken(request), {
          credentialId,
          ...input,
        }),
      };
    },
  );

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Request is invalid." },
      });
    }
    if (error instanceof CloudVaultAccessDeniedError) {
      return reply.code(403).send({
        error: { code: "credential_access_denied", message: "Forbidden." },
      });
    }
    if (error instanceof CloudVaultApprovalRequiredError) {
      return reply.code(409).send({
        error: {
          code: "credential_approval_required",
          message: "A current user approval is required.",
        },
      });
    }
    if (error instanceof CloudVaultConflictError) {
      return reply.code(409).send({
        error: {
          code: "credential_revision_conflict",
          message: "Credential changed concurrently.",
        },
      });
    }
    if (error instanceof CloudVaultMigrationConflictError) {
      return reply.code(409).send({
        error: {
          code: "migration_conflict",
          message: "Cloud credentials changed after migration started.",
        },
      });
    }
    if (error instanceof Error && error.message === "wallet_pake_invalid") {
      return reply.code(403).send({
        error: { code: "wallet_pake_invalid", message: "Forbidden." },
      });
    }
    if (
      error instanceof Error &&
      [
        "wallet_pake_already_initialized",
        "wallet_pake_grant_invalid",
        "wallet_pake_uninitialized",
      ].includes(error.message)
    ) {
      const forbidden = error.message === "wallet_pake_grant_invalid";
      return reply.code(forbidden ? 403 : 409).send({
        error: { code: error.message, message: forbidden ? "Forbidden." : "Conflict." },
      });
    }
    if (
      error instanceof Error &&
      error.message === "wallet_pake_capacity_reached"
    ) {
      return reply.code(503).send({
        error: { code: error.message, message: "Service unavailable." },
      });
    }
    return reply.code(500).send({
      error: { code: "vault_operation_failed", message: "Operation failed." },
    });
  });

  return app;
}

const metadataSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const metadataListSchema = z.array(metadataSchema).max(128);
const metadataMapSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    z.string().min(1).max(100_000),
  )
  .refine((value) => Object.keys(value).length <= 128);
const publicCredentialFieldsSchema = metadataMapSchema.refine(
  (value) => Object.keys(value).every(isCredentialPublicFieldName),
  { message: "Sensitive values must be stored in secrets." },
);
const credentialKindSchema = z.enum(cloudVaultCredentialKinds);
const approvalTokenSchema = z.string().regex(/^osvp1_[A-Za-z0-9_-]{43}$/);
const approvalRequestSchema = z
  .object({
    operation: z.enum(cloudVaultApprovalOperations),
    request: z.record(z.string(), z.unknown()).refine(
      (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64,
    ),
  })
  .strict();
const approvalListSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
  .strict();
const approvalDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]) })
  .strict();
const grantSchema = z
  .object({
    credentialId: metadataSchema.nullable().optional(),
    projectIds: metadataListSchema.default([]),
    purposes: metadataListSchema.min(1),
  })
  .strict();
const issueSessionSchema = z
  .object({
    agentId: metadataSchema,
    clientId: metadataSchema.optional(),
    grants: z.array(grantSchema).max(128).default([]),
    projectIds: metadataListSchema.default([]),
    ttlSeconds: z.number().int().min(1).max(3_600).optional(),
    userId: metadataSchema,
  })
  .strict();
const credentialAccessPolicySchema = z
  .object({
    allowAgentRead: z.boolean().optional(),
    allowedAgentIds: metadataListSchema.optional(),
    allowedProjectIds: metadataListSchema.optional(),
    deniedAgentIds: metadataListSchema.optional(),
    deniedProjectIds: metadataListSchema.optional(),
    requireApproval: z.boolean().optional(),
  })
  .strict();
const credentialAccessPolicyRequiredSchema = credentialAccessPolicySchema.required();
const createCredentialSchema = z
  .object({
    approvalToken: approvalTokenSchema,
    accessPolicy: credentialAccessPolicySchema.optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    fields: publicCredentialFieldsSchema.default({}),
    id: metadataSchema.optional(),
    kind: credentialKindSchema,
    label: metadataSchema,
    projectId: metadataSchema.optional(),
    purposes: metadataListSchema.min(1),
    secrets: metadataMapSchema.refine(
      (value) => Object.keys(value).length > 0,
    ),
    tags: metadataListSchema.default([]),
  })
  .strict();
const resolveCredentialSchema = z
  .object({
    kinds: z.array(credentialKindSchema).max(cloudVaultCredentialKinds.length).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    matchFields: metadataMapSchema.optional(),
    projectId: metadataSchema.optional(),
    purpose: metadataSchema,
    search: metadataSchema.optional(),
    tags: metadataListSchema.optional(),
  })
  .strict();
const listCredentialSchema = z
  .object({
    kinds: z.array(credentialKindSchema).max(cloudVaultCredentialKinds.length).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    projectId: metadataSchema.optional(),
    purposes: metadataListSchema.optional(),
    search: metadataSchema.optional(),
    tags: metadataListSchema.optional(),
  })
  .strict();
const credentialUseSchema = z
  .object({
    approvalToken: approvalTokenSchema.optional(),
    projectId: metadataSchema.optional(),
    purpose: metadataSchema,
  })
  .strict();
const credentialMutationUseSchema = credentialUseSchema.extend({
  approvalToken: approvalTokenSchema,
});
const credentialPatchSchema = z
  .object({
    accessPolicy: credentialAccessPolicySchema.optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    fields: publicCredentialFieldsSchema.optional(),
    kind: credentialKindSchema.optional(),
    label: metadataSchema.optional(),
    purposes: metadataListSchema.min(1).optional(),
    secrets: metadataMapSchema.optional(),
    tags: metadataListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const updateCredentialSchema = z
  .object({
    approvalToken: approvalTokenSchema,
    patch: credentialPatchSchema,
    projectId: metadataSchema.optional(),
    purpose: metadataSchema,
  })
  .strict();
const credentialParameterSchema = z
  .object({ credentialId: metadataSchema })
  .strict();
const userParameterSchema = z.object({ userId: metadataSchema }).strict();
const userCredentialParameterSchema = z
  .object({ credentialId: metadataSchema, userId: metadataSchema })
  .strict();
const userApprovalParameterSchema = z
  .object({ approvalId: z.uuid(), userId: metadataSchema })
  .strict();
const opaqueValueSchema = z.string().regex(/^[A-Za-z0-9_-]{1,16384}$/u);
const walletGrantSchema = z
  .object({ walletGrant: z.string().regex(/^oswg1_[A-Za-z0-9_-]{43}$/u) })
  .strict();
const walletPakeLoginStartSchema = z
  .object({
    startLoginRequest: opaqueValueSchema,
  })
  .strict();
const walletPakeLoginFinishSchema = z
  .object({
    finishLoginRequest: opaqueValueSchema,
    flowId: z.uuid(),
  })
  .strict();
const walletPakeRegistrationStartSchema = z
  .object({
    authorization: z.enum(["initial", "change", "reset"]),
    registrationRequest: opaqueValueSchema,
    walletGrant: z.string().regex(/^oswg1_[A-Za-z0-9_-]{43}$/u).optional(),
  })
  .strict();
const walletPakeRegistrationFinishSchema = z
  .object({
    flowId: z.uuid(),
    registrationRecord: opaqueValueSchema,
  })
  .strict();
const credentialSourceSchema = z
  .object({
    agentId: metadataSchema.optional(),
    deviceId: metadataSchema.optional(),
    projectId: metadataSchema.optional(),
    type: z.enum(["user", "agent", "scan", "import", "migration"]),
  })
  .strict();
const migrationCredentialSchema = z
  .object({
    accessPolicy: credentialAccessPolicyRequiredSchema,
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    fields: publicCredentialFieldsSchema,
    id: metadataSchema,
    kind: credentialKindSchema,
    label: metadataSchema,
    purposes: metadataListSchema.min(1),
    secrets: metadataMapSchema.refine((value) => Object.keys(value).length > 0),
    source: credentialSourceSchema,
    tags: metadataListSchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const migrationBackfillSchema = z
  .object({
    credentials: z
      .array(migrationCredentialSchema)
      .max(500)
      .refine(
        (credentials) =>
          new Set(credentials.map((credential) => credential.id)).size ===
          credentials.length,
      ),
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    validationKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

function validServiceAuthorization(
  request: FastifyRequest,
  expectedDigest: Buffer,
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  if (!token || token.includes(" ")) return false;
  return timingSafeEqual(tokenDigest(token), expectedDigest);
}

function agentToken(request: FastifyRequest): string {
  const value = request.headers[agentTokenHeader];
  if (typeof value !== "string" || !value.startsWith("osva1_")) {
    throw new CloudVaultAccessDeniedError();
  }
  return value;
}

function requiredServiceToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 4_096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new Error("Vault service token is invalid.");
  }
  return value;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function cloudWalletPakeStore(service: CloudVaultService) {
  return {
    async get(userId: string): Promise<OpaquePasswordRecord | null> {
      return service.getWalletPakeRecord(userId);
    },
    async set(record: OpaquePasswordRecord): Promise<void> {
      await service.upsertWalletPakeRecord(record);
    },
  };
}
