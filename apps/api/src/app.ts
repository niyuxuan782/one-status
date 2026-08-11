import Fastify, { type FastifyInstance } from "fastify";
import {
  ONE_STATUS_VERSION,
  opaqueLoginFinishRequestSchema,
  opaqueLoginStartRequestSchema,
  opaqueMigrationFinishRequestSchema,
  opaqueMigrationStartRequestSchema,
  opaqueProofFinishRequestSchema,
  opaqueProofStartRequestSchema,
  opaqueRegistrationFinishRequestSchema,
  opaqueRegistrationStartRequestSchema,
  putStatusRequestSchema,
} from "@one-status/protocol";
import { z, ZodError } from "zod";
import {
  DeviceLoginBlockedError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  MutationIdConflictError,
  NewDeviceLoginDeniedError,
  OneStatusDatabase,
  VersionConflictError,
  type AuthenticatedSession,
} from "./database.js";
import {
  registerDashboardRoutes,
  type DashboardRuntime,
} from "./dashboard.js";
import { DeviceRelayHub } from "./device-relay.js";
import { ProviderRequestError } from "./oauth-providers.js";
import { OpaqueAuthService } from "./opaque-auth.js";
import {
  opaqueAuthorizationBrowserScript,
  opaqueBrowserBundle,
} from "./opaque-browser.js";
import { registerRemoteCloudServices } from "./remote-cloud.js";
import type {
  CloudVaultUserClient,
  RemoteCloudVaultGatewayFactory,
} from "./cloud-vault-client.js";
import {
  ToolApprovalError,
  ToolConnectionExpiredError,
  ToolPermissionDeniedError,
} from "./tool-gateway.js";

export interface CreateAppOptions {
  authRateLimit?: false | AuthRateLimitOptions;
  dashboard?: Omit<
    DashboardRuntime,
    | "authenticateAgent"
    | "authenticateDevice"
    | "issueAgentCredential"
    | "revokeAgentCredential"
  >;
  deviceRelay?: false | { path?: string };
  dbPath: string;
  logger?: boolean;
  opaqueServerSetup?: string | Promise<string>;
  remoteCloud?:
    | false
    | {
        issuer: string;
        oauthDbPath?: string;
        resource: string;
        vault?: RemoteCloudVaultGatewayFactory & Partial<CloudVaultUserClient>;
      };
  releaseId?: string;
  trustProxy?: boolean;
}

export interface AuthRateLimitOptions {
  maxAttemptsPerIdentity?: number;
  maxAttemptsPerIp?: number;
  windowMs?: number;
}

class AuthRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many authentication attempts. Try again later.");
  }
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
  });
  const database = new OneStatusDatabase(options.dbPath);
  const opaqueAuth = new OpaqueAuthService({
    database,
    serverSetup: options.opaqueServerSetup,
  });
  const authRateLimiter =
    options.authRateLimit === false
      ? undefined
      : new AuthRateLimiter(options.authRateLimit);
  const deviceRelay = options.deviceRelay || options.remoteCloud
    ? new DeviceRelayHub({
        authenticate(authorization) {
          const token = readBearerToken(authorization);
          const session = token ? database.authenticate(token) : null;
          return session
            ? { deviceId: session.deviceId, userId: session.userId }
            : undefined;
        },
        path:
          typeof options.deviceRelay === "object"
            ? options.deviceRelay.path
            : undefined,
      })
    : undefined;
  deviceRelay?.attach(app.server);
  const remoteCloud =
    options.remoteCloud && deviceRelay
      ? registerRemoteCloudServices(app, {
          database,
          deviceRelay,
          issuer: options.remoteCloud.issuer,
          oauthDbPath: options.remoteCloud.oauthDbPath ?? options.dbPath,
          opaqueAuth,
          resource: options.remoteCloud.resource,
          vault: options.remoteCloud.vault,
        })
      : undefined;

  app.addHook("onClose", async () => {
    await deviceRelay?.close();
    opaqueAuth.close();
    options.dashboard?.closeLocalState?.();
    options.dashboard?.permissionVault.close();
    database.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed.",
          details: error.issues,
        },
      });
    }
    if (error instanceof EmailAlreadyRegisteredError) {
      return reply.code(409).send({
        error: { code: "email_registered", message: error.message },
      });
    }
    if (error instanceof InvalidCredentialsError) {
      return reply.code(401).send({
        error: { code: "invalid_credentials", message: error.message },
      });
    }
    if (error instanceof DeviceLoginBlockedError) {
      return reply.code(403).send({
        error: { code: "device_blocked", message: error.message },
      });
    }
    if (error instanceof NewDeviceLoginDeniedError) {
      return reply.code(403).send({
        error: { code: "new_device_login_denied", message: error.message },
      });
    }
    if (error instanceof AuthRateLimitError) {
      reply.header("retry-after", String(error.retryAfterSeconds));
      return reply.code(429).send({
        error: { code: "rate_limited", message: error.message },
      });
    }
    if (error instanceof VersionConflictError) {
      return reply.code(409).send({
        error: {
          code: "version_conflict",
          message: error.message,
          currentVersion: error.currentVersion,
        },
      });
    }
    if (error instanceof MutationIdConflictError) {
      return reply.code(409).send({
        error: { code: "mutation_id_conflict", message: error.message },
      });
    }
    if (error instanceof ToolPermissionDeniedError) {
      return reply.code(403).send({
        error: { code: "tool_permission_denied", message: error.message },
      });
    }
    if (error instanceof ToolApprovalError) {
      return reply.code(409).send({
        error: { code: "tool_approval_required", message: error.message },
      });
    }
    if (error instanceof ToolConnectionExpiredError) {
      return reply.code(409).send({
        error: {
          code: "tool_connection_expired",
          message: error.message,
          recoverableFromSync: error.recoverableFromSync,
        },
      });
    }
    if (error instanceof ProviderRequestError) {
      return reply.code(error.authorizationInvalid ? 409 : 502).send({
        error: {
          code: error.authorizationInvalid
            ? "provider_authorization_invalid"
            : error.code,
          message: error.message,
        },
      });
    }
    if (error instanceof Error && cloudVaultErrorStatus(error.message)) {
      const status = cloudVaultErrorStatus(error.message)!;
      return reply.code(status).send({
        error: { code: error.message, message: "Cloud Vault request failed." },
      });
    }
    if (isSqliteBusy(error)) {
      reply.header("retry-after", "1");
      return reply.code(503).send({
        error: {
          code: "storage_busy",
          message: "Status storage is busy. Retry the request.",
        },
      });
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({
        error: {
          code: "invalid_request",
          message: "The API request could not be parsed.",
        },
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  if (options.dashboard) {
    registerDashboardRoutes(app, {
      ...options.dashboard,
      authenticateAgent: (authorization) => {
        const token = readBearerToken(authorization);
        return token
          ? (database.authenticateAgent(token) ?? undefined)
          : undefined;
      },
      authenticateDevice: (authorization) => {
        const token = readBearerToken(authorization);
        return token ? (database.authenticate(token) ?? undefined) : undefined;
      },
      issueAgentCredential: (session, agentId) =>
        database.issueAgentCredential(session, agentId),
      listAgentIds: (userId) => database.listAgentIds(userId),
      revokeAgentCredential: (userId, deviceId, credentialId) =>
        database.revokeAgentCredential(userId, deviceId, credentialId),
    });
  } else {
    app.get("/", async () => ({
      name: "One Status",
      version: ONE_STATUS_VERSION,
      tagline: "One user. One status. Every AI. Private by design.",
      health: "/health",
    }));
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "one-status-api",
    version: ONE_STATUS_VERSION,
    ...(remoteCloud ? { remoteMcp: "ready" } : {}),
    ...(options.remoteCloud && options.remoteCloud.vault
      ? { cloudVault: "configured" }
      : {}),
    ...(options.releaseId ? { release: options.releaseId } : {}),
  }));

  app.get("/v1/auth/opaque-client.js", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .type("text/javascript; charset=utf-8")
      .send(opaqueBrowserBundle()),
  );

  app.get("/v1/auth/opaque-authorize.js", async (_request, reply) =>
    reply
      .header("cache-control", "no-store")
      .type("text/javascript; charset=utf-8")
      .send(opaqueAuthorizationBrowserScript()),
  );

  const cloudVaultUser = completeCloudVaultUserClient(
    options.remoteCloud && options.remoteCloud.vault,
  );
  if (cloudVaultUser) {
    app.post(
      "/v1/vault/migrations/backfill",
      { bodyLimit: 8 * 1024 * 1024, logLevel: "silent" },
      async (request, reply) => {
        const session = authenticate(request.headers.authorization, database);
        if (!session) return unauthorized(reply);
        reply.headers(noStoreHeaders);
        const input = cloudVaultBackfillSchema.parse(request.body);
        return cloudVaultUser.backfillUserCredentials({
          ...input,
          userId: session.userId,
        });
      },
    );
    app.post("/v1/vault/credentials/list", async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      reply.headers(noStoreHeaders);
      const input = cloudVaultCredentialListSchema.parse(request.body ?? {});
      return cloudVaultUser.listUserCredentials(session.userId, input);
    });
    app.get("/v1/vault/approvals", async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      reply.headers(noStoreHeaders);
      const { limit } = cloudVaultApprovalListSchema.parse(request.query);
      return cloudVaultUser.listUserApprovals(session.userId, limit);
    });
    app.patch("/v1/vault/approvals/:approvalId", async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      reply.headers(noStoreHeaders);
      const { approvalId } = z.object({ approvalId: z.uuid() }).parse(request.params);
      const { decision } = cloudVaultApprovalDecisionSchema.parse(request.body);
      return cloudVaultUser.decideUserApproval({
        approvalId,
        decision,
        userId: session.userId,
      });
    });
    app.post(
      "/v1/vault/credentials/:credentialId/reveal",
      async (request, reply) => {
        const session = authenticate(request.headers.authorization, database);
        if (!session) return unauthorized(reply);
        authRateLimiter?.consume("vault-reveal", request.ip, session.userId);
        reply.headers(noStoreHeaders);
        const { credentialId } = z
          .object({ credentialId: z.uuid() })
          .parse(request.params);
        const { walletGrant } = cloudVaultRevealSchema.parse(request.body);
        return cloudVaultUser.revealUserCredential({
          credentialId,
          walletGrant,
          userId: session.userId,
        });
      },
    );
    app.post("/v1/vault/wallet-pake/login/start", async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      authRateLimiter?.consume("vault-pake", request.ip, session.userId);
      reply.headers(noStoreHeaders);
      const input = cloudVaultPakeLoginStartSchema.parse(request.body);
      return cloudVaultUser.startUserWalletPakeLogin({
        ...input,
        userId: session.userId,
      });
    });

    app.post("/v1/vault/wallet-pake/login/finish", async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      reply.headers(noStoreHeaders);
      const input = cloudVaultPakeLoginFinishSchema.parse(request.body);
      return cloudVaultUser.finishUserWalletPakeLogin({
        ...input,
        userId: session.userId,
      });
    });

    app.post(
      "/v1/vault/wallet-pake/register/start",
      { logLevel: "silent" },
      async (request, reply) => {
        const session = authenticate(request.headers.authorization, database);
        if (!session) return unauthorized(reply);
        authRateLimiter?.consume("vault-pake", request.ip, session.userId);
        reply.headers(noStoreHeaders);
        const input = cloudVaultPakeRegistrationStartSchema.parse(request.body);
        if (input.authorization === "reset") {
          const proof = input.accountProof
            ? opaqueAuth.consumeProof(input.accountProof, "wallet-reset")
            : null;
          if (proof?.userId !== session.userId) {
            return reply.code(403).send({
              error: {
                code: "account_pake_proof_invalid",
                message: "Account verification failed.",
              },
            });
          }
        }
        const { accountProof: _accountProof, ...registration } = input;
        return cloudVaultUser.startUserWalletPakeRegistration({
          ...registration,
          userId: session.userId,
        });
      },
    );

    app.put(
      "/v1/vault/wallet-pake/register/finish",
      { logLevel: "silent" },
      async (request, reply) => {
        const session = authenticate(request.headers.authorization, database);
        if (!session) return unauthorized(reply);
        reply.headers(noStoreHeaders);
        const input = cloudVaultPakeRegistrationFinishSchema.parse(request.body);
        return cloudVaultUser.finishUserWalletPakeRegistration({
          ...input,
          userId: session.userId,
        });
      },
    );
  }

  app.post(
    "/v1/auth/opaque/register/start",
    { logLevel: "silent" },
    async (request) => {
      const body = opaqueRegistrationStartRequestSchema.parse(request.body);
      authRateLimiter?.consume("register", request.ip, body.email);
      return opaqueAuth.startRegistration(body);
    },
  );

  app.post(
    "/v1/auth/opaque/register/finish",
    { logLevel: "silent" },
    async (request, reply) => {
      const body = opaqueRegistrationFinishRequestSchema.parse(request.body);
      const session = opaqueAuth.finishRegistration(body);
      return reply.code(201).send(session);
    },
  );

  app.post(
    "/v1/auth/opaque/login/start",
    { logLevel: "silent" },
    async (request) => {
      const body = opaqueLoginStartRequestSchema.parse(request.body);
      authRateLimiter?.consume("login", request.ip, body.email);
      return opaqueAuth.startLogin(body);
    },
  );

  app.post(
    "/v1/auth/opaque/login/finish",
    { logLevel: "silent" },
    async (request) => {
      const body = opaqueLoginFinishRequestSchema.parse(request.body);
      return opaqueAuth.finishLogin(body);
    },
  );

  app.post(
    "/v1/auth/opaque/proof/start",
    { logLevel: "silent" },
    async (request) => {
      const body = opaqueProofStartRequestSchema.parse(request.body);
      authRateLimiter?.consume("pake-proof", request.ip, body.email);
      return opaqueAuth.startProof(body);
    },
  );

  app.post(
    "/v1/auth/opaque/proof/finish",
    { logLevel: "silent" },
    async (request) => {
      const body = opaqueProofFinishRequestSchema.parse(request.body);
      return opaqueAuth.finishProof(body);
    },
  );

  app.post(
    "/v1/account/opaque/register/start",
    { logLevel: "silent" },
    async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      const body = opaqueMigrationStartRequestSchema.parse(request.body);
      authRateLimiter?.consume("pake-migrate", request.ip, session.userId);
      return opaqueAuth.startMigration({
        ...body,
        session,
      });
    },
  );

  app.put(
    "/v1/account/opaque/register/finish",
    { logLevel: "silent" },
    async (request, reply) => {
      const session = authenticate(request.headers.authorization, database);
      if (!session) return unauthorized(reply);
      const body = opaqueMigrationFinishRequestSchema.parse(request.body);
      return opaqueAuth.finishMigration({ ...body, session });
    },
  );

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token || !database.authenticate(token)) {
      return unauthorized(reply);
    }
    database.revokeSession(token);
    return { revoked: true };
  });

  app.get("/v1/account", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) {
      return unauthorized(reply);
    }
    return database.getAccount(session.userId);
  });

  app.delete("/v1/devices/:deviceId", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) {
      return unauthorized(reply);
    }
    const { deviceId } = z
      .object({ deviceId: z.uuid() })
      .parse(request.params);
    if (deviceId === session.deviceId) {
      return selfDeviceManagementForbidden(reply);
    }
    if (!database.revokeDevice(session.userId, deviceId)) {
      return reply.code(404).send({
        error: { code: "device_not_found", message: "Device was not found." },
      });
    }
    return { revoked: true, deviceId };
  });

  app.post("/v1/devices/:deviceId/revoke-sessions", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) return unauthorized(reply);
    const { deviceId } = z
      .object({ deviceId: z.uuid() })
      .parse(request.params);
    if (deviceId === session.deviceId) {
      return selfDeviceManagementForbidden(reply);
    }
    const revokedSessions = database.revokeDeviceSessions(
      session.userId,
      deviceId,
    );
    if (revokedSessions === undefined) return deviceNotFound(reply);
    return { deviceId, revokedSessions };
  });

  app.put("/v1/devices/:deviceId/block", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) return unauthorized(reply);
    const { deviceId } = z
      .object({ deviceId: z.uuid() })
      .parse(request.params);
    if (deviceId === session.deviceId) {
      return selfDeviceManagementForbidden(reply);
    }
    if (!database.blockDevice(session.userId, deviceId)) {
      return deviceNotFound(reply);
    }
    return { deviceId, blocked: true };
  });

  app.delete("/v1/devices/:deviceId/block", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) return unauthorized(reply);
    const { deviceId } = z
      .object({ deviceId: z.uuid() })
      .parse(request.params);
    if (deviceId === session.deviceId) {
      return selfDeviceManagementForbidden(reply);
    }
    if (!database.unblockDevice(session.userId, deviceId)) {
      return deviceNotFound(reply);
    }
    return { deviceId, blocked: false };
  });

  app.put("/v1/account/device-login-policy", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) return unauthorized(reply);
    const body = z
      .object({ denyNewDeviceLogins: z.boolean() })
      .strict()
      .parse(request.body);
    return database.setDeviceLoginPolicy(
      session.userId,
      body.denyNewDeviceLogins,
    );
  });

  app.post("/v1/devices/heartbeat", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) {
      return unauthorized(reply);
    }
    return database.heartbeat(session.userId, session.deviceId);
  });

  app.get("/v1/status", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) {
      return unauthorized(reply);
    }
    return database.getStatus(session.userId);
  });

  app.put("/v1/status", async (request, reply) => {
    const session = authenticate(request.headers.authorization, database);
    if (!session) {
      return unauthorized(reply);
    }
    const body = putStatusRequestSchema.parse(request.body);
    return database.putStatus(
      session.userId,
      body.mutationId,
      body.mutationDigest,
      body.baseVersion,
      body.envelope,
    );
  });

  return app;
}

