import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ONE_STATUS_VERSION } from "@one-status/protocol";
import type { McpRuntimeConfig } from "./config.js";
import { loadMcpRuntimeConfig } from "./config.js";
import { createMcpServer, type Vault } from "./server.js";
import {
  createRemoteMcpServer,
  hasRemoteScope,
  remoteMcpScopes,
  type RemoteMcpAgentSession,
  type RemoteMcpStatusReader,
} from "./remote-server.js";
import {
  createReloadingRuntimeToolGateway,
  createRuntimeToolGateway,
  type RuntimeToolGateway,
} from "./tool-gateway.js";
import {
  createReloadingRuntimeVault,
  createRuntimeVault,
} from "./vault.js";

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 5;
const HTTP_REMOTE_SUPPORTED_SCOPES = [
  remoteMcpScopes.all,
  remoteMcpScopes.profile,
  remoteMcpScopes.context,
  remoteMcpScopes.memory,
] as const;

interface SessionEntry {
  grantedScopes: string[];
  lastSeenAt: number;
  mcp: McpServer;
  principalId: string;
  transport: StreamableHTTPServerTransport;
}

export interface RemoteMcpOAuthOptions {
  /** RFC 9728 authorization server identifiers advertised to MCP clients. */
  authorizationServers: string[];
  /**
   * Maps verified token claims to one stable One Status Agent session. The
   * resulting subject is passed to resolveStatusReader.
   */
  resolveAgentSession(authInfo: AuthInfo):
    | { agentId: string; subject: string }
    | Promise<{ agentId: string; subject: string }>;
  /** Resolves only the authenticated subject's read-only Status data source. */
  resolveStatusReader(
    session: RemoteMcpAgentSession,
  ): RemoteMcpStatusReader | Promise<RemoteMcpStatusReader>;
  /** RFC 8707 resource identifier; defaults to publicUrl. */
  resource?: string;
  /** Validates signature, audience, revocation, expiry, client, and scopes. */
  verifier: OAuthTokenVerifier;
}

export interface HttpMcpServerOptions {
  bearerToken?: string;
  bodyLimit?: number;
  endpoint?: string;
  host?: string;
  idleTimeoutMs?: number;
  maxSessions?: number;
  maxSessionsPerPrincipal?: number;
  oauth?: RemoteMcpOAuthOptions;
  port?: number;
  publicUrl?: string;
  upstreamToken?: string;
}

export interface StartedHttpMcpServer {
  close(): Promise<void>;
  port: number;
  sessionCount(): number;
  url: string;
}

export async function startHttpMcp(
  config?: McpRuntimeConfig,
  options: HttpMcpServerOptions = {},
): Promise<StartedHttpMcpServer> {
  const loadConfig = config
    ? async () => config
    : async () => loadMcpRuntimeConfig();
  const resolvedConfig = await loadConfig();
  const vault = config
    ? await createRuntimeVault(resolvedConfig)
    : createReloadingRuntimeVault(loadConfig);
  if (!config) await vault.read();
  return startHttpMcpServer(
    vault,
    resolvedConfig.agentId,
    {
      ...options,
      upstreamToken: resolvedConfig.token,
    },
    config
      ? createRuntimeToolGateway(resolvedConfig)
      : createReloadingRuntimeToolGateway(loadConfig),
  );
}

