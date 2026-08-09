import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ONE_STATUS_VERSION } from "@one-status/protocol";
import type { McpRuntimeConfig } from "./config.js";
import { loadMcpRuntimeConfig } from "./config.js";
import { createMcpServer, type Vault } from "./server.js";
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

interface SessionEntry {
  lastSeenAt: number;
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface HttpMcpServerOptions {
  bearerToken?: string;
  bodyLimit?: number;
  endpoint?: string;
  host?: string;
  idleTimeoutMs?: number;
  maxSessions?: number;
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
  validateBearerToken(bearerToken, options.upstreamToken);
  if (!isLoopbackHost(host) && !bearerToken) {
    throw new Error(
      "ONE_STATUS_MCP_BEARER_TOKEN is required when HTTP MCP binds beyond loopback.",
    );
  }
  const sessions = new Map<string, SessionEntry>();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
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
      if (!bearerToken && !isTrustedLoopbackRequest(request)) {
        sendJson(response, 403, { error: "forbidden_host" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://one-status.local");
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
        if (!isAuthorized(request, bearerToken)) {
          response.setHeader("www-authenticate", 'Bearer realm="one-status-mcp"');
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        try {
          await vault.read();
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
      if (!isAuthorized(request, bearerToken)) {
        response.setHeader("www-authenticate", 'Bearer realm="one-status-mcp"');
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      const sessionId = readHeader(request, "mcp-session-id");
      let entry = sessionId ? sessions.get(sessionId) : undefined;
      let body: unknown;
      if (request.method === "POST") {
        body = await readJsonBody(request, bodyLimit);
      }

      if (!entry && !sessionId && body && isInitializeRequest(body)) {
        if (sessions.size >= maxSessions) {
          sendJson(response, 503, { error: "session_limit_reached" });
          return;
        }
        entry = await createSession(vault, agentId, sessions, toolGateway);
      }

      if (!entry) {
        sendJson(response, sessionId ? 404 : 400, {
          error: sessionId ? "unknown_session" : "initialize_required",
        });
        return;
      }

      entry.lastSeenAt = Date.now();
      await entry.transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
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

async function createSession(
  vault: Vault,
  agentId: string,
  sessions: Map<string, SessionEntry>,
  toolGateway?: RuntimeToolGateway,
): Promise<SessionEntry> {
  const mcp = createMcpServer(vault, agentId, toolGateway);
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
  entry = { lastSeenAt: Date.now(), mcp, transport };
  await mcp.connect(transport);
  return entry;
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
