import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  remoteMcpDefaultScopes,
  remoteMcpScopes,
  type RemoteMcpStatusReader,
} from "@one-status/mcp/remote";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerRemoteMcpRoutes,
  type FastifyRemoteMcpOptions,
} from "./remote-mcp.js";

const resource = "https://mcp.example.test/mcp";
const applications: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("Fastify Remote MCP routes", () => {
  it("serves OAuth discovery and isolates Status by authenticated subject", async () => {
    const firstReader = reader("first-subject-only");
    const secondReader = reader("second-subject-only");
    const fixture = await createFixture(
      {
        "first-token": token("user-1", "shared-client", "shared-agent", [
          remoteMcpScopes.profile,
        ]),
        "second-token": token("user-2", "shared-client", "shared-agent", [
          remoteMcpScopes.profile,
        ]),
      },
      { "user-1": firstReader, "user-2": secondReader },
    );

    const metadata = await fetch(
      `${fixture.origin}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
    expect(await metadata.json()).toMatchObject({
      resource,
      authorization_servers: ["https://auth.example.test"],
      bearer_methods_supported: ["header"],
    });
    await expect(
      discoverOAuthProtectedResourceMetadata(fixture.endpoint),
    ).resolves.toMatchObject({ resource });

    const preflight = await fetch(fixture.endpoint, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );

    const unauthorized = await fetch(fixture.endpoint, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      `scope="${remoteMcpDefaultScopes.join(" ")}"`,
    );
    expect(remoteMcpDefaultScopes).toEqual([
      remoteMcpScopes.profile,
      remoteMcpScopes.context,
      remoteMcpScopes.memory,
    ]);
    expect(unauthorized.headers.get("www-authenticate")).not.toContain(
      remoteMcpScopes.devices,
    );
    expect(unauthorized.headers.get("www-authenticate")).not.toContain(
      remoteMcpScopes.toolsRead,
    );
    expect(unauthorized.headers.get("www-authenticate")).not.toContain(
      remoteMcpScopes.toolsExecute,
    );
    expect(unauthorized.headers.get("www-authenticate")).not.toContain(
      remoteMcpScopes.vaultRead,
    );
    expect(unauthorized.headers.get("www-authenticate")).not.toContain(
      remoteMcpScopes.vaultWrite,
    );

    const first = JSON.stringify(
      await readProfile(fixture.endpoint, "first-token"),
    );
    expect(first).toContain("first-subject-only");
    expect(first).not.toContain("second-subject-only");

    const second = JSON.stringify(
      await readProfile(fixture.endpoint, "second-token"),
    );
    expect(second).toContain("second-subject-only");
    expect(second).not.toContain("first-subject-only");
    expect(fixture.routes.sessionCount()).toBe(0);
  });

  it("binds MCP sessions to their owner and rechecks the granted scope", async () => {
    const tokenInfo = token("user-1", "client-a", "agent-a", [
      remoteMcpScopes.all,
    ]);
    const fixture = await createFixture(
      {
        "agent-a-token": tokenInfo,
        "agent-b-token": token("user-2", "client-b", "agent-b", [
          remoteMcpScopes.profile,
        ]),
      },
      { "user-1": reader("first"), "user-2": reader("second") },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(fixture.endpoint),
      {
        requestInit: {
          headers: { authorization: "Bearer agent-a-token" },
        },
      },
    );
    const client = new Client({ name: "owner-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(fixture.routes.sessionCount()).toBe(1);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "status_get_profile",
        "status_get_context",
        "status_get_memory",
      ]);

      const hijack = await mcpRequest(
        fixture.endpoint,
        "agent-b-token",
        transport.sessionId!,
      );
      expect(hijack.status).toBe(404);
      expect(await hijack.json()).toEqual({ error: "unknown_session" });

      tokenInfo.scopes = [...remoteMcpDefaultScopes];
      const continued = await mcpRequest(
        fixture.endpoint,
        "agent-a-token",
        transport.sessionId!,
      );
      expect(continued.status).toBe(200);
      await continued.text();

      tokenInfo.scopes = [remoteMcpScopes.memory];
      const reduced = await mcpRequest(
        fixture.endpoint,
        "agent-a-token",
        transport.sessionId!,
      );
      expect(reduced.status).toBe(403);
      expect(await reduced.json()).toEqual({ error: "insufficient_scope" });
    } finally {
      tokenInfo.scopes = [remoteMcpScopes.all];
      if (transport.sessionId) await transport.terminateSession();
      await client.close();
    }
    expect(fixture.routes.sessionCount()).toBe(0);
  });

  it("limits the tool surface and redacts Status resolver failures", async () => {
    const sensitiveFailure = "tenant vault secret leaked by resolver";
    const tokens = {
      "memory-token": token("user-1", "memory-client", "memory-agent", [
        remoteMcpScopes.memory,
      ]),
      "failure-token": token("missing-user", "failed-client", "failed-agent", [
        remoteMcpScopes.profile,
      ]),
      "unscoped-token": token("user-1", "bad-client", "bad-agent", [
        "unrelated:read",
      ]),
    };
    const fixture = await createFixture(tokens, { "user-1": reader("memory") }, {
      resolveStatusReader(session) {
        if (session.subject === "missing-user") throw new Error(sensitiveFailure);
        return reader("memory");
      },
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(fixture.endpoint),
      {
        requestInit: { headers: { authorization: "Bearer memory-token" } },
      },
    );
    const client = new Client({ name: "scope-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "status_get_memory",
      ]);
    } finally {
      if (transport.sessionId) await transport.terminateSession();
      await client.close();
    }

    const unscoped = await initialize(fixture.endpoint, "unscoped-token");
    expect(unscoped.status).toBe(403);
    expect(await unscoped.json()).toEqual({ error: "insufficient_scope" });

    const failure = await initialize(fixture.endpoint, "failure-token");
    const failureText = await failure.text();
    expect(failure.status).toBe(503);
    expect(failureText).toContain("status_reader_unavailable");
    expect(failureText).not.toContain(sensitiveFailure);
    expect(fixture.routes.sessionCount()).toBe(0);
  });

  it("limits sessions per OAuth principal without blocking another account", async () => {
    const fixture = await createFixture(
      {
        "first-token": token("user-1", "client-1", "agent-1", [
          remoteMcpScopes.profile,
        ]),
        "second-token": token("user-2", "client-2", "agent-2", [
          remoteMcpScopes.profile,
        ]),
      },
      { "user-1": reader("first"), "user-2": reader("second") },
      { maxSessions: 2, maxSessionsPerPrincipal: 1 },
    );

    const first = await initialize(fixture.endpoint, "first-token");
    expect(first.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeTruthy();
    await first.text();

    const duplicate = await initialize(fixture.endpoint, "first-token");
    expect(duplicate.status).toBe(503);
    expect(await duplicate.json()).toEqual({ error: "session_limit_reached" });

    const otherPrincipal = await initialize(fixture.endpoint, "second-token");
    expect(otherPrincipal.status).toBe(200);
    await otherPrincipal.text();
    expect(fixture.routes.sessionCount()).toBe(2);
  });
});

interface MutableToken extends AuthInfo {
  scopes: string[];
}

async function createFixture(
  tokens: Record<string, MutableToken>,
  readers: Record<string, RemoteMcpStatusReader>,
  overrides: Partial<FastifyRemoteMcpOptions> = {},
) {
  const app = Fastify({ logger: false });
  applications.push(app);
  const routes = registerRemoteMcpRoutes(app, {
    authorizationServers: ["https://auth.example.test"],
    resource,
    resolveAgentSession(authInfo) {
      return {
        agentId: String(authInfo.extra?.agentId),
        subject: String(authInfo.extra?.subject),
      };
    },
    resolveStatusReader(session) {
      const statusReader = readers[session.subject];
      if (!statusReader) throw new Error("Status reader is unavailable.");
      return statusReader;
    },
    verifier: {
      async verifyAccessToken(value) {
        const info = tokens[value];
        if (!info) throw new Error("Invalid token.");
        return { ...info, token: value, scopes: [...info.scopes] };
      },
    },
    ...overrides,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, endpoint: `${origin}/mcp`, origin, routes };
}

function token(
  subject: string,
  clientId: string,
  agentId: string,
  scopes: string[],
): MutableToken {
  return {
    clientId,
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    extra: { agentId, subject },
    resource: new URL(resource),
    scopes,
    token: "fixture",
  };
}

function reader(marker: string): RemoteMcpStatusReader {
  const status: StatusDocument = createEmptyStatus();
  status.preferences.tenantMarker = marker;
  return {
    async read(request) {
      if (request.view === "profile") {
        return {
          version: 1,
          identity: structuredClone(status.identity),
          preferences: structuredClone(status.preferences),
          personaProfile: structuredClone(status.persona.profile),
        };
      }
      if (request.view === "context") {
        return {
          version: 1,
          workspace: structuredClone(status.workspace),
          project: null,
          openTasks: [],
          sessionMemory: [],
        };
      }
      return { version: 1, memory: [] };
    },
  };
}

async function readProfile(endpoint: string, tokenValue: string) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${tokenValue}` } },
  });
  const client = new Client({ name: tokenValue, version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.callTool({
      name: "status_get_profile",
      arguments: {},
    })).structuredContent;
  } finally {
    if (transport.sessionId) await transport.terminateSession();
    await client.close();
  }
}

function initialize(endpoint: string, tokenValue: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "fastify-test", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenValue}`,
      "content-type": "application/json",
    },
  });
}

function mcpRequest(
  endpoint: string,
  tokenValue: string,
  sessionId: string,
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenValue}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
    },
  });
}