export async function startHttpMcpServer(
  vault: Vault,
  agentId: string,
  options: HttpMcpServerOptions = {},
  toolGateway?: RuntimeToolGateway,
): Promise<StartedHttpMcpServer> {
  const host = options.host ?? "127.0.0.1";
  const endpoint = normalizeEndpoint(options.endpoint ?? "/mcp");
  const bearerToken = options.bearerToken;
  const oauth = normalizeRemoteOAuth(options.oauth, options.publicUrl);
  if (bearerToken && oauth) {
    throw new Error("Remote MCP OAuth and a static bearer cannot be enabled together.");
  }
  validateBearerToken(bearerToken, options.upstreamToken);
  if (!isLoopbackHost(host) && !bearerToken && !oauth) {
    throw new Error(
      "Remote MCP OAuth or ONE_STATUS_MCP_BEARER_TOKEN is required when HTTP MCP binds beyond loopback.",
    );
  }
  const sessions = new Map<string, SessionEntry>();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxSessionsPerPrincipal =
    options.maxSessionsPerPrincipal ?? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL;
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
    throw new Error("HTTP MCP maxSessions must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(maxSessionsPerPrincipal) ||
    maxSessionsPerPrincipal <= 0 ||
    maxSessionsPerPrincipal > maxSessions
  ) {
    throw new Error(
      "HTTP MCP maxSessionsPerPrincipal must be a positive integer no larger than maxSessions.",
    );
  }
  let pendingSessions = 0;
  const pendingSessionsByPrincipal = new Map<string, number>();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;

  const closeSession = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    await entry.transport.close().catch(() => undefined);
    await entry.mcp.close().catch(() => undefined);
  };

  const nodeServer = createNodeServer(async (request, response) => {
    try {
      if (!bearerToken && !oauth && !isTrustedLoopbackRequest(request)) {
        sendJson(response, 403, { error: "forbidden_host" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://one-status.local");
      if (oauth && isProtectedResourceMetadataPath(url.pathname, oauth)) {
        setRemoteCorsHeaders(response);
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("allow", "GET, OPTIONS");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        sendJson(response, 200, oauth.metadata);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          service: "one-status-mcp",
          sessions: sessions.size,
          status: "ok",
          transport: "streamable-http",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        const authorization = await authorizeRequest(
          request,
          agentId,
          bearerToken,
          oauth,
        );
        if (!authorization.ok) {
          sendAuthorizationError(response, authorization, oauth);
          return;
        }
        try {
          if (authorization.remoteSession) {
            const statusReader = await resolveRemoteStatusReader(
              oauth,
              authorization.remoteSession,
            );
            await statusReader.read({ view: "profile" });
          } else {
            await vault.read();
          }
          sendJson(response, 200, {
            service: "one-status-mcp",
            status: "ready",
          });
        } catch {
          sendJson(response, 503, {
            service: "one-status-mcp",
            status: "upstream_unavailable",
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        sendJson(response, 200, {
          ...(oauth
            ? { resourceMetadata: oauth.resourceMetadataUrl }
            : {}),
          endpoint,
          name: "One Status MCP",
          transport: "streamable-http",
          version: ONE_STATUS_VERSION,
        });
        return;
      }
      if (url.pathname !== endpoint) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (oauth) setRemoteCorsHeaders(response);
      if (request.method === "OPTIONS" && oauth) {
        response.writeHead(204);
        response.end();
        return;
      }
      const authorization = await authorizeRequest(
        request,
        agentId,
        bearerToken,
        oauth,
      );
      if (!authorization.ok) {
        sendAuthorizationError(response, authorization, oauth);
        return;
      }

      const sessionId = readHeader(request, "mcp-session-id");
      let entry = sessionId ? sessions.get(sessionId) : undefined;
      if (entry && entry.principalId !== authorization.principalId) {
        sendJson(response, 404, { error: "unknown_session" });
        return;
      }
      if (
        entry &&
        !entry.grantedScopes.every((scope) =>
          hasRemoteScope(authorization.scopes, scope),
        )
      ) {
        sendAuthorizationError(
          response,
          { ok: false, status: 403, error: "insufficient_scope" },
          oauth,
          entry.grantedScopes,
        );
        return;
      }
      let body: unknown;
      if (request.method === "POST") {
        body = await readJsonBody(request, bodyLimit);
      }

      if (!entry && !sessionId && body && isInitializeRequest(body)) {
        const principalSessions = [...sessions.values()].filter(
          (session) => session.principalId === authorization.principalId,
        ).length;
        const principalPending =
          pendingSessionsByPrincipal.get(authorization.principalId) ?? 0;
        if (
          sessions.size + pendingSessions >= maxSessions ||
          principalSessions + principalPending >= maxSessionsPerPrincipal
        ) {
          sendJson(response, 503, { error: "session_limit_reached" });
          return;
        }
        pendingSessions += 1;
        pendingSessionsByPrincipal.set(
          authorization.principalId,
          principalPending + 1,
        );
        try {
          entry = await createSession(
            vault,
            agentId,
            sessions,
            authorization,
            oauth,
            toolGateway,
          );
        } finally {
          pendingSessions -= 1;
          releasePendingSession(
            pendingSessionsByPrincipal,
            authorization.principalId,
          );
        }
      }

      if (!entry) {
        sendJson(response, sessionId ? 404 : 400, {
          error: sessionId ? "unknown_session" : "initialize_required",
        });
        return;
      }

      entry.lastSeenAt = Date.now();
      if (authorization.authInfo) {
        (request as IncomingMessage & { auth?: AuthInfo }).auth =
          authorization.authInfo;
      }
      await entry.transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        if (error instanceof RemoteStatusReaderUnavailableError) {
          sendJson(response, 503, { error: "status_reader_unavailable" });
        } else {
          const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
          sendJson(response, status, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        response.end();
      }
    }
  });

  await listen(nodeServer, options.port ?? 3000, host);
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [sessionId, entry] of sessions) {
      if (entry.lastSeenAt < cutoff) void closeSession(sessionId);
    }
  }, Math.min(60_000, Math.max(1_000, Math.floor(idleTimeoutMs / 2))));
  cleanup.unref();

  const port = (nodeServer.address() as AddressInfo).port;
  const displayHost = isLoopbackHost(host) ? host : "127.0.0.1";
  const url =
    options.publicUrl ?? `http://${formatHost(displayHost)}:${port}${endpoint}`;

  return {
    async close() {
      clearInterval(cleanup);
      await Promise.all([...sessions.keys()].map(closeSession));
      await closeNodeServer(nodeServer);
    },
    port,
    sessionCount: () => sessions.size,
    url,
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

async function createSession(
  vault: Vault,
  agentId: string,
  sessions: Map<string, SessionEntry>,
  authorization: AuthorizedRequest,
  oauth: NormalizedRemoteOAuth | undefined,
  toolGateway?: RuntimeToolGateway,
): Promise<SessionEntry> {
  const mcp = authorization.remoteSession
    ? createRemoteMcpServer(
        await resolveRemoteStatusReader(oauth, authorization.remoteSession),
        authorization.remoteSession,
      )
    : createMcpServer(vault, agentId, toolGateway);
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
    grantedScopes: authorization.remoteSession?.scopes ?? [],
    lastSeenAt: Date.now(),
    mcp,
    principalId: authorization.principalId,
    transport,
  };
  await mcp.connect(transport);
  return entry;
}

interface AuthorizedRequest {
  authInfo?: AuthInfo;
  ok: true;
  principalId: string;
  remoteSession?: RemoteMcpAgentSession;
  scopes: string[];
}

interface AuthorizationError {
  error: "insufficient_scope" | "invalid_token" | "unauthorized";
  ok: false;
  status: 401 | 403;
}

interface NormalizedRemoteOAuth {
  authorizationServers: string[];
  metadata: {
    authorization_servers: string[];
    bearer_methods_supported: ["header"];
    resource: string;
    resource_name: string;
    scopes_supported: string[];
  };
  resolveAgentSession: RemoteMcpOAuthOptions["resolveAgentSession"];
  resolveStatusReader: RemoteMcpOAuthOptions["resolveStatusReader"];
  resource: URL;
  resourceMetadataUrl: string;
  supportedScopes: string[];
  verifier: OAuthTokenVerifier;
}

async function authorizeRequest(
  request: IncomingMessage,
  localAgentId: string,
  bearerToken: string | undefined,
  oauth: NormalizedRemoteOAuth | undefined,
): Promise<AuthorizedRequest | AuthorizationError> {
  if (!oauth) {
    if (!isAuthorized(request, bearerToken)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    return {
      ok: true,
      principalId: `local:${localAgentId}`,
      scopes: [],
    };
  }

  const token = readBearerToken(request);
  if (!token) return { ok: false, status: 401, error: "invalid_token" };
  try {
    const authInfo = await oauth.verifier.verifyAccessToken(token);
    if (!validAuthInfo(authInfo, oauth.resource)) {
      return { ok: false, status: 401, error: "invalid_token" };
    }
    const clientId = requiredIdentity(authInfo.clientId);
    const identity = await oauth.resolveAgentSession(authInfo);
    const agentId = requiredIdentity(identity.agentId);
    const subject = requiredIdentity(identity.subject);
    const scopes = [...new Set(authInfo.scopes)].filter((scope) =>
      oauth.supportedScopes.includes(scope),
    );
    if (scopes.length === 0) {
      return { ok: false, status: 403, error: "insufficient_scope" };
    }
    return {
      authInfo: { ...authInfo, token },
      ok: true,
      principalId: remotePrincipalId(subject, clientId, agentId),
      remoteSession: {
        agentId,
        clientId,
        scopes,
        subject,
      },
      scopes,
    };
  } catch {
    return { ok: false, status: 401, error: "invalid_token" };
  }
}

function normalizeRemoteOAuth(
  oauth: RemoteMcpOAuthOptions | undefined,
  publicUrl: string | undefined,
): NormalizedRemoteOAuth | undefined {
  if (!oauth) return undefined;
  const resource = secureRemoteUrl(oauth.resource ?? publicUrl, "OAuth resource");
  if (
    oauth.resource &&
    publicUrl &&
    normalizedResource(new URL(oauth.resource)) !==
      normalizedResource(new URL(publicUrl))
  ) {
    throw new Error("OAuth resource and public MCP URL must match.");
  }
  if (resource.username || resource.password || resource.search || resource.hash) {
    throw new Error("OAuth resource URL cannot contain credentials, query, or hash.");
  }
  if (oauth.authorizationServers.length === 0) {
    throw new Error("Remote MCP OAuth requires an authorization server.");
  }
  const authorizationServers = oauth.authorizationServers.map((value) => {
    const url = secureRemoteUrl(value, "OAuth authorization server");
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        "OAuth authorization server URL cannot contain credentials, query, or hash.",
      );
    }
    return url.toString().replace(/\/$/, "");
  });
  const resourceMetadataUrl = protectedResourceMetadataUrl(resource);
  return {
    authorizationServers,
    metadata: {
      authorization_servers: authorizationServers,
      bearer_methods_supported: ["header"],
      resource: resource.toString(),
      resource_name: "One Status Remote MCP",
      scopes_supported: [...HTTP_REMOTE_SUPPORTED_SCOPES],
    },
    resolveAgentSession: oauth.resolveAgentSession,
    resolveStatusReader: oauth.resolveStatusReader,
    resource,
    resourceMetadataUrl,
    supportedScopes: [...HTTP_REMOTE_SUPPORTED_SCOPES],
    verifier: oauth.verifier,
  };
}

async function resolveRemoteStatusReader(
  oauth: NormalizedRemoteOAuth | undefined,
  session: RemoteMcpAgentSession,
): Promise<RemoteMcpStatusReader> {
  if (!oauth) throw new RemoteStatusReaderUnavailableError();
  try {
    const reader = await oauth.resolveStatusReader(session);
    if (!reader || typeof reader.read !== "function") {
      throw new Error("invalid Status reader");
    }
    return {
      async read(request) {
        try {
          return await reader.read(request);
        } catch {
          throw new Error("Remote status is unavailable.");
        }
      },
    };
  } catch {
    throw new RemoteStatusReaderUnavailableError();
  }
}

class RemoteStatusReaderUnavailableError extends Error {
  constructor() {
    super("status_reader_unavailable");
    this.name = "RemoteStatusReaderUnavailableError";
  }
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

function secureRemoteUrl(value: string | undefined, label: string): URL {
  if (!value) throw new Error(`${label} URL is required.`);
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(`${label} URL requires HTTPS outside loopback.`);
  }
  return url;
}

function normalizedResource(resource: URL): string {
  const normalized = new URL(resource);
  normalized.hash = "";
  return normalized.toString();
}

function protectedResourceMetadataUrl(resource: URL): string {
  const path = resource.pathname === "/"
    ? ""
    : resource.pathname.replace(/\/$/, "");
  return new URL(
    `/.well-known/oauth-protected-resource${path}`,
    resource.origin,
  ).toString();
}

function isProtectedResourceMetadataPath(
  pathname: string,
  oauth: NormalizedRemoteOAuth,
): boolean {
  return pathname === new URL(oauth.resourceMetadataUrl).pathname ||
    pathname === "/.well-known/oauth-protected-resource";
}

function requiredIdentity(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Remote MCP Agent identity is invalid.");
  }
  return value;
}

function remotePrincipalId(
  subject: string,
  clientId: string,
  agentId: string,
): string {
  return JSON.stringify([subject, clientId, agentId]);
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const authorization = readHeader(request, "authorization");
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s\u0000-\u001f\u007f]+)$/i.exec(authorization);
  return match?.[1];
}

