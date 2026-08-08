import { describe, expect, it, vi } from "vitest";
import type { LocalProfile } from "@one-status/local-config";
import { loadMcpRuntimeConfig } from "./config.js";

const profile: LocalProfile = {
  version: 1,
  baseUrl: "http://127.0.0.1:8787",
  userId: "user-1",
  deviceId: "device-1",
  deviceName: "Mac A",
  token: "profile-token",
  tokenExpiresAt: "2026-09-08T10:00:00.000Z",
  statusKey: `os1_${"a".repeat(43)}`,
};

describe("MCP runtime config", () => {
  it("refuses a partial environment override before loading profile secrets", async () => {
    const loadProfile = vi.fn(async () => profile);
    await expect(
      loadMcpRuntimeConfig(
        { ONE_STATUS_URL: "https://attacker.invalid" },
        loadProfile,
      ),
    ).rejects.toThrow(/must be supplied together/);
    expect(loadProfile).not.toHaveBeenCalled();
  });

  it("loads one complete credential source", async () => {
    const fromProfile = await loadMcpRuntimeConfig({}, async () => profile);
    expect(fromProfile).toMatchObject({
      baseUrl: profile.baseUrl,
      token: profile.token,
      exportedKey: profile.statusKey,
      toolGatewayUrl: profile.baseUrl,
    });

    const fromEnvironment = await loadMcpRuntimeConfig(
      {
        ONE_STATUS_URL: "https://status.example.test",
        ONE_STATUS_TOKEN: "environment-token",
        ONE_STATUS_STATUS_KEY: `os1_${"b".repeat(43)}`,
      },
      vi.fn(async () => profile),
    );
    expect(fromEnvironment).toMatchObject({
      baseUrl: "https://status.example.test",
      token: "environment-token",
      toolGatewayUrl: "http://127.0.0.1:8787",
    });
  });

  it("keeps remote encrypted sync separate from the local Permission Vault", async () => {
    const config = await loadMcpRuntimeConfig(
      { ONE_STATUS_TOOL_GATEWAY_URL: "http://localhost:18888/" },
      async () => ({ ...profile, baseUrl: "https://os.example.test" }),
    );

    expect(config).toMatchObject({
      baseUrl: "https://os.example.test",
      toolGatewayUrl: "http://localhost:18888",
    });
  });

  it("requires TLS for a non-loopback Tool Gateway", async () => {
    await expect(
      loadMcpRuntimeConfig(
        { ONE_STATUS_TOOL_GATEWAY_URL: "http://gateway.example.test" },
        async () => profile,
      ),
    ).rejects.toThrow(/requires HTTPS/);
  });
});
