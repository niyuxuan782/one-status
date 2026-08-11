import { randomUUID } from "node:crypto";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createRemoteMcpServer,
  effectiveRemoteMcpScopes,
  remoteMcpDefaultScopes,
  remoteMcpSupportedScopes,
  type RemoteMcpAgentSession,
  type RemoteMcpGateway,
  type RemoteMcpStatusReader,
} from "@one-status/mcp/remote";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 5;

export interface FastifyRemoteMcpOptions {
  authorizationServers: string[];
  endpoint?: string;
  idleTimeoutMs?: number;
  maxSessions?: number;
  maxSessionsPerPrincipal?: number;
  resolveAgentSession(authInfo: AuthInfo):
    | { agentId: string; subject: string }
    | Promise<{ agentId: string; subject: string }>;
  resolveGateway?(
    session: RemoteMcpAgentSession,
  ): RemoteMcpGateway | Promise<RemoteMcpGateway>;
  resolveStatusReader(
    session: RemoteMcpAgentSession,
  ): RemoteMcpStatusReader | Promise<RemoteMcpStatusReader>;
  resource: string;
  verifier: OAuthTokenVerifier;
}

export interface FastifyRemoteMcpRoutes {
  close(): Promise<void>;
  endpoint: string;
  resourceMetadataUrl: string;
  sessionCount(): number;
}

interface SessionEntry {
  grantedScopes: string[];
  lastSeenAt: number;
  mcp: McpServer;
  principalId: string;
  transport: StreamableHTTPServerTransport;
}

interface AuthorizedRequest {
  authInfo: AuthInfo;
  ok: true;
  principalId: string;
  scopes: string[];
  session: RemoteMcpAgentSession;
}

interface AuthorizationError {
  error: "insufficient_scope" | "invalid_token";
  ok: false;
  status: 401 | 403;
}

interface NormalizedOptions {
  endpoint: string;
  idleTimeoutMs: number;
  maxSessions: number;
  maxSessionsPerPrincipal: number;
  metadata: {
    authorization_servers: string[];
    bearer_methods_supported: ["header"];
    resource: string;
    resource_name: string;
    scopes_supported: string[];
  };
  resolveAgentSession: FastifyRemoteMcpOptions["resolveAgentSession"];
  resolveGateway?: FastifyRemoteMcpOptions["resolveGateway"];
  resolveStatusReader: FastifyRemoteMcpOptions["resolveStatusReader"];
  resource: URL;
  resourceMetadataPath: string;
  resourceMetadataUrl: string;
  verifier: OAuthTokenVerifier;
}

