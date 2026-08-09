import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@one-status/api";
import { generateStatusKey, StatusDecryptionError } from "@one-status/crypto";
import {
  OneStatusClient,
  StatusNotInitializedError,
} from "./index.js";

describe("synced status client", () => {
  let app: ReturnType<typeof createApp>;
  let directory: string;
  let baseUrl: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-client-"));
    app = createApp({ dbPath: join(directory, "test.sqlite") });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("shares an encrypted status between two device sessions", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const account = {
      email: "continuity@example.test",
      password: "long demo password",
    };
    const key = generateStatusKey();
    const deviceA = await anonymous.register(
      { ...account, deviceName: "Mac A" },
      key,
    );
    const deviceB = await anonymous.login({ ...account, deviceName: "Mac B" });
    const clientA = new OneStatusClient({ baseUrl, token: deviceA.token });
    const vaultA = clientA.createVault(key);
    const vaultB = new OneStatusClient({ baseUrl, token: deviceB.token }).createVault(key);

    await vaultA.mutate((status) => {
      status.preferences.packageManager = "pnpm";
      status.workspace.currentContext = "Build the One Status MCP Gateway";
      const observedAt = "2026-08-09T14:30:00.000Z";
      const observation = {
        observedAt,
        sourceAgent: "codex",
        sourceProject: "one-status",
        confidence: "explicit" as const,
      };
      status.persona.events.push({
        id: "persona-language-style",
        category: "language_style",
        content: "Prefer concise Chinese technical answers",
        observedAt,
        lastObservedAt: observedAt,
        observationCount: 1,
        observations: [observation],
        sourceAgent: "codex",
        sourceProject: "one-status",
        confidence: "explicit",
        updatedAt: observedAt,
      });
      status.persona.profile.language_style = {
        category: "language_style",
        content: "Prefer concise Chinese technical answers",
        confidence: "explicit",
        sourceEventIds: ["persona-language-style"],
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        observationCount: 1,
        updatedAt: observedAt,
      };
    });

    const onDeviceB = await vaultB.read();
    expect(onDeviceB.status.preferences.packageManager).toBe("pnpm");
    expect(onDeviceB.status.workspace.currentContext).toContain("MCP Gateway");
    expect(onDeviceB.status.persona.profile.language_style).toMatchObject({
      content: "Prefer concise Chinese technical answers",
      sourceEventIds: ["persona-language-style"],
    });
    expect(JSON.stringify(await clientA.getStatusSnapshot())).not.toContain(
      "Prefer concise Chinese technical answers",
    );
  });

  it("reapplies concurrent mutations after a version conflict", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const account = {
      email: "conflict@example.test",
      password: "long demo password",
    };
    const key = generateStatusKey();
    const first = await anonymous.register(
      { ...account, deviceName: "A" },
      key,
    );
    const second = await anonymous.login({ ...account, deviceName: "B" });
    const vaultA = new OneStatusClient({ baseUrl, token: first.token }).createVault(key);
    const vaultB = new OneStatusClient({ baseUrl, token: second.token }).createVault(key);

    await Promise.all([
      vaultA.mutate((status) => {
        status.preferences.packageManager = "pnpm";
      }),
      vaultB.mutate((status) => {
        status.preferences.outputStyle = "concise";
      }),
    ]);

    const final = await vaultA.read();
    expect(final.status.preferences).toEqual({
      packageManager: "pnpm",
      outputStyle: "concise",
    });
  });

  it("isolates encrypted status by authenticated account", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const key = generateStatusKey();
    const first = await anonymous.register(
      {
        email: "first@example.test",
        password: "first account password",
        deviceName: "First device",
      },
      key,
    );
    const second = await anonymous.register(
      {
        email: "second@example.test",
        password: "second account password",
        deviceName: "Second device",
      },
      key,
    );
    const firstVault = new OneStatusClient({
      baseUrl,
      token: first.token,
    }).createVault(key);
    const secondVault = new OneStatusClient({
      baseUrl,
      token: second.token,
    }).createVault(key);

    await firstVault.mutate((status) => {
      status.preferences.privateValue = "first-account-only";
    });

    expect((await secondVault.read()).status.preferences).toEqual({});
  });

  it("logs out through the SDK and invalidates the device token", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const account = await anonymous.register(
      {
        email: "sdk-logout@example.test",
        password: "sdk logout password",
        deviceName: "Logout device",
      },
      generateStatusKey(),
    );
    const authenticated = new OneStatusClient({
      baseUrl,
      token: account.token,
    });

    await expect(authenticated.logout()).resolves.toEqual({ revoked: true });
    await expect(authenticated.getStatusSnapshot()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("refreshes device presence through the SDK", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const account = await anonymous.register(
      {
        email: "heartbeat@example.test",
        password: "heartbeat account password",
        deviceName: "Heartbeat device",
        installationId: "aa78fc78-45a7-4d46-9079-7fe45265d1c0",
      },
      generateStatusKey(),
    );
    const authenticated = new OneStatusClient({
      baseUrl,
      token: account.token,
    });

    await expect(authenticated.heartbeat()).resolves.toMatchObject({
      deviceId: account.deviceId,
    });
  });

  it("deduplicates a mutation when the committed response is lost", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const key = generateStatusKey();
    const account = await anonymous.register(
      {
        email: "response-loss@example.test",
        password: "response loss password",
        deviceName: "Lossy device",
      },
      key,
    );
    let dropPutResponse = true;
    const lossyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "PUT" && dropPutResponse) {
        dropPutResponse = false;
        throw new TypeError("simulated response loss");
      }
      return response;
    };
    const vault = new OneStatusClient({
      baseUrl,
      token: account.token,
      fetch: lossyFetch,
    }).createVault(key);

    const result = await vault.mutate(
      (status) => {
        status.memory.push({
          id: "stable-memory-id",
          scope: "user",
          content: "Remember exactly once",
          tags: [],
          state: "confirmed",
          createdAt: "2026-08-08T10:00:00.000Z",
          updatedAt: "2026-08-08T10:00:00.000Z",
        });
      },
      { mutationId: "696fae31-55fd-4a6e-9bd7-90bc3a35fcdb" },
    );

    expect(result.version).toBe(2);
    expect(result.status.memory).toHaveLength(1);
    expect((await vault.read()).status.memory).toHaveLength(1);
  });

  it("recovers an atomically initialized vault after registration response loss", async () => {
    const key = generateStatusKey();
    const account = {
      email: "registration-loss@example.test",
      password: "registration loss password",
      deviceName: "First device",
    };
    const lossyRegisterFetch: typeof fetch = async (input, init) => {
      await fetch(input, init);
      throw new TypeError("simulated registration response loss");
    };
    const lossyClient = new OneStatusClient({
      baseUrl,
      fetch: lossyRegisterFetch,
    });
    await expect(lossyClient.register(account, key)).rejects.toThrow(
      /registration response loss/,
    );

    const anonymous = new OneStatusClient({ baseUrl });
    const session = await anonymous.login({
      ...account,
      deviceName: "Recovery device",
    });
    const recovered = await new OneStatusClient({
      baseUrl,
      token: session.token,
    })
      .createVault(key)
      .read();
    expect(recovered.version).toBe(1);
    expect(recovered.status).toMatchObject({ schemaVersion: 4 });
  });

  it("deduplicates an explicitly retried append mutation", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const key = generateStatusKey();
    const account = await anonymous.register(
      {
        email: "manual-retry@example.test",
        password: "manual retry password",
        deviceName: "Retry device",
      },
      key,
    );
    const vault = new OneStatusClient({
      baseUrl,
      token: account.token,
    }).createVault(key);
    const mutationId = "4f46e1e4-cb4a-4c53-a4a0-a29aac94ad54";
    const mutationDigest = "m".repeat(43);
    const append = (status: Awaited<ReturnType<typeof vault.read>>["status"]) => {
      status.memory.push({
        id: mutationId,
        scope: "user",
        content: "One logical memory",
        tags: [],
        state: "confirmed",
        createdAt: "2026-08-08T10:00:00.000Z",
        updatedAt: "2026-08-08T10:00:00.000Z",
      });
    };

    await vault.mutate(append, { mutationId, mutationDigest });
    const duplicateResult = await vault.mutate(append, {
      mutationId,
      mutationDigest,
    });

    expect(duplicateResult.status.memory).toHaveLength(1);
    expect(duplicateResult.version).toBe(2);
  });

  it("rejects an old envelope presented as a newer revision", async () => {
    const anonymous = new OneStatusClient({ baseUrl });
    const key = generateStatusKey();
    const account = await anonymous.register(
      {
        email: "replay@example.test",
        password: "replay defense password",
        deviceName: "Replay device",
      },
      key,
    );
    const client = new OneStatusClient({ baseUrl, token: account.token });
    const vault = client.createVault(key);
    await vault.mutate((status) => {
      status.preferences.revision = 1;
    });
    const oldSnapshot = await client.getStatusSnapshot();
    await vault.mutate((status) => {
      status.preferences.revision = 2;
    });

    const replayFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === undefined || init.method === "GET") {
        const body = await response.json();
        if (String(input).endsWith("/v1/status")) {
          body.envelope = oldSnapshot.envelope;
        }
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const replayedVault = new OneStatusClient({
      baseUrl,
      token: account.token,
      fetch: replayFetch,
    }).createVault(key);

    await expect(replayedVault.read()).rejects.toBeInstanceOf(StatusDecryptionError);
  });

  it("refuses an account without an initialized encrypted vault", async () => {
    const emptyFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ version: 0, envelope: null, updatedAt: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const vault = new OneStatusClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "legacy-session",
      fetch: emptyFetch,
    }).createVault(generateStatusKey());

    await expect(vault.read()).rejects.toBeInstanceOf(StatusNotInitializedError);
  });

  it("requires HTTPS away from loopback addresses", () => {
    expect(
      () => new OneStatusClient({ baseUrl: "http://status.example.test" }),
    ).toThrow(/requires HTTPS/);
  });

  it("times out an unresponsive API request", async () => {
    const hangingFetch: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const client = new OneStatusClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "session",
      fetch: hangingFetch,
      requestTimeoutMs: 5,
    });

    await expect(client.getStatusSnapshot()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});
