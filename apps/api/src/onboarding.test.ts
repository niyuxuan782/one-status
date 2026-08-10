import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { LocalOnboardingService } from "./onboarding.js";
import {
  encryptStatus,
  exportStatusKey,
  generateStatusKey,
} from "@one-status/crypto";
import { saveLocalProfile } from "@one-status/local-config";
import { createEmptyStatus } from "@one-status/protocol";

describe("local graphical onboarding", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("registers one device and restores encrypted status with account credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-onboarding-"));
    directories.push(directory);
    const app = createApp({ dbPath: join(directory, "sync.sqlite") });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const firstHome = join(directory, "device-a");
    vi.stubEnv("ONE_STATUS_HOME", firstHome);
    const first = new LocalOnboardingService(serverUrl);
    await expect(first.status()).resolves.toMatchObject({ authenticated: false });
    const registered = await first.register({
      deviceName: "Mac A",
      email: "ryan@example.test",
      password: "correct horse battery staple",
      serverUrl,
    });
    await expect(first.status()).resolves.toMatchObject({
      authenticated: true,
      profile: { deviceName: "Mac A", serverUrl },
    });
    const firstProfile = await readFile(join(firstHome, "profile.json"), "utf8");
    expect(firstProfile).not.toContain("correct horse battery staple");
    expect((await stat(join(firstHome, "profile.json"))).mode & 0o777).toBe(0o600);

    const secondHome = join(directory, "device-b");
    vi.stubEnv("ONE_STATUS_HOME", secondHome);
    const second = new LocalOnboardingService(serverUrl);
    await expect(
      second.login({
        deviceName: "Mac B",
        email: "ryan@example.test",
        password: "correct horse battery staple",
        serverUrl,
      }),
    ).resolves.toMatchObject({ userId: registered.userId });
    await expect(second.status()).resolves.toMatchObject({
      authenticated: true,
      profile: { deviceName: "Mac B", serverUrl },
    });
    await app.close();
  });

  it("automatically migrates a legacy account from its existing local profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-migration-"));
    directories.push(directory);
    const app = createApp({ dbPath: join(directory, "sync.sqlite") });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const statusKey = generateStatusKey();
    const installationId = "ad266e46-4538-46c5-b98d-03a419829c0c";
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        deviceName: "Legacy Mac",
        email: "legacy-onboarding@example.test",
        initialEnvelope: encryptStatus(createEmptyStatus(), statusKey, 1),
        installationId,
        password: "legacy onboarding password",
      },
    });
    const legacy = registration.json();

    const firstHome = join(directory, "device-a");
    vi.stubEnv("ONE_STATUS_HOME", firstHome);
    await saveLocalProfile({
      baseUrl: serverUrl,
      deviceId: installationId,
      deviceName: "Legacy Mac",
      statusKey: exportStatusKey(statusKey),
      token: legacy.token,
      tokenExpiresAt: legacy.expiresAt,
      userId: legacy.userId,
      version: 1,
    });
    const first = new LocalOnboardingService(serverUrl);
    await expect(
      first.login({
        deviceName: "Legacy Mac",
        email: "legacy-onboarding@example.test",
        password: "legacy onboarding password",
        serverUrl,
      }),
    ).resolves.toMatchObject({ userId: legacy.userId });

    const secondHome = join(directory, "device-b");
    vi.stubEnv("ONE_STATUS_HOME", secondHome);
    const second = new LocalOnboardingService(serverUrl);
    await expect(
      second.login({
        deviceName: "New Mac",
        email: "legacy-onboarding@example.test",
        password: "legacy onboarding password",
        serverUrl,
      }),
    ).resolves.toMatchObject({ userId: legacy.userId });
    await app.close();
  });
});
