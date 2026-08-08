import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { LocalOnboardingService } from "./onboarding.js";

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

  it("registers one device and restores the encrypted status on another", async () => {
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
    expect(registered.statusKey).toMatch(/^os1_/);
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
        statusKey: registered.statusKey,
      }),
    ).resolves.toMatchObject({ userId: registered.userId });
    await expect(second.status()).resolves.toMatchObject({
      authenticated: true,
      profile: { deviceName: "Mac B", serverUrl },
    });
    await app.close();
  });
});
