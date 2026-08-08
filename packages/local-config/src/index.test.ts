import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteLocalProfile,
  KeychainCommandError,
  type KeychainRunner,
  loadOrCreateInstallationId,
  loadLocalProfile,
  prepareLocalProfileStorage,
  readSecretEnvironment,
  saveLocalProfile,
} from "./index.js";

const profile = {
  version: 1 as const,
  baseUrl: "http://127.0.0.1:8787",
  userId: "user-1",
  deviceId: "device-1",
  deviceName: "Mac A",
  token: "session-token",
  tokenExpiresAt: "2026-09-08T10:00:00.000Z",
  statusKey: `os1_${"a".repeat(43)}`,
};

describe("local profile", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("writes credentials atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "nested", "profile.json");
    await saveLocalProfile(profile, path);

    expect(await loadLocalProfile(path)).toEqual(profile);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("memory");
  });

  it("fails storage preparation before an account operation when the path is blocked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const blockingFile = join(directory, "blocked");
    await writeFile(blockingFile, "not a directory", "utf8");

    await expect(
      prepareLocalProfileStorage(join(blockingFile, "profile.json")),
    ).rejects.toThrow();
  });

  it("protects an existing profile from registration overwrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    await writeFile(path, "existing profile", "utf8");

    await expect(prepareLocalProfileStorage(path, true)).rejects.toThrow(
      /already exists/,
    );
  });

  it("deletes the local credential profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    await writeFile(path, "temporary profile", "utf8");

    await deleteLocalProfile(path);

    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a stable owner-only installation ID after profile deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const profilePath = join(directory, "profile.json");
    const installationPath = join(directory, "installation-id");
    const legacyDeviceId = "18f6680f-79de-4df6-8d88-08e66ddfbb53";

    const first = await loadOrCreateInstallationId(
      legacyDeviceId,
      installationPath,
    );
    await writeFile(profilePath, "temporary profile", "utf8");
    await deleteLocalProfile(profilePath);
    const second = await loadOrCreateInstallationId(undefined, installationPath);

    expect(first).toBe(legacyDeviceId);
    expect(second).toBe(first);
    expect((await stat(installationPath)).mode & 0o777).toBe(0o600);
  });

  it("converges concurrent installation ID creation on one value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const installationPath = join(directory, "installation-id");

    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadOrCreateInstallationId(undefined, installationPath),
      ),
    );

    expect(new Set(ids).size).toBe(1);
  });

  it("reads a secret from a file without allowing ambiguous sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "secret");
    await writeFile(path, "secret-value\n", "utf8");

    await expect(
      readSecretEnvironment("ONE_STATUS_TOKEN", {
        ONE_STATUS_TOKEN_FILE: path,
      }),
    ).resolves.toBe("secret-value");
    await expect(
      readSecretEnvironment("ONE_STATUS_TOKEN", {
        ONE_STATUS_TOKEN: "direct",
        ONE_STATUS_TOKEN_FILE: path,
      }),
    ).rejects.toThrow(/cannot both be set/);
  });

  it("stores the default macOS profile secrets in Keychain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "one-status", "profile.json");
    const runner = new MemoryKeychainRunner();
    const options = macOptions(path, runner);

    await saveLocalProfile(profile, undefined, options);

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(profile.token);
    expect(persisted).not.toContain(profile.statusKey);
    expect(JSON.parse(persisted)).toMatchObject({
      version: 2,
      credentials: {
        service: "com.furesta.one-status.profile",
        type: "macos-keychain",
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "one-status"))).mode & 0o777).toBe(
      0o700,
    );
    expect(await loadLocalProfile(undefined, options)).toEqual(profile);

    const add = runner.calls.find(
      (call) => call.command === "/usr/bin/expect",
    );
    expect(add?.command).toBe("/usr/bin/expect");
    expect(add?.args).not.toContain(profile.token);
    expect(add?.args).not.toContain(profile.statusKey);
    expect(add?.input).toContain(profile.token);
    expect(add?.input).toContain(profile.statusKey);
    const encodedSecret = add?.input?.split("\n")[1] ?? "";
    expect(Buffer.byteLength(encodedSecret, "utf8")).toBeLessThan(128);
  });

  it("rejects credentials that exceed the interactive Keychain limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "one-status", "profile.json");
    const runner = new MemoryKeychainRunner();

    await expect(
      saveLocalProfile(
        { ...profile, token: "t".repeat(100) },
        undefined,
        macOptions(path, runner),
      ),
    ).rejects.toThrow(/Keychain input limit/);
    expect(runner.calls).toEqual([]);
  });

  it("atomically migrates a legacy plaintext macOS profile on first read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    const runner = new MemoryKeychainRunner();
    const options = macOptions(path, runner);
    await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, {
      mode: 0o644,
    });

    await expect(loadLocalProfile(undefined, options)).resolves.toEqual(profile);

    const migrated = await readFile(path, "utf8");
    expect(JSON.parse(migrated).version).toBe(2);
    expect(migrated).not.toContain(profile.token);
    expect(migrated).not.toContain(profile.statusKey);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(runner.secrets.size).toBe(1);
  });

  it("leaves a legacy profile intact when Keychain migration fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    const runner = new MemoryKeychainRunner();
    const options = macOptions(path, runner);
    const legacy = `${JSON.stringify(profile, null, 2)}\n`;
    await writeFile(path, legacy, { mode: 0o600 });
    runner.failNextAdd = true;

    await expect(loadLocalProfile(undefined, options)).rejects.toThrow(
      "injected Keychain add failure",
    );
    expect(await readFile(path, "utf8")).toBe(legacy);
    expect(runner.secrets.size).toBe(0);
  });

  it("rolls back an update when the old Keychain item cannot be deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    const runner = new MemoryKeychainRunner();
    const options = macOptions(path, runner);
    await saveLocalProfile(profile, undefined, options);
    const previousFile = await readFile(path, "utf8");
    const previousAccount = JSON.parse(previousFile).credentials.account as string;
    runner.failDeleteAccounts.add(previousAccount);

    await expect(
      saveLocalProfile(
        { ...profile, token: "replacement-session-token" },
        undefined,
        options,
      ),
    ).rejects.toThrow("injected Keychain delete failure");

    expect(await readFile(path, "utf8")).toBe(previousFile);
    expect(runner.secrets.has(previousAccount)).toBe(true);
    expect(runner.secrets.size).toBe(1);
    expect(await loadLocalProfile(undefined, options)).toEqual(profile);
  });

  it("deletes the Keychain item and profile together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    const runner = new MemoryKeychainRunner();
    const options = macOptions(path, runner);
    await saveLocalProfile(profile, undefined, options);
    const account = JSON.parse(await readFile(path, "utf8")).credentials
      .account as string;

    await deleteLocalProfile(undefined, options);

    expect(runner.secrets.has(account)).toBe(false);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps explicit profile paths in portable file mode on macOS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-profile-"));
    directories.push(directory);
    const path = join(directory, "profile.json");
    const runner = new MemoryKeychainRunner();

    await saveLocalProfile(profile, path, {
      keychainRunner: runner,
      platform: "darwin",
    });

    expect(await loadLocalProfile(path, { platform: "darwin" })).toEqual(
      profile,
    );
    expect(await readFile(path, "utf8")).toContain(profile.token);
    expect(runner.calls).toEqual([]);
  });
});