export function registerRemoteMcpRoutes(
  app: FastifyInstance,
  optionsValue: FastifyRemoteMcpOptions,
): FastifyRemoteMcpRoutes {
  const options = normalizeOptions(optionsValue);
  const sessions = new Map<string, SessionEntry>();
  let pendingSessions = 0;
  const pendingSessionsByPrincipal = new Map<string, number>();
  let closed = false;

  const closeSession = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    await entry.transport.close().catch(() => undefined);
    await entry.mcp.close().catch(() => undefined);
  };

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - options.idleTimeoutMs;
    for (const [sessionId, entry] of sessions) {
      if (entry.lastSeenAt < cutoff) void closeSession(sessionId);
    }
  }, Math.min(60_000, Math.max(1_000, Math.floor(options.idleTimeoutMs / 2))));
  cleanup.unref();

  const controller: FastifyRemoteMcpRoutes = {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(cleanup);
      await Promise.all([...sessions.keys()].map(closeSession));
    },
    endpoint: options.endpoint,
    resourceMetadataUrl: options.resourceMetadataUrl,
    sessionCount: () => sessions.size,
  };

  app.addHook("onClose", () => controller.close());

  const metadataPaths = new Set([
    options.resourceMetadataPath,
    "/.well-known/oauth-protected-resource",
  ]);
  for (const path of metadataPaths) {
    app.route({
      method: ["GET", "OPTIONS"],
      url: path,
      handler: async (_request, reply) => {
        setCors(reply.raw);
        if (_request.method === "OPTIONS") {
          return reply.code(204).send();
        }
        return reply.send(options.metadata);
      },
    });
  }

  app.route({
    logLevel: "silent",
    method: ["GET", "POST", "DELETE", "OPTIONS"],
    url: options.endpoint,
    handler: async (request, reply) => {
      setCors(reply.raw);
      if (request.method === "OPTIONS") return reply.code(204).send();

      const authorization = await authorizeRequest(request, options);
      if (!authorization.ok) {
        return sendAuthorizationError(reply, authorization, options);
      }

      const sessionId = header(request, "mcp-session-id");
      let entry = sessionId ? sessions.get(sessionId) : undefined;
      if (entry && entry.principalId !== authorization.principalId) {
        return reply.code(404).send({ error: "unknown_session" });
      }
      if (
        entry &&
        !entry.grantedScopes.every((scope) =>
          authorization.scopes.includes(scope),
        )
      ) {
        return sendAuthorizationError(
          reply,
          { error: "insufficient_scope", ok: false, status: 403 },
          options,
          entry.grantedScopes,
        );
      }

      const body = request.method === "POST" ? request.body : undefined;
      let reservedSession = false;
      let createdEntry = false;
      if (!entry && !sessionId && body && isInitializeRequest(body)) {
        const principalSessionCount = [...sessions.values()].filter(
          (session) => session.principalId === authorization.principalId,
        ).length;
        const principalPending =
          pendingSessionsByPrincipal.get(authorization.principalId) ?? 0;
        if (
          sessions.size + pendingSessions >= options.maxSessions ||
          principalSessionCount + principalPending >=
            options.maxSessionsPerPrincipal
        ) {
          return reply.code(503).send({ error: "session_limit_reached" });
        }
        pendingSessions += 1;
        pendingSessionsByPrincipal.set(
          authorization.principalId,
          principalPending + 1,
        );
        reservedSession = true;
        try {
          entry = await createSession(authorization, options, sessions);
          createdEntry = true;
        } catch {
          releasePendingSession(
            pendingSessionsByPrincipal,
            authorization.principalId,
          );
          pendingSessions -= 1;
          return reply.code(503).send({ error: "status_reader_unavailable" });
        }
      }

      if (!entry) {
        return reply.code(sessionId ? 404 : 400).send({
          error: sessionId ? "unknown_session" : "initialize_required",
        });
      }

      entry.lastSeenAt = Date.now();
      (request.raw as typeof request.raw & { auth?: AuthInfo }).auth =
        authorization.authInfo;
      reply.hijack();
      try {
        await entry.transport.handleRequest(request.raw, reply.raw, body);
      } catch {
        if (!reply.raw.headersSent) {
          writeRawJson(reply.raw, 500, { error: "mcp_request_failed" });
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      } finally {
        if (reservedSession) {
          pendingSessions -= 1;
          releasePendingSession(
            pendingSessionsByPrincipal,
            authorization.principalId,
          );
        }
        if (createdEntry && !entry.transport.sessionId) {
          await entry.transport.close().catch(() => undefined);
          await entry.mcp.close().catch(() => undefined);
        }
      }
      return reply;
    },
  });

  return controller;
}

async function createSession(
  authorization: AuthorizedRequest,
  options: NormalizedOptions,
  sessions: Map<string, SessionEntry>,
): Promise<SessionEntry> {
  const [statusReader, gateway] = await Promise.all([
    resolveStatusReader(options, authorization.session),
    resolveGateway(options, authorization.session),
  ]);
  const mcp = createRemoteMcpServer(
    statusReader,
    authorization.session,
    gateway,
  );
  let entry: SessionEntry;
  const transport = new StreamableHTTPServerTransport({
    onsessionclosed: (sessionId) => {
      const closed = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (closed) void closed.mcp.close().catch(() => undefined);
    },
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, entry);
    },
    sessionIdGenerator: randomUUID,
  });
  entry = {
    grantedScopes: authorization.scopes,
    lastSeenAt: Date.now(),
    mcp,
    principalId: authorization.principalId,
    transport,
  };
  try {
    await mcp.connect(transport);
    return entry;
  } catch {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
    throw new Error("Remote MCP session could not be created.");
  }
}

