import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { describe, expect, it } from "vitest";
import {
  startHttpMcpServer,
  type RemoteMcpOAuthOptions,
} from "./http.js";
import {
  remoteMcpScopes,
  type RemoteMcpStatusReader,
} from "./remote-server.js";
import type { Vault } from "./server.js";

describe("Streamable HTTP MCP", () => {
  it("authenticates and supports independent sequential sessions", async () => {
    const bearerToken = "one-status-test-bearer-token-value";
    const started = await startHttpMcpServer(new MemoryVault(), "http-agent", {
      bearerToken,
      port: 0,
    });

    try {
      const unauthorized = await fetch(started.url, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(unauthorized.status).toBe(401);

      for (const name of ["first-client", "second-client"]) {
        const transport = new StreamableHTTPClientTransport(
          new URL(started.url),
          {
            requestInit: {
              headers: { authorization: `Bearer ${bearerToken}` },
            },
          },
        );
        const client = new Client({ name, version: "1.0.0" });
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain(
          "status_get_context",
        );
        const result = await client.callTool({
          name: "status_get_profile",
          arguments: {},
        });
        expect(JSON.stringify(result)).toContain("preferences");
        await transport.terminateSession();
        await client.close();
      }

      expect(started.sessionCount()).toBe(0);
      const health = await fetch(
        `http://127.0.0.1:${started.port}/health`,
      );
      expect(await health.json()).toMatchObject({
        status: "ok",
        transport: "streamable-http",
      });
      const readiness = await fetch(
        `http://127.0.0.1:${started.port}/ready`,
        { headers: { authorization: `Bearer ${bearerToken}` } },
      );
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ status: "ready" });
    } finally {
      await started.close();
    }
  });

  it("requires bearer protection on a non-loopback binding", async () => {
    await expect(
      startHttpMcpServer(new MemoryVault(), "http-agent", {
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toThrow(/BEARER_TOKEN/);
  });

  it("requires a strong bearer distinct from the upstream device token", async () => {
    await expect(
      startHttpMcpServer(new MemoryVault(), "http-agent", {
        bearerToken: "too-short",
        port: 0,
      }),
    ).rejects.toThrow(/at least 32 bytes/);

    const upstreamToken = "shared-token-value-with-32-bytes-minimum";
    await expect(
      startHttpMcpServer(new MemoryVault(), "http-agent", {
        bearerToken: upstreamToken,
        upstreamToken,
        port: 0,
      }),
    ).rejects.toThrow(/must differ/);
  });

  it("rejects DNS rebinding hosts when loopback runs without a bearer", async () => {
    const started = await startHttpMcpServer(
      new MemoryVault(),
      "http-agent",
      { port: 0 },
    );

    try {
      const response = await fetch(started.url, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "rebinding-test", version: "1.0.0" },
          },
        }),
        headers: {
          "content-type": "application/json",
          host: "attacker.example",
          origin: "http://attacker.example",
        },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden_host" });
      expect(started.sessionCount()).toBe(0);
    } finally {
      await started.close();
    }
  });

  it("discovers OAuth and binds each remote MCP session to one Agent", async () => {
    const resource = "https://mcp.example.test/mcp";
    const vault = new MemoryVault();
    vault.status.preferences.language = "zh-CN";
    const oauth = testOAuth(
      resource,
      {
        "agent-a-token": {
          agentId: "chatgpt",
          clientId: "chatgpt-client",
          scopes: [remoteMcpScopes.all],
          subject: "user-1",
        },
        "agent-b-token": {
          agentId: "claude",
          clientId: "claude-client",
          scopes: [remoteMcpScopes.all],
          subject: "user-1",
        },
      },
      { "user-1": vault },
    );
    const started = await startHttpMcpServer(vault, "ignored-local-agent", {
      oauth,
      port: 0,
      publicUrl: resource,
    });
    const localEndpoint = `http://127.0.0.1:${started.port}/mcp`;

    try {
      const metadata = await fetch(
        `http://127.0.0.1:${started.port}/.well-known/oauth-protected-resource/mcp`,
      );
      expect(metadata.status).toBe(200);
      expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
      const metadataBody = await metadata.json();
      expect(metadataBody).toMatchObject({
        resource,
        authorization_servers: ["https://auth.example.test"],
        bearer_methods_supported: ["header"],
        scopes_supported: expect.arrayContaining([
          remoteMcpScopes.profile,
          remoteMcpScopes.context,
          remoteMcpScopes.memory,
        ]),
      });
      expect(metadataBody.scopes_supported).not.toContain(
        remoteMcpScopes.toolsExecute,
      );
      await expect(
        discoverOAuthProtectedResourceMetadata(localEndpoint),
      ).resolves.toMatchObject({ resource });

      const unauthorized = await fetch(localEndpoint, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain(
        `resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
      );

      const transport = new StreamableHTTPClientTransport(
        new URL(localEndpoint),
        {
          requestInit: {
            headers: { authorization: "Bearer agent-a-token" },
          },
        },
      );
      const client = new Client({ name: "remote-client", version: "1.0.0" });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "status_get_profile",
        "status_get_context",
        "status_get_memory",
      ]);
      expect(tools.tools.map((tool) => tool.name)).not.toContain("write_status");
      expect(tools.tools.map((tool) => tool.name)).not.toContain(
        "credentials_get",
      );
      const profile = await client.callTool({
        name: "status_get_profile",
        arguments: {},
      });
      expect(JSON.stringify(profile.structuredContent)).toContain("zh-CN");

      const hijack = await fetch(localEndpoint, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/list",
          params: {},
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer agent-b-token",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          "mcp-session-id": transport.sessionId!,
        },
      });
      expect(hijack.status).toBe(404);
      expect(await hijack.json()).toEqual({ error: "unknown_session" });

      await transport.terminateSession();
      await client.close();
      expect(started.sessionCount()).toBe(0);
    } finally {
      await started.close();
    }
  });

  it("limits Remote MCP tools by OAuth scope and enforces resource audience", async () => {
    const resource = "https://mcp.example.test/mcp";
    const oauth = testOAuth(
      resource,
      {
        "memory-token": {
          agentId: "memory-agent",
          clientId: "memory-client",
          scopes: [remoteMcpScopes.memory],
          subject: "user-1",
        },
        "wrong-audience-token": {
          agentId: "memory-agent",
          clientId: "memory-client",
          resource: "https://other.example.test/mcp",
          scopes: [remoteMcpScopes.memory],
          subject: "user-1",
        },
        "unscoped-token": {
          agentId: "unscoped-agent",
          clientId: "unscoped-client",
          scopes: ["unrelated:read"],
          subject: "user-1",
        },
        "expired-token": {
          agentId: "expired-agent",
          clientId: "expired-client",
          expiresAt: Math.floor(Date.now() / 1_000) - 60,
          scopes: [remoteMcpScopes.memory],
          subject: "user-1",
        },
      },
      { "user-1": new MemoryVault() },
    );
    const started = await startHttpMcpServer(new MemoryVault(), "local", {
      oauth,
      port: 0,
      publicUrl: resource,
    });
    const localEndpoint = `http://127.0.0.1:${started.port}/mcp`;

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(localEndpoint),
        {
          requestInit: {
            headers: { authorization: "Bearer memory-token" },
          },
        },
      );
      const client = new Client({ name: "scoped-client", version: "1.0.0" });
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "status_get_memory",
      ]);
      await transport.terminateSession();
      await client.close();

      const wrongAudience = await initialize(localEndpoint, "wrong-audience-token");
      expect(wrongAudience.status).toBe(401);
      expect(await wrongAudience.json()).toEqual({ error: "invalid_token" });

      const unscoped = await initialize(localEndpoint, "unscoped-token");
      expect(unscoped.status).toBe(403);
      expect(await unscoped.json()).toEqual({ error: "insufficient_scope" });
      expect(unscoped.headers.get("www-authenticate")).toContain(
        'scope="status:read"',
      );

      const expired = await initialize(localEndpoint, "expired-token");
      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual({ error: "invalid_token" });
    } finally {
      await started.close();
    }
  });

  it("requires secure public OAuth metadata URLs", async () => {
    const oauth = testOAuth("http://public.example.test/mcp", {});
    await expect(
      startHttpMcpServer(new MemoryVault(), "local", {
        oauth,
        port: 0,
        publicUrl: "http://public.example.test/mcp",
      }),
    ).rejects.toThrow(/HTTPS/);

    await expect(
      startHttpMcpServer(new MemoryVault(), "local", {
        bearerToken: "one-status-static-token-with-32-characters",
        oauth: testOAuth("https://mcp.example.test/mcp", {}),
        port: 0,
        publicUrl: "https://mcp.example.test/mcp",
      }),
    ).rejects.toThrow(/cannot be enabled together/);
  });

  it("uses the authenticated subject's Status reader without cross-tenant data", async () => {
    const resource = "https://mcp.example.test/mcp";
    const firstVault = new MemoryVault();
    firstVault.status.preferences.tenantMarker = "first-subject-only";
    const secondVault = new MemoryVault();
    secondVault.status.preferences.tenantMarker = "second-subject-only";
    const fallbackVault = new MemoryVault();
    fallbackVault.status.preferences.tenantMarker = "fallback-must-not-appear";
    const oauth = testOAuth(
      resource,
      {
        "first-token": {
          agentId: "shared-agent",
          clientId: "shared-client",
          scopes: [remoteMcpScopes.profile],
          subject: "user-1",
        },
        "second-token": {
          agentId: "shared-agent",
          clientId: "shared-client",
          scopes: [remoteMcpScopes.profile],
          subject: "user-2",
        },
      },
      { "user-1": firstVault, "user-2": secondVault },
    );
    const started = await startHttpMcpServer(fallbackVault, "local", {
      oauth,
      port: 0,
      publicUrl: resource,
    });
    const endpoint = `http://127.0.0.1:${started.port}/mcp`;

    try {
      const first = JSON.stringify(await readRemoteProfile(endpoint, "first-token"));
      expect(first).toContain("first-subject-only");
      expect(first).not.toContain("second-subject-only");
      expect(first).not.toContain("fallback-must-not-appear");

      const second = JSON.stringify(
        await readRemoteProfile(endpoint, "second-token"),
      );
      expect(second).toContain("second-subject-only");
      expect(second).not.toContain("first-subject-only");
      expect(second).not.toContain("fallback-must-not-appear");
      expect(started.sessionCount()).toBe(0);
    } finally {
      await started.close();
    }
  });

  it("redacts Status reader resolver failures", async () => {
    const resource = "https://mcp.example.test/mcp";
    const sensitiveFailure = "tenant database password appeared in resolver";
    const oauth = testOAuth(resource, {
      "reader-failure-token": {
        agentId: "remote-agent",
        clientId: "remote-client",
        scopes: [remoteMcpScopes.profile],
        subject: "user-1",
      },
    });
    oauth.resolveStatusReader = async () => {
      throw new Error(sensitiveFailure);
    };
    const started = await startHttpMcpServer(new MemoryVault(), "local", {
      oauth,
      port: 0,
      publicUrl: resource,
    });
    const endpoint = `http://127.0.0.1:${started.port}/mcp`;

    try {
      const response = await initialize(endpoint, "reader-failure-token");
      const responseText = await response.text();
      expect(response.status).toBe(503);
      expect(responseText).toContain("status_reader_unavailable");
      expect(responseText).not.toContain(sensitiveFailure);
      expect(started.sessionCount()).toBe(0);

      const readiness = await fetch(
        `http://127.0.0.1:${started.port}/ready`,
        { headers: { authorization: "Bearer reader-failure-token" } },
      );
      const readinessText = await readiness.text();
      expect(readiness.status).toBe(503);
      expect(readinessText).toContain("upstream_unavailable");
      expect(readinessText).not.toContain(sensitiveFailure);
    } finally {
      await started.close();
    }
  });
});

