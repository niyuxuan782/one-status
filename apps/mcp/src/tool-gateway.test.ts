import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpRuntimeConfig } from "./config.js";
import {
  createReloadingRuntimeToolGateway,
  createRuntimeToolGateway,
} from "./tool-gateway.js";

const config: McpRuntimeConfig = {
  agentId: "codex",
  baseUrl: "https://os.example.test",
  exportedKey: `os1_${"a".repeat(43)}`,
  requestTimeoutMs: 1_000,
  token: "device-token",
  toolGatewayUrl: "http://127.0.0.1:8787",
};

describe("MCP runtime Tool Gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the device session once and uses only the bound Agent credential", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/v1/tools/credentials")) {
        expect(headers.get("authorization")).toBe("Bearer device-token");
        expect(JSON.parse(String(init?.body))).toEqual({ agentId: "codex" });
        return Response.json({
          credential: { agentId: "codex", token: "osa1_codex-agent-token" },
        });
      }
      expect(headers.get("authorization")).toBe(
        "Bearer osa1_codex-agent-token",
      );
      if (url.includes("/execute")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          action: "github.viewer.get",
          approvalId: "7a43cd87-1300-4b47-82d0-a34a747e516f",
        });
        expect(body).not.toHaveProperty("agentId");
        return Response.json({ result: { login: "ryan" } });
      }
      if (url.includes("/approval-requests")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          action: "github.issues.create",
        });
        expect(body).not.toHaveProperty("agentId");
        return Response.json({ approval: { status: "pending" } });
      }
      return Response.json({ connections: [] });
    });
    vi.stubGlobal("fetch", fetch_);
    const gateway = createRuntimeToolGateway(config);

    await expect(gateway.list()).resolves.toEqual({ connections: [] });
    await expect(
      gateway.execute({
        action: "github.viewer.get",
        approvalId: "7a43cd87-1300-4b47-82d0-a34a747e516f",
        connectionId: "18f6680f-79de-4df6-8d88-08e66ddfbb53",
      }),
    ).resolves.toEqual({ login: "ryan" });
    await expect(
      gateway.requestApproval({
        action: "github.issues.create",
        arguments: { title: "Approve once" },
        connectionId: "18f6680f-79de-4df6-8d88-08e66ddfbb53",
      }),
    ).resolves.toEqual({ approval: { status: "pending" } });

    expect(fetch_).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8787/v1/tools/credentials",
      expect.any(Object),
    );
    expect(fetch_).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8787/v1/tools",
      expect.any(Object),
    );
    expect(fetch_).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8787/v1/tools/execute",
      expect.any(Object),
    );
    expect(fetch_).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8787/v1/tools/approval-requests",
      expect.any(Object),
    );
  });

  it("reloads a changed device session and obtains a matching Agent credential", async () => {
    const authorizations: string[] = [];
    let credentialVersion = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (String(input).endsWith("/v1/tools/credentials")) {
          return Response.json({
            credential: {
              agentId: "codex",
              token: `osa1_agent-token-${++credentialVersion}`,
            },
          });
        }
        return Response.json({ connections: [] });
      }),
    );
    let tokenVersion = 0;
    const gateway = createReloadingRuntimeToolGateway(async () => ({
      ...config,
      token: `device-token-${++tokenVersion}`,
    }));

    await gateway.list();
    await gateway.list();

    expect(authorizations).toEqual([
      "Bearer device-token-1",
      "Bearer osa1_agent-token-1",
      "Bearer device-token-2",
      "Bearer osa1_agent-token-2",
    ]);
  });

  it("uses a pre-issued Agent credential without sending the device session", async () => {
    const fetch_ = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ connections: [] }),
    );
    vi.stubGlobal("fetch", fetch_);
    const gateway = createRuntimeToolGateway({
      ...config,
      agentToken: "osa1_preissued-agent-token",
    });

    await gateway.list();

    expect(fetch_).toHaveBeenCalledOnce();
    const [, init] = fetch_.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer osa1_preissued-agent-token",
    );
  });

  it("never sends a device session to a remote Tool Gateway", async () => {
    const fetch_ = vi.fn();
    vi.stubGlobal("fetch", fetch_);
    const gateway = createRuntimeToolGateway({
      ...config,
      toolGatewayUrl: "https://gateway.example.test",
    });

    await expect(gateway.list()).rejects.toThrow(
      "Automatic Agent credential exchange requires a loopback Tool Gateway",
    );
    expect(fetch_).not.toHaveBeenCalled();
  });

  it("renews an automatically issued credential after revocation", async () => {
    const authorizations: string[] = [];
    let issued = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        if (String(input).endsWith("/v1/tools/credentials")) {
          return Response.json({
            credential: {
              agentId: "codex",
              token: `osa1_renewed-${++issued}`,
            },
          });
        }
        if (authorization === "Bearer osa1_renewed-1") {
          return Response.json(
            { error: { code: "unauthorized", message: "revoked" } },
            { status: 401 },
          );
        }
        return Response.json({ connections: [] });
      }),
    );

    await expect(createRuntimeToolGateway(config).list()).resolves.toEqual({
      connections: [],
    });
    expect(authorizations).toEqual([
      "Bearer device-token",
      "Bearer osa1_renewed-1",
      "Bearer device-token",
      "Bearer osa1_renewed-2",
    ]);
  });

  it("routes private credential operations with the bound Agent credential", async () => {
    const requests: Array<{
      authorization: string | null;
      body: unknown;
      method: string;
      url: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          method: init?.method ?? "GET",
          url,
        });
        if (url.endsWith("/read")) {
          return Response.json({
            credential: { secrets: { password: "private-value" } },
          });
        }
        return Response.json({
          credential: { secrets: { password: "********" } },
        });
      }),
    );
    const gateway = createRuntimeToolGateway({
      ...config,
      agentToken: "osa1_preissued-agent-token",
    });
    const credentialId = "fca88ca5-f8a1-4fe1-8c35-f89bb5664a2d";

    await gateway.registerCredential({
      kind: "ssh",
      label: "Production SSH",
      purposes: ["ssh.connect"],
      fields: { host: "124.220.104.225" },
      secrets: { password: "private-value" },
      projectId: "one-status",
    });
    await gateway.listCredentials({ kinds: ["ssh"], limit: 10 });
    await gateway.resolveCredential({
      kinds: ["ssh"],
      projectId: "one-status",
      purpose: "ssh.connect",
      tags: ["production"],
    });
    await gateway.getCredential({
      credentialId,
      projectId: "one-status",
      purpose: "ssh.connect",
    });
    await gateway.updateCredential({
      credentialId,
      fields: { host: "ssh.os.example" },
      secrets: { password: "rotated-private-value" },
    });
    await gateway.deleteCredential(credentialId);

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:8787/v1/tools/private-credentials",
      },
      {
        method: "POST",
        url: "http://127.0.0.1:8787/v1/tools/private-credentials/list",
      },
      {
        method: "POST",
        url: "http://127.0.0.1:8787/v1/tools/private-credentials/resolve",
      },
      {
        method: "POST",
        url: `http://127.0.0.1:8787/v1/tools/private-credentials/${credentialId}/read`,
      },
      {
        method: "PATCH",
        url: `http://127.0.0.1:8787/v1/tools/private-credentials/${credentialId}`,
      },
      {
        method: "DELETE",
        url: `http://127.0.0.1:8787/v1/tools/private-credentials/${credentialId}`,
      },
    ]);
    expect(
      requests.every(
        ({ authorization }) =>
          authorization === "Bearer osa1_preissued-agent-token",
      ),
    ).toBe(true);
    expect(requests[0]?.body).not.toHaveProperty("agentId");
    expect(requests[0]?.body).not.toHaveProperty("source");
    expect(requests[3]?.body).toEqual({
      projectId: "one-status",
      purpose: "ssh.connect",
    });
  });

  it("redacts server details from private credential errors", async () => {
    const secret = "must-never-appear-in-an-error";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: `validation failed for ${secret}` } },
          { status: 400 },
        ),
      ),
    );
    const gateway = createRuntimeToolGateway({
      ...config,
      agentToken: "osa1_preissued-agent-token",
    });

    let message = "";
    try {
      await gateway.registerCredential({
        kind: "api",
        label: "Private API",
        purposes: ["api.call"],
        secrets: { apiKey: secret },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("One Status credential operation failed.");
    expect(message).not.toContain(secret);
  });
});