class AuthRateLimiter {
  readonly #attempts = new Map<string, { count: number; resetAt: number }>();
  readonly #maxAttemptsPerIdentity: number;
  readonly #maxAttemptsPerIp: number;
  readonly #windowMs: number;

  constructor(options: AuthRateLimitOptions = {}) {
    this.#maxAttemptsPerIdentity = options.maxAttemptsPerIdentity ?? 10;
    this.#maxAttemptsPerIp = options.maxAttemptsPerIp ?? 100;
    this.#windowMs = options.windowMs ?? 15 * 60_000;
  }

  consume(action: string, ip: string, identity: string): void {
    const now = Date.now();
    this.#consume(`${action}:ip:${ip}`, this.#maxAttemptsPerIp, now);
    this.#consume(
      `${action}:identity:${identity.toLowerCase()}`,
      this.#maxAttemptsPerIdentity,
      now,
    );
    if (this.#attempts.size > 10_000) {
      for (const [key, entry] of this.#attempts) {
        if (entry.resetAt <= now) this.#attempts.delete(key);
      }
    }
  }

  #consume(key: string, limit: number, now: number): void {
    const existing = this.#attempts.get(key);
    const entry =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + this.#windowMs }
        : existing;
    if (entry.count >= limit) {
      throw new AuthRateLimitError(
        Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
      );
    }
    entry.count += 1;
    this.#attempts.set(key, entry);
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /database is locked|database is busy/i.test(error.message)
  );
}