class MemoryVault implements Vault {
  status: StatusDocument = createEmptyStatus();
  private version = 1;

  async read() {
    return {
      version: this.version,
      status: structuredClone(this.status),
      updatedAt: null,
    };
  }

  async mutate(mutation: (draft: StatusDocument) => void) {
    const next = structuredClone(this.status);
    mutation(next);
    this.status = next;
    this.version += 1;
    return this.read();
  }
}

interface TestAgentToken {
  agentId: string;
  clientId: string;
  expiresAt?: number;
  resource?: string;
  scopes: string[];
  subject: string;
}

function testOAuth(
  resource: string,
  tokens: Record<string, TestAgentToken>,
  statusReaders: Record<string, RemoteMcpStatusReader> = {},
): RemoteMcpOAuthOptions {
  return {
    authorizationServers: ["https://auth.example.test"],
    resource,
    resolveAgentSession(authInfo) {
      return {
        agentId: String(authInfo.extra?.agentId),
        subject: String(authInfo.extra?.subject),
      };
    },
    resolveStatusReader(session) {
      const reader = statusReaders[session.subject];
      if (!reader) throw new Error(`Status reader missing for ${session.subject}`);
      return reader;
    },
    verifier: {
      async verifyAccessToken(token) {
        const session = tokens[token];
        if (!session) throw new Error("invalid token");
        return {
          token,
          clientId: session.clientId,
          expiresAt:
            session.expiresAt ?? Math.floor(Date.now() / 1_000) + 3_600,
          extra: {
            agentId: session.agentId,
            subject: session.subject,
          },
          resource: new URL(session.resource ?? resource),
          scopes: session.scopes,
        };
      },
    },
  };
}

async function readRemoteProfile(endpoint: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: token, version: "1.0.0" });
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

function initialize(endpoint: string, token: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "1.0.0" },
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
}
