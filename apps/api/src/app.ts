import Fastify, { type FastifyInstance } from "fastify";
import {
  authRequestSchema,
  putStatusRequestSchema,
  registerRequestSchema,
} from "@one-status/protocol";
import { z, ZodError } from "zod";
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  MutationIdConflictError,
  OneStatusDatabase,
  VersionConflictError,
  type AuthenticatedSession,
} from "./database.js";
import {
  registerDashboardRoutes,
  type DashboardRuntime,
} from "./dashboard.js";

export interface CreateAppOptions {
  authRateLimit?: false | AuthRateLimitOptions;
  dashboard?: Omit<DashboardRuntime, "authenticateDevice">;
  dbPath: string;
  logger?: boolean;
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
  const authRateLimiter =
    options.authRateLimit === false
      ? undefined
      : new AuthRateLimiter(options.authRateLimit);

  app.addHook("onClose", async () => {
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
      authenticateDevice: (authorization) => {
        const token = readBearerToken(authorization);
        return token ? (database.authenticate(token) ?? undefined) : undefined;
      },
    });
  } else {
    app.get("/", async () => ({
      name: "One Status",
      version: "0.1.0",
      tagline: "One user. One status. Every AI. Private by design.",
      health: "/health",
    }));
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "one-status-api",
    ...(options.releaseId ? { release: options.releaseId } : {}),
  }));

  app.post("/v1/auth/register", async (request, reply) => {
    const body = registerRequestSchema.parse(request.body);
    authRateLimiter?.consume("register", request.ip, body.email);
    const session = await database.register(
      body.email,
      body.password,
      body.deviceName,
      body.initialEnvelope,
      body.installationId,
    );
    return reply.code(201).send(session);
  });

  app.post("/v1/auth/login", async (request) => {
    const body = authRequestSchema.parse(request.body);
    authRateLimiter?.consume("login", request.ip, body.email);
    return database.login(
      body.email,
      body.password,
      body.deviceName,
      body.installationId,
    );
  });

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
    if (!database.revokeDevice(session.userId, deviceId)) {
      return reply.code(404).send({
        error: { code: "device_not_found", message: "Device was not found." },
      });
    }
    return { revoked: true, deviceId };
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
      `${action}:identity:${ip}:${identity.toLowerCase()}`,
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
