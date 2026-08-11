import { describe, expect, it, vi } from "vitest";
import { CloudVaultServiceClient } from "./cloud-vault-client.js";

const serviceToken = `vault-service_${"a".repeat(40)}`;
const agentToken = `osva1_${"b".repeat(43)}`;
const approvalToken = `osvp1_${"c".repeat(43)}`;

describe("CloudVaultServiceClient", () => {
  it("issues a short-lived Agent Session and routes credential reads", async () => {
    const requests: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
        method: String(init?.method),
        url,
      });
      if (url.endsWith("/v1/internal/agent-sessions")) {
        return Response.json(
          {
            session: {
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              token: agentToken,
            },
          },
          { status: 201 },
        );
      }
      return Response.json({ credentials: [{ id: credentialId }] });
    });
    const client = new CloudVaultServiceClient({
      baseUrl: "http://vault:8791",
      fetch: fetchMock as typeof fetch,
      serviceToken,
    });
    const gateway = await client.createAgentGateway({
      agentId: "remote:chatgpt",
      clientId: "chatgpt-client",
      scopes: ["vault:read"],
      subject: "user-1",
    });
    await gateway.credential("credentials.list", {
      kinds: ["ssh"],
      purposes: ["ssh.connect"],
    });
    await gateway.credential("credentials.resolve", {
      kinds: ["ssh"],
      limit: 20,
      purpose: "ssh.connect",
    });
    await expect(
      gateway.credential("credentials.resolve", {
        projectId: "unapproved-project",
        purpose: "ssh.connect",
      }),
    ).rejects.toThrow("vault_project_not_authorized");

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      body: {
        agentId: "remote:chatgpt",
        clientId: "chatgpt-client",
        grants: [{ projectIds: [], purposes: ["*"] }],
        ttlSeconds: 3600,
        userId: "user-1",
      },
      method: "POST",
      url: "http://vault:8791/v1/internal/agent-sessions",
    });
    expect(requests[1]).toMatchObject({
      body: { kinds: ["ssh"], purposes: ["ssh.connect"] },
      method: "POST",
      url: "http://vault:8791/v1/internal/credentials/list",
    });
    expect(requests[2]).toMatchObject({
      body: { kinds: ["ssh"], limit: 20, purpose: "ssh.connect" },
      method: "POST",
      url: "http://vault:8791/v1/internal/credentials/resolve",
    });
    expect(requests[0]!.headers.get("authorization")).toBe(
      `Bearer ${serviceToken}`,
    );
    expect(requests[1]!.headers.get("x-one-status-agent-token")).toBe(
      agentToken,
    );
  });

  it("maps exact approval requests and updates without copying IDs into patches", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      bodies.push(body);
      if (url.endsWith("/v1/internal/agent-sessions")) {
        return Response.json({
          session: {
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            token: agentToken,
          },
        });
      }
      return Response.json({ credential: { id: credentialId } });
    });
    const gateway = await new CloudVaultServiceClient({
      baseUrl: "http://vault:8791/",
      fetch: fetchMock as typeof fetch,
      serviceToken,
    }).createAgentGateway({
      agentId: "remote:claude",
      clientId: "claude-client",
      scopes: ["vault:write", "project:one-status"],
      subject: "user-1",
    });

    await gateway.credential("credentials.request_approval", {
      operation: "credential.update",
      request: {
        credentialId,
        projectId: "one-status",
        secrets: { password: "rotated-secret" },
      },
    });
    await gateway.credential("credentials.update", {
      approvalToken,
      credentialId,
      projectId: "one-status",
      secrets: { password: "rotated-secret" },
    });
    expect(bodies[0]).toMatchObject({
      grants: [{ projectIds: ["one-status"], purposes: ["*"] }],
      projectIds: ["one-status"],
      ttlSeconds: 3600,
    });
    expect(bodies[1]).toEqual({
      operation: "credential.update",
      request: {
        credentialId,
        patch: { secrets: { password: "rotated-secret" } },
        projectId: "one-status",
        purpose: "credential.update",
      },
    });
    expect(bodies[2]).toEqual({
      approvalToken,
      patch: { secrets: { password: "rotated-secret" } },
      projectId: "one-status",
      purpose: "credential.update",
    });
  });

  it("does not expose internal Vault errors", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "unexpected_internal_code",
            message: "database details and secret material",
          },
        },
        { status: 500 },
      ),
    );
    const client = new CloudVaultServiceClient({
      baseUrl: "http://vault:8791",
      fetch: fetchMock as typeof fetch,
      serviceToken,
    });
    const gateway = await client.createAgentGateway({
      agentId: "remote:test",
      clientId: "test-client",
      scopes: ["vault:read"],
      subject: "user-1",
    });
    await expect(
      gateway.credential("credentials.list", { limit: 1 }),
    ).rejects.toThrow("vault_operation_failed");
  });
});

const credentialId = "33333333-3333-4333-8333-333333333333";