function authenticate(
  authorization: string | undefined,
  database: OneStatusDatabase,
): AuthenticatedSession | null {
  const token = readBearerToken(authorization);
  return token ? database.authenticate(token) : null;
}

function readBearerToken(authorization: string | undefined): string | undefined {
  return authorization?.match(/^Bearer (\S+)$/)?.[1];
}

function unauthorized(reply: {
  code(statusCode: number): { send(body: unknown): unknown };
}): unknown {
  return reply.code(401).send({
    error: { code: "unauthorized", message: "A valid device session is required." },
  });
}

function deviceNotFound(reply: {
  code(statusCode: number): { send(body: unknown): unknown };
}): unknown {
  return reply.code(404).send({
    error: { code: "device_not_found", message: "Device was not found." },
  });
}

function selfDeviceManagementForbidden(reply: {
  code(statusCode: number): { send(body: unknown): unknown };
}): unknown {
  return reply.code(409).send({
    error: {
      code: "active_device_target",
      message: "Use logout to end the current device session.",
    },
  });
}

const noStoreHeaders = {
  "cache-control": "no-store, private, max-age=0",
  expires: "0",
  pragma: "no-cache",
};

const cloudVaultMetadataSchema = z.string().trim().min(1).max(1_000);
const cloudVaultCredentialListSchema = z
  .object({
    kinds: z.array(cloudVaultMetadataSchema).max(32).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    purposes: z.array(cloudVaultMetadataSchema).max(128).optional(),
    search: cloudVaultMetadataSchema.optional(),
    tags: z.array(cloudVaultMetadataSchema).max(128).optional(),
  })
  .strict();
