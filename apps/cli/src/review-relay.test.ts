import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { reviewStatusView, startReviewRelay } from "./review-relay.js";

describe("OpenAI review Relay fixture", () => {
  it("returns stable profile and context data without internal identifiers", () => {
    const profile = reviewStatusView({ view: "profile" });
    const context = reviewStatusView({ view: "context" });
    const serialized = JSON.stringify({ profile, context });

    expect(serialized).toContain("Alex Chen");
    expect(serialized).toContain("Atlas Notes");
    expect(serialized).not.toMatch(/token|password|credentialId|requestId/iu);
    expect(serialized).not.toMatch(/createdAt|updatedAt|userId|deviceId/iu);
  });

  it("filters confirmed fixture memory by scope, project, and limit", () => {
    expect(
      reviewStatusView({
        view: "memory",
        scope: "project",
        projectId: "atlas-notes",
        limit: 1,
      }),
    ).toEqual({
      version: 1,
      memory: [
        {
          scope: "project",
          projectId: "atlas-notes",
          content: "Atlas Notes uses TypeScript and PostgreSQL.",
          tags: ["architecture", "confirmed"],
        },
      ],
    });
  });

  it("rejects unsupported views and invalid filters", () => {
    expect(() => reviewStatusView({ view: "devices" })).toThrow();
    expect(() =>
      reviewStatusView({ view: "memory", scope: "private", limit: 10 }),
    ).toThrow();
    expect(() =>
      reviewStatusView({ view: "memory", limit: 201 }),
    ).toThrow();
  });

  it("advertises only status.read and serves the fixture over Device Relay", async () => {
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    await new Promise<void>((resolve) =>
      http.listen(0, "127.0.0.1", resolve),
    );
    const port = (http.address() as AddressInfo).port;
    const messages: Array<Record<string, unknown>> = [];
    const response = new Promise<Record<string, unknown>>((resolve) => {
      server.once("connection", (socket, request) => {
        expect(request.headers.authorization).toBe(
          `Bearer ${"a".repeat(43)}`,
        );
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          messages.push(message);
          if (message.type === "hello") {
            socket.send(
              JSON.stringify({
                type: "request",
                requestId: "review-request-1",
                agentId: "chatgpt-review",
                operation: "status.read",
                payload: { view: "context" },
              }),
            );
          } else if (message.type === "response") {
            resolve(message);
          }
        });
      });
    });
    const running = startReviewRelay({
      reconnectDelayMs: 50,
      relayUrl: `ws://127.0.0.1:${port}/v1/relay`,
      token: "a".repeat(43),
    });

    try {
      await expect(response).resolves.toMatchObject({
        type: "response",
        requestId: "review-request-1",
        ok: true,
        result: {
          project: { name: "Atlas Notes" },
        },
      });
      expect(messages[0]).toEqual({
        type: "hello",
        capabilities: ["status.read"],
      });
    } finally {
      running.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) => error ? reject(error) : resolve()),
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          throw error;
        }
      });
    }
  });
});