async function authorizeRequest(
  request: FastifyRequest,
  options: NormalizedOptions,
): Promise<AuthorizedRequest | AuthorizationError> {
  const token = bearerToken(request.headers.authorization);
  if (!token) return { error: "invalid_token", ok: false, status: 401 };
  try {
    const authInfo = await options.verifier.verifyAccessToken(token);
    if (!validAuthInfo(authInfo, options.resource)) {
      return { error: "invalid_token", ok: false, status: 401 };
    }
    const clientId = requiredIdentity(authInfo.clientId);
    const identity = await options.resolveAgentSession(authInfo);
    const agentId = requiredIdentity(identity.agentId);
    const subject = requiredIdentity(identity.subject);
    const scopes = effectiveRemoteMcpScopes(authInfo.scopes);
    if (scopes.length === 0) {
      return { error: "insufficient_scope", ok: false, status: 403 };
    }
    return {
      authInfo: { ...authInfo, token },
      ok: true,
      principalId: JSON.stringify([subject, clientId, agentId]),
      scopes,
      session: { agentId, clientId, scopes, subject },
    };
  } catch {
    return { error: "invalid_token", ok: false, status: 401 };
  }
}

async function resolveStatusReader(
  options: NormalizedOptions,
  session: RemoteMcpAgentSession,
): Promise<RemoteMcpStatusReader> {
  try {
    const reader = await options.resolveStatusReader(session);
    if (!reader || typeof reader.read !== "function") throw new Error();
    return {
      async read(request) {
        try {
          return await reader.read(request);
        } catch (error) {
          const code = safeRemoteOperationCode(error);
          if (code) throw new Error(code);
          throw new Error("Remote status is unavailable.");
        }
      },
    };
  } catch {
    throw new Error("Remote status reader is unavailable.");
  }
}

function safeRemoteOperationCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const allowed = new Set([
    "device_capability_unavailable",
    "device_offline",
    "provider_authorization_invalid",
    "relay_disconnected",
    "relay_timeout",
    "tool_approval_required",
    "tool_connection_expired",
    "tool_permission_denied",
  ]);
  return allowed.has(error.message) ? error.message : undefined;
}

async function resolveGateway(
  options: NormalizedOptions,
  session: RemoteMcpAgentSession,
): Promise<RemoteMcpGateway | undefined> {
  if (!options.resolveGateway) return undefined;
  try {
    const gateway = await options.resolveGateway(session);
    if (
      !gateway ||
      typeof gateway.credential !== "function" ||
      typeof gateway.listDevices !== "function" ||
      typeof gateway.listTools !== "function" ||
      typeof gateway.requestToolApproval !== "function" ||
      typeof gateway.executeTool !== "function"
    ) {
      throw new Error();
    }
    return gateway;
  } catch {
    throw new Error("Remote MCP Gateway is unavailable.");
  }
}