const cloudVaultRevealSchema = z
  .object({ walletGrant: z.string().regex(/^oswg1_[A-Za-z0-9_-]{43}$/u) })
  .strict();
const cloudVaultApprovalListSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
  .strict();
const cloudVaultApprovalDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]) })
  .strict();
const cloudVaultPakeLoginStartSchema = z
  .object({
    startLoginRequest: z.string().regex(/^[A-Za-z0-9_-]{1,16384}$/u),
  })
  .strict();
const cloudVaultPakeLoginFinishSchema = z
  .object({
    finishLoginRequest: z.string().regex(/^[A-Za-z0-9_-]{1,16384}$/u),
    flowId: z.uuid(),
  })
  .strict();
const cloudVaultPakeRegistrationStartSchema = z
  .object({
    accountProof: z.string().regex(/^osp1_[A-Za-z0-9_-]{43}$/u).optional(),
    authorization: z.enum(["initial", "change", "reset"]),
    registrationRequest: z.string().regex(/^[A-Za-z0-9_-]{1,16384}$/u),
    walletGrant: z.string().regex(/^oswg1_[A-Za-z0-9_-]{43}$/u).optional(),
  })
  .strict();
const cloudVaultPakeRegistrationFinishSchema = z
  .object({
    flowId: z.uuid(),
    registrationRecord: z.string().regex(/^[A-Za-z0-9_-]{1,16384}$/u),
  })
  .strict();
