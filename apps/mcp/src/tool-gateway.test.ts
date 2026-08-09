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

  it("routes OAuth actions independently from the encrypted sync API", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer device-token");
      if (url.includes("/execute")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          action: "github.viewer.get",
          agentId: "codex",
          confirmed: true,
        });
        return Response.json({ result: { login: "ryan" } });
      }
      return Response.json({ connections: [] });
    });
    vi.stubGlobal("fetch", fetch_);
    const gateway = createRuntimeToolGateway(config);

    await expect(gateway.list()).resolves.toEqual({ connections: [] });
    await expect(
      gateway.execute({
        action: "github.viewer.get",
        confirmed: true,
        connectionId: "18f6680f-79de-4df6-8d88-08e66ddfbb53",
      }),
    ).resolves.toEqual({ login: "ryan" });

    expect(fetch_).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8787/v1/tools?agentId=codex",
      expect.any(Object),
    );
    expect(fetch_).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8787/v1/tools/execute",
      expect.any(Object),
    );
  });

  it("reloads the local session before each OAuth operation", async () => {
    const authorizations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
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
      "Bearer device-token-2",
    ]);
  });
});