function sendAuthorizationError(
  response: ServerResponse,
  error: AuthorizationError,
  oauth: NormalizedRemoteOAuth | undefined,
  requiredScopes: readonly string[] = [remoteMcpScopes.all],
): void {
  if (!oauth) {
    response.setHeader("www-authenticate", 'Bearer realm="one-status-mcp"');
    sendJson(response, error.status, { error: error.error });
    return;
  }
  const values = [
    'Bearer realm="one-status-remote-mcp"',
    `error="${error.error}"`,
    `resource_metadata="${oauth.resourceMetadataUrl}"`,
    `scope="${requiredScopes.join(" ")}"`,
  ];
  response.setHeader("www-authenticate", values.join(", "));
  sendJson(response, error.status, { error: error.error });
}

function setRemoteCorsHeaders(response: ServerResponse): void {
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

function isAuthorized(
  request: IncomingMessage,
  bearerToken: string | undefined,
): boolean {
  if (!bearerToken) return true;
  const authorization = readHeader(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(bearerToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function validateBearerToken(
  bearerToken: string | undefined,
  upstreamToken: string | undefined,
): void {
  if (!bearerToken) return;
  if (Buffer.byteLength(bearerToken, "utf8") < 32) {
    throw new Error("ONE_STATUS_MCP_BEARER_TOKEN must be at least 32 bytes.");
  }
  if (upstreamToken && bearerToken === upstreamToken) {
    throw new Error(
      "ONE_STATUS_MCP_BEARER_TOKEN must differ from ONE_STATUS_TOKEN.",
    );
  }
}

function readHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

function isTrustedLoopbackRequest(request: IncomingMessage): boolean {
  const host = readHeader(request, "host");
  if (!host || !isLoopbackHostname(readHostname(host))) return false;

  const origin = readHeader(request, "origin");
  return !origin || isLoopbackHostname(readHostname(origin));
}

function readHostname(authorityOrUrl: string): string | undefined {
  try {
    const url = authorityOrUrl.includes("://")
      ? new URL(authorityOrUrl)
      : new URL(`http://${authorityOrUrl}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  return hostname
    ? ["127.0.0.1", "[::1]", "localhost"].includes(hostname.toLowerCase())
    : false;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint.startsWith("/") || endpoint.includes("?")) {
    throw new Error("MCP endpoint must be an absolute path without a query string.");
  }
  return endpoint.length > 1 ? endpoint.replace(/\/$/, "") : endpoint;
}

async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request_body_too_large");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: NodeServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeNodeServer(server: NodeServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
