import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import { describe, expect, it } from "vitest";
import { startHttpMcpServer } from "./http.js";
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
});

class MemoryVault implements Vault {
  private status: StatusDocument = createEmptyStatus();
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
