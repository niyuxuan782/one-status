import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opaqueServerPublicKey } from "./index.js";
import { loadOrCreateOpaqueServerSetup } from "./setup.js";

describe("OPAQUE server setup", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  it("persists one owner-only setup across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-opaque-"));
    directories.push(directory);
    const path = join(directory, "nested", "server.setup");
    const first = await loadOrCreateOpaqueServerSetup({ path });
    const second = await loadOrCreateOpaqueServerSetup({ path });

    expect(second).toBe(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
    await expect(opaqueServerPublicKey(first)).resolves.toBeTruthy();
    await expect(access(path)).resolves.toBeUndefined();
  });

  it("publishes one setup when callers race to initialize the same path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-opaque-race-"));
    directories.push(directory);
    const setupDirectory = join(directory, "nested");
    const path = join(setupDirectory, "server.setup");

    const setups = await Promise.all(
      Array.from({ length: 32 }, () =>
        loadOrCreateOpaqueServerSetup({ path }),
      ),
    );
    const winner = setups[0]!;

    expect(new Set(setups)).toEqual(new Set([winner]));
    expect((await readFile(path, "utf8")).trim()).toBe(winner);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(setupDirectory)).sort()).toEqual(["server.setup"]);
    await expect(opaqueServerPublicKey(winner)).resolves.toBeTruthy();
  });
});
