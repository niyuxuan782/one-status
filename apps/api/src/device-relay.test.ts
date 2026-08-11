import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { DeviceRelayHub } from "./device-relay.js";

describe("DeviceRelayHub", () => {
  it("authenticates a device and routes a request without persisting its body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const hub = new DeviceRelayHub({
      authenticate(authorization) {
        return authorization === "Bearer device-token"
          ? { deviceId: "device-a", userId: "user-a" }
          : undefined;
      },
    });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/relay`, {
      headers: { authorization: "Bearer device-token" },
    });

    try {
      await opened(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          capabilities: ["status.read", "tools.list"],
        }),
      );
      await eventually(() =>
        hub
          .listOnlineDevices("user-a")[0]
          ?.capabilities.includes("status.read") === true,
      );
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type !== "request") return;
        socket.send(
          JSON.stringify({
            type: "response",
            requestId: message.requestId,
            ok: true,
            result: { version: 7, context: "remote continuation" },
          }),
        );
      });

      await expect(
        hub.execute({
          agentId: "chatgpt",
          operation: "status.read",
          userId: "user-a",
        }),
      ).resolves.toEqual({
        deviceId: "device-a",
        result: { version: 7, context: "remote continuation" },
      });
    } finally {
      socket.close();
      await hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects unauthorized upgrades and reports an offline device", async () => {
    const server = createServer();
    const hub = new DeviceRelayHub({ authenticate: () => undefined });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/v1/relay`);

    try {
      const status = await unexpectedResponseStatus(unauthorized);
      expect(status).toBe(401);
      await expect(
        hub.execute({
          agentId: "claude-web",
          operation: "status.read",
          userId: "user-a",
        }),
      ).rejects.toMatchObject({ code: "device_offline" });
    } finally {
      unauthorized.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects and closes upgrades for paths outside the Relay endpoint", async () => {
    const server = createServer();
    const hub = new DeviceRelayHub({ authenticate: () => undefined });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/v1/not-relay`);

    try {
      await expect(unexpectedResponseStatus(wrongPath)).resolves.toBe(404);
    } finally {
      wrongPath.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("routes to an online device that advertises the requested capability", async () => {
    const server = createServer();
    const hub = new DeviceRelayHub({
      authenticate: (authorization) => {
        if (authorization === "Bearer token-a") {
          return { deviceId: "device-a", userId: "user-a" };
        }
        if (authorization === "Bearer token-b") {
          return { deviceId: "device-b", userId: "user-a" };
        }
        return undefined;
      },
    });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const deviceA = new WebSocket(`ws://127.0.0.1:${port}/v1/relay`, {
      headers: { authorization: "Bearer token-a" },
    });
    const deviceB = new WebSocket(`ws://127.0.0.1:${port}/v1/relay`, {
      headers: { authorization: "Bearer token-b" },
    });

    try {
      await Promise.all([opened(deviceA), opened(deviceB)]);
      deviceA.send(JSON.stringify({ type: "hello", capabilities: ["status.read"] }));
      deviceB.send(JSON.stringify({ type: "hello", capabilities: ["tools.list"] }));
      deviceB.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type !== "request") return;
        deviceB.send(
          JSON.stringify({
            type: "response",
            requestId: message.requestId,
            ok: true,
            result: { tools: ["calendar.list_events"] },
          }),
        );
      });
      await eventually(() =>
        hub
          .listOnlineDevices("user-a")
          .some(
            (device) =>
              device.deviceId === "device-b" &&
              device.capabilities.includes("tools.list"),
          ),
      );

      await expect(
        hub.execute({
          agentId: "claude-web",
          operation: "tools.list",
          userId: "user-a",
        }),
      ).resolves.toMatchObject({ deviceId: "device-b" });
      await expect(
        hub.execute({
          agentId: "claude-web",
          deviceId: "device-a",
          operation: "tools.list",
          userId: "user-a",
        }),
      ).rejects.toMatchObject({ code: "device_capability_unavailable" });
    } finally {
      deviceA.close();
      deviceB.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function opened(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function unexpectedResponseStatus(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once("close", () => resolve(status));
    });
    socket.once("error", reject);
  });
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not become true.");
}
