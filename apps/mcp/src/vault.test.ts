import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encryptStatus,
  exportStatusKey,
  generateStatusKey,
} from "@one-status/crypto";
import { createEmptyStatus } from "@one-status/protocol";
import type { McpRuntimeConfig } from "./config.js";
import { createReloadingRuntimeVault } from "./vault.js";

describe("reloading MCP vault", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("switches to a rotated profile without restarting the process", async () => {
    const firstKey = generateStatusKey();
    const secondKey = generateStatusKey();
    const firstStatus = createEmptyStatus();
    const secondStatus = createEmptyStatus();
    firstStatus.workspace.currentContext = "first profile";
    secondStatus.workspace.currentContext = "rotated profile";
    const envelopes = new Map([
      ["Bearer token-1", encryptStatus(firstStatus, firstKey, 1)],
      ["Bearer token-2", encryptStatus(secondStatus, secondKey, 1)],
    ]);
    const fetch_ = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          envelope: envelopes.get(authorization),
          updatedAt: null,
          version: 1,
        });
      },
    );
    vi.stubGlobal("fetch", fetch_);
    const configs: McpRuntimeConfig[] = [
      runtimeConfig("token-1", exportStatusKey(firstKey)),
      runtimeConfig("token-2", exportStatusKey(secondKey)),
    ];
    let profileVersion = 0;
    const vault = createReloadingRuntimeVault(async () =>
      configs[Math.min(profileVersion++, configs.length - 1)]!,
    );

    await expect(vault.read()).resolves.toMatchObject({
      status: { workspace: { currentContext: "first profile" } },
    });
    await expect(vault.read()).resolves.toMatchObject({
      status: { workspace: { currentContext: "rotated profile" } },
    });
    expect(fetch_).toHaveBeenCalledTimes(2);
  });
});

function runtimeConfig(token: string, exportedKey: string): McpRuntimeConfig {
  return {
    agentId: "codex",
    baseUrl: "http://127.0.0.1:8787",
    exportedKey,
    requestTimeoutMs: 1_000,
    token,
    toolGatewayUrl: "http://127.0.0.1:8787",
  };
}