const cloudVaultBackfillSchema = z
  .object({
    credentials: z.array(z.record(z.string(), z.unknown())).max(500),
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    validationKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

function completeCloudVaultUserClient(
  value:
    | (RemoteCloudVaultGatewayFactory & Partial<CloudVaultUserClient>)
    | false
    | undefined,
): CloudVaultUserClient | undefined {
  if (
    !value ||
    typeof value.backfillUserCredentials !== "function" ||
    typeof value.decideUserApproval !== "function" ||
    typeof value.listUserApprovals !== "function" ||
    typeof value.listUserCredentials !== "function" ||
    typeof value.revealUserCredential !== "function" ||
    typeof value.startUserWalletPakeLogin !== "function" ||
    typeof value.finishUserWalletPakeLogin !== "function" ||
    typeof value.startUserWalletPakeRegistration !== "function" ||
    typeof value.finishUserWalletPakeRegistration !== "function"
  ) {
    return undefined;
  }
  return value as RemoteCloudVaultGatewayFactory & CloudVaultUserClient;
}

function cloudVaultErrorStatus(message: string): 400 | 403 | 409 | 502 | undefined {
  if (message === "invalid_request") return 400;
  if (
    message === "credential_access_denied" ||
    message === "wallet_pake_grant_invalid" ||
    message === "wallet_pake_invalid"
  ) {
    return 403;
  }
  if (
    message === "credential_approval_required" ||
    message === "approval_unavailable" ||
    message === "wallet_pake_already_initialized" ||
    message === "wallet_pake_uninitialized"
  ) {
    return 409;
  }
  if (message === "credential_revision_conflict") return 409;
  if (message === "migration_verification_failed") return 409;
  if (message === "migration_conflict") return 409;
  if (
    message === "service_auth_required" ||
    message === "vault_operation_failed" ||
    message === "wallet_pake_capacity_reached" ||
    message === "vault_service_unavailable" ||
    message === "vault_session_unavailable"
  ) {
    return 502;
  }
  return undefined;
}
