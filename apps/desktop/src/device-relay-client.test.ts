import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalProfile } from "@one-status/local-config";
import { DeviceRelayHub } from "../../api/src/device-relay.js";
import {
  executeDesktopRelayOperation,
  startDeviceRelayClient,
} from "./device-relay-client.js";

const profile: LocalProfile = {
  version: 1,
  baseUrl: "https://os.example.test",
  deviceId: "device-a",
  deviceName: "Mac A",
  statusKey: `os1_${"a".repeat(43)}`,
  token: "device-token",
  tokenExpiresAt: "2026-09-01T00:00:00.000Z",
  userId: "user-a",
};

describe("Desktop Device Relay client", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("connects outbound and answers an authorized status request", async () => {
    const server = createServer();
    const hub = new DeviceRelayHub({
      authenticate: (authorization) =>
        authorization === "Bearer device-token"
          ? { deviceId: "device-a", userId: "user-a" }
          : undefined,
    });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = startDeviceRelayClient({
      createSocket: (url, token) =>
        new WebSocket(url, { headers: { authorization: `Bearer ${token}` } }),
      execute: async (operation, agentId) => ({ operation, agentId, version: 9 }),
      loadProfile: async () => profile,
      localBaseUrl: "http://127.0.0.1:8787",
      reconnectDelayMs: 20,
      relayUrl: `ws://127.0.0.1:${port}/v1/relay`,
    });
    cleanups.push(async () => {
      client.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    await eventually(() =>
      hub
        .listOnlineDevices("user-a")[0]
        ?.capabilities.includes("status.read") === true,
    );
    await expect(
      hub.execute({
        agentId: "chatgpt-mobile",
        operation: "status.read",
        userId: "user-a",
      }),
    ).resolves.toMatchObject({
      deviceId: "device-a",
      result: {
        agentId: "chatgpt-mobile",
        operation: "status.read",
        version: 9,
      },
    });
  });

  it("returns a bounded relay error when the local executor throws synchronously", async () => {
    const server = createServer();
    const hub = new DeviceRelayHub({
      authenticate: () => ({ deviceId: "device-a", userId: "user-a" }),
    });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = startDeviceRelayClient({
      createSocket: (url, token) =>
        new WebSocket(url, { headers: { authorization: `Bearer ${token}` } }),
      execute: () => {
        throw new Error("local secret must not cross the relay");
      },
      loadProfile: async () => profile,
      localBaseUrl: "http://127.0.0.1:8787",
      reconnectDelayMs: 20,
      relayUrl: `ws://127.0.0.1:${port}/v1/relay`,
    });
    cleanups.push(async () => {
      client.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    await eventually(() => hub.listOnlineDevices("user-a").length === 1);
    await expect(
      hub.execute({
        agentId: "chatgpt-mobile",
        operation: "status.read",
        timeoutMs: 1_000,
        userId: "user-a",
      }),
    ).rejects.toMatchObject({
      code: "relay_protocol_error",
      message: "The Desktop App could not complete the request.",
    });
  });

  it("maps credential Relay operations to Agent-authenticated local Vault routes", async () => {
    const requests: Array<{ authorization?: string; body: string; path?: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({
          authorization: request.headers.authorization,
          body,
          path: request.url,
        });
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/tools/credentials") {
          response.end(
            JSON.stringify({ credential: { token: `osa1_${"a".repeat(43)}` } }),
          );
          return;
        }
        if (request.url === "/v1/tools/private-credentials/resolve") {
          response.end(
            JSON.stringify({
              credentials: [
                {
                  id: "33333333-3333-4333-8333-333333333333",
                  secrets: { apiKey: "********" },
                },
              ],
            }),
          );
          return;
        }
        response.writeHead(404).end(JSON.stringify({ error: { code: "not_found" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const result = await executeDesktopRelayOperation(
      `http://127.0.0.1:${port}`,
      "credentials.resolve",
      "chatgpt-mobile",
      { purpose: "dns.manage", kinds: ["api"] },
      async () => profile,
    );

    expect(result).toMatchObject({
      credentials: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          secrets: { apiKey: "********" },
        },
      ],
    });
    expect(requests).toEqual([
      {
        authorization: "Bearer device-token",
        body: JSON.stringify({ agentId: "chatgpt-mobile" }),
        path: "/v1/tools/credentials",
      },
      {
        authorization: `Bearer osa1_${"a".repeat(43)}`,
        body: JSON.stringify({ purpose: "dns.manage", kinds: ["api"] }),
        path: "/v1/tools/private-credentials/resolve",
      },
    ]);
  });
});

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not become true.");
}