interface RunnerCall {
  args: readonly string[];
  command: string;
  input?: string;
}

class MemoryKeychainRunner implements KeychainRunner {
  readonly calls: RunnerCall[] = [];
  readonly failDeleteAccounts = new Set<string>();
  readonly secrets = new Map<string, string>();
  failNextAdd = false;

  async run(
    command: string,
    args: readonly string[],
    options?: { input?: string },
  ): Promise<{ stdout: string }> {
    this.calls.push({ command, args: [...args], input: options?.input });
    if (command === "/usr/bin/expect") {
      const separator = options?.input?.indexOf("\n") ?? -1;
      const account = options?.input?.slice(0, separator);
      const secret = options?.input?.slice(separator + 1).trim();
      if (!account || !secret) throw new Error("Invalid Keychain write input.");
      if (this.failNextAdd) {
        this.failNextAdd = false;
        throw new Error("injected Keychain add failure");
      }
      this.secrets.set(account, secret);
      return { stdout: "" };
    }
    const account = argumentAfter(args, "-a");
    if (args[0] === "find-generic-password") {
      const secret = this.secrets.get(account);
      if (!secret) throw new KeychainCommandError(44);
      return { stdout: `${secret}\n` };
    }
    if (args[0] === "delete-generic-password") {
      if (this.failDeleteAccounts.has(account)) {
        throw new Error("injected Keychain delete failure");
      }
      if (!this.secrets.delete(account)) throw new KeychainCommandError(44);
      return { stdout: "" };
    }
    throw new Error(`Unexpected Keychain command: ${String(args[0])}`);
  }
}

function macOptions(path: string, runner: KeychainRunner) {
  return {
    defaultProfilePath: path,
    keychainRunner: runner,
    platform: "darwin" as const,
  };
}

function argumentAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || !value) throw new Error(`Missing ${flag} argument.`);
  return value;
}