function normalizeOptions(value: FastifyRemoteMcpOptions): NormalizedOptions {
  const endpoint = normalizeEndpoint(value.endpoint ?? "/mcp");
  const resource = secureUrl(value.resource, "Remote MCP resource");
  if (resource.username || resource.password || resource.search || resource.hash) {
    throw new Error(
      "Remote MCP resource URL cannot contain credentials, query, or hash.",
    );
  }
  if (value.authorizationServers.length === 0) {
    throw new Error("Remote MCP requires an authorization server.");
  }
  const authorizationServers = value.authorizationServers.map((server) => {
    const url = secureUrl(server, "Remote MCP authorization server");
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        "Remote MCP authorization server cannot contain credentials, query, or hash.",
      );
    }
    return url.toString().replace(/\/$/u, "");
  });
  const resourceMetadataUrl = protectedResourceMetadataUrl(resource);
  const maxSessions = value.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxSessionsPerPrincipal =
    value.maxSessionsPerPrincipal ?? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL;
  const idleTimeoutMs = value.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
    throw new Error("Remote MCP maxSessions must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(maxSessionsPerPrincipal) ||
    maxSessionsPerPrincipal <= 0 ||
    maxSessionsPerPrincipal > maxSessions
  ) {
    throw new Error(
      "Remote MCP maxSessionsPerPrincipal must be a positive integer no larger than maxSessions.",
    );
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error("Remote MCP idleTimeoutMs must be a positive integer.");
  }
  return {
    endpoint,
    idleTimeoutMs,
    maxSessions,
    maxSessionsPerPrincipal,
    metadata: {
      authorization_servers: authorizationServers,
      bearer_methods_supported: ["header"],
      resource: resource.toString(),
      resource_name: "One Status Remote MCP",
      scopes_supported: [...remoteMcpSupportedScopes],
    },
    resolveAgentSession: value.resolveAgentSession,
    resolveGateway: value.resolveGateway,
    resolveStatusReader: value.resolveStatusReader,
    resource,
    resourceMetadataPath: new URL(resourceMetadataUrl).pathname,
    resourceMetadataUrl,
    verifier: value.verifier,
  };
}

function releasePendingSession(
  pending: Map<string, number>,
  principalId: string,
): void {
  const count = pending.get(principalId) ?? 0;
  if (count <= 1) pending.delete(principalId);
  else pending.set(principalId, count - 1);
}

function sendAuthorizationError(
  reply: FastifyReply,
  error: AuthorizationError,
  options: NormalizedOptions,
  scopes: readonly string[] = remoteMcpDefaultScopes,
) {
  reply.header(
    "www-authenticate",
    [
      'Bearer realm="one-status-remote-mcp"',
      `error="${error.error}"`,
      `resource_metadata="${options.resourceMetadataUrl}"`,
      `scope="${scopes.join(" ")}"`,
    ].join(", "),
  );
  return reply.code(error.status).send({ error: error.error });
}

function setCors(response: FastifyReply["raw"]): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader(
    "access-control-allow-headers",
    "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
  );
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "access-control-expose-headers",
    "MCP-Session-Id, WWW-Authenticate",
  );
}

function validAuthInfo(authInfo: AuthInfo, resource: URL): boolean {
  return Boolean(
    authInfo &&
      typeof authInfo.clientId === "string" &&
      authInfo.clientId.length > 0 &&
      Array.isArray(authInfo.scopes) &&
      typeof authInfo.expiresAt === "number" &&
      Number.isFinite(authInfo.expiresAt) &&
      authInfo.expiresAt > Date.now() / 1_000 &&
      authInfo.resource &&
      normalizedResource(authInfo.resource) === normalizedResource(resource),
  );
}

function requiredIdentity(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Remote MCP Agent identity is invalid.");
  }
  return value;
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^Bearer ([^\s\u0000-\u001f\u007f]+)$/iu.exec(value)?.[1];
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizedResource(resource: URL): string {
  const normalized = new URL(resource);
  normalized.hash = "";
  return normalized.toString();
}

function protectedResourceMetadataUrl(resource: URL): string {
  const path = resource.pathname === "/"
    ? ""
    : resource.pathname.replace(/\/$/u, "");
  return new URL(
    `/.well-known/oauth-protected-resource${path}`,
    resource.origin,
  ).toString();
}

function normalizeEndpoint(value: string): string {
  if (!value.startsWith("/") || value.includes("?")) {
    throw new Error("Remote MCP endpoint must be an absolute path.");
  }
  return value.length > 1 ? value.replace(/\/$/u, "") : value;
}

function secureUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error(`${label} requires HTTPS outside loopback.`);
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return ["127.0.0.1", "[::1]", "localhost"].includes(normalized) ||
    normalized.endsWith(".localhost");
}

function writeRawJson(
  response: FastifyReply["raw"],
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
