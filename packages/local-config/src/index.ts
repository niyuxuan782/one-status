import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const localProfileSchema = z
  .object({
    version: z.literal(1),
    baseUrl: z.url(),
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    deviceName: z.string().min(1),
    token: z.string().min(1),
    tokenExpiresAt: z.iso.datetime({ offset: true }),
    statusKey: z.string().startsWith("os1_"),
  })
  .strict();

const KEYCHAIN_SERVICE = "com.furesta.one-status.profile";
const KEYCHAIN_LABEL = "One Status profile credentials";
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const KEYCHAIN_WRITE_SCRIPT = String.raw`
log_user 0
set timeout 15
set account [gets stdin]
set secret [gets stdin]
spawn -noecho /usr/bin/security add-generic-password -a $account -s {${KEYCHAIN_SERVICE}} -l {${KEYCHAIN_LABEL}} -U -w
expect {
  -re {(?i)password.*:} { send -- "$secret\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
set result [wait]
exit [lindex $result 3]
`;

const keychainReferenceSchema = z
  .object({
    account: z.string().regex(/^profile-[0-9a-f-]{36}$/),
    service: z.literal(KEYCHAIN_SERVICE),
    type: z.literal("macos-keychain"),
  })
  .strict();

const keychainProfileSchema = localProfileSchema
  .omit({ statusKey: true, token: true, version: true })
  .extend({
    version: z.literal(2),
    credentials: keychainReferenceSchema,
  })
  .strict();

const legacyKeychainSecretSchema = z
  .object({
    version: z.literal(1),
    token: z.string().min(1).max(32_000),
    statusKey: z.string().startsWith("os1_").max(500),
  })
  .strict();

const compactKeychainSecretSchema = z
  .object({
    k: z.string().startsWith("os1_").max(500),
    t: z.string().min(1).max(32_000),
    v: z.literal(1),
  })
  .strict();

export type LocalProfile = z.infer<typeof localProfileSchema>;
type KeychainProfile = z.infer<typeof keychainProfileSchema>;

export interface KeychainCommandResult {
  stdout: string;
}

export interface KeychainRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { input?: string },
  ): Promise<KeychainCommandResult>;
}

export interface LocalProfileStorageOptions {
  defaultProfilePath?: string;
  keychainRunner?: KeychainRunner;
  platform?: NodeJS.Platform;
}

export function resolveProfilePath(): string {
  if (process.env.ONE_STATUS_HOME) {
    return resolve(process.env.ONE_STATUS_HOME, "profile.json");
  }
  const configRoot =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configRoot, "one-status", "profile.json");
}

export function resolveInstallationIdPath(
  profilePath = resolveProfilePath(),
): string {
  return join(dirname(profilePath), "installation-id");
}

export async function loadOrCreateInstallationId(
  fallback?: string,
  path = resolveInstallationIdPath(),
): Promise<string> {
  try {
    return parseInstallationId(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const installationId = parseInstallationId(fallback ?? randomUUID());
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporaryPath, `${installationId}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);

  try {
    await link(temporaryPath, path);
  } catch (error) {
    if (!isFileAlreadyPresent(error)) throw error;
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  await chmod(path, 0o600);
  return parseInstallationId(await readFile(path, "utf8"));
}

export async function loadLocalProfile(
  path?: string,
  options: LocalProfileStorageOptions = {},
): Promise<LocalProfile> {
  const resolvedPath = profilePath(path, options);
  try {
    const serialized = await readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(serialized) as unknown;
    if (!usesKeychain(path, options)) {
      return localProfileSchema.parse(parsed);
    }

    const storedProfile = keychainProfileSchema.safeParse(parsed);
    if (storedProfile.success) {
      await chmod(resolvedPath, 0o600);
      return hydrateKeychainProfile(
        storedProfile.data,
        keychainRunner(options),
      );
    }

    const legacyProfile = localProfileSchema.parse(parsed);
    await saveKeychainProfile(
      legacyProfile,
      resolvedPath,
      keychainRunner(options),
      serialized,
    );
    return legacyProfile;
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(
        `One Status profile not found at ${resolvedPath}. Run the register or login command first.`,
      );
    }
    throw error;
  }
}

export async function saveLocalProfile(
  profileValue: LocalProfile,
  path?: string,
  options: LocalProfileStorageOptions = {},
): Promise<void> {
  const profile = localProfileSchema.parse(profileValue);
  const resolvedPath = profilePath(path, options);
  if (!usesKeychain(path, options)) {
    await writeProfileAtomically(resolvedPath, serialize(profile));
    return;
  }
  await saveKeychainProfile(
    profile,
    resolvedPath,
    keychainRunner(options),
  );
}

export async function deleteLocalProfile(
  path?: string,
  options: LocalProfileStorageOptions = {},
): Promise<void> {
  const resolvedPath = profilePath(path, options);
  if (usesKeychain(path, options)) {
    await deleteKeychainProfile(resolvedPath, keychainRunner(options));
    return;
  }
  try {
    await unlink(resolvedPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

export async function readSecretEnvironment(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const directValue = environment[name] || undefined;
  const filePath = environment[`${name}_FILE`] || undefined;
  if (directValue && filePath) {
    throw new Error(`${name} and ${name}_FILE cannot both be set.`);
  }
  if (!filePath) return directValue;
  const fileValue = (await readFile(filePath, "utf8")).trim();
  if (!fileValue) {
    throw new Error(`${name}_FILE points to an empty file.`);
  }
  return fileValue;
}

export async function prepareLocalProfileStorage(
  path = resolveProfilePath(),
  requireEmpty = false,
): Promise<void> {
  if (requireEmpty) {
    try {
      await stat(path);
      throw new Error(
        `A One Status profile already exists at ${path}. Use another ONE_STATUS_HOME for a new account or device.`,
      );
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
  const directory = dirname(path);
  const probePath = `${path}.${process.pid}.probe`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const probe = await open(probePath, "wx", 0o600);
  try {
    await probe.sync();
  } finally {
    await probe.close();
    await unlink(probePath);
  }
}

async function hydrateKeychainProfile(
  storedProfile: KeychainProfile,
  runner: KeychainRunner,
): Promise<LocalProfile> {
  const result = await runner.run("/usr/bin/security", [
    "find-generic-password",
    "-a",
    storedProfile.credentials.account,
    "-s",
    storedProfile.credentials.service,
    "-w",
  ]);
  let serializedSecret: unknown;
  try {
    serializedSecret = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("The One Status Keychain item is unreadable.");
  }
  const compactSecret = compactKeychainSecretSchema.safeParse(serializedSecret);
  const secret = compactSecret.success
    ? { statusKey: compactSecret.data.k, token: compactSecret.data.t }
    : legacyKeychainSecretSchema.parse(serializedSecret);
  return localProfileSchema.parse({
    version: 1,
    baseUrl: storedProfile.baseUrl,
    userId: storedProfile.userId,
    deviceId: storedProfile.deviceId,
    deviceName: storedProfile.deviceName,
    tokenExpiresAt: storedProfile.tokenExpiresAt,
    token: secret.token,
    statusKey: secret.statusKey,
  });
}

async function saveKeychainProfile(
  profile: LocalProfile,
  path: string,
  runner: KeychainRunner,
  existingSerialized?: string,
): Promise<void> {
  const previousSerialized =
    existingSerialized ?? (await readExistingProfile(path));
  const previous = previousSerialized
    ? parseExistingDefaultProfile(previousSerialized)
    : undefined;
  const account = `profile-${randomUUID()}`;
  const storedProfile = keychainProfileSchema.parse({
    version: 2,
    baseUrl: profile.baseUrl,
    userId: profile.userId,
    deviceId: profile.deviceId,
    deviceName: profile.deviceName,
    tokenExpiresAt: profile.tokenExpiresAt,
    credentials: {
      account,
      service: KEYCHAIN_SERVICE,
      type: "macos-keychain",
    },
  });
  const secret = compactKeychainSecretSchema.parse({
    k: profile.statusKey,
    t: profile.token,
    v: 1,
  });
  const serializedSecret = JSON.stringify(secret);
  if (Buffer.byteLength(serializedSecret, "utf8") >= 128) {
    throw new Error("One Status credentials exceed the macOS Keychain input limit.");
  }

  await addKeychainSecret(runner, account, serializedSecret);
  try {
    await writeProfileAtomically(path, serialize(storedProfile));
  } catch (error) {
    await deleteKeychainSecret(runner, account).catch(() => undefined);
    throw error;
  }

  if (previous?.version !== 2) return;
  try {
    await deleteKeychainSecret(runner, previous.credentials.account);
  } catch (error) {
    if (isKeychainItemMissing(error)) return;
    try {
      await writeProfileAtomically(path, previousSerialized!);
      await deleteKeychainSecret(runner, account).catch(() => undefined);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Keychain cleanup and profile rollback both failed.",
      );
    }
    throw error;
  }
}

async function deleteKeychainProfile(
  path: string,
  runner: KeychainRunner,
): Promise<void> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const parsed = parseExistingDefaultProfile(serialized);
  if (parsed.version === 1) {
    await unlink(path);
    return;
  }

  const tombstonePath = `${path}.${process.pid}.${randomUUID()}.deleting`;
  await rename(path, tombstonePath);
  try {
    await deleteKeychainSecret(runner, parsed.credentials.account);
  } catch (error) {
    if (!isKeychainItemMissing(error)) {
      try {
        await rename(tombstonePath, path);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Keychain deletion and profile rollback both failed.",
        );
      }
      throw error;
    }
  }
  await unlink(tombstonePath);
}

async function addKeychainSecret(
  runner: KeychainRunner,
  account: string,
  secret: string,
): Promise<void> {
  await runner.run(
    "/usr/bin/expect",
    ["-c", KEYCHAIN_WRITE_SCRIPT],
    { input: `${account}\n${secret}\n` },
  );
}

async function deleteKeychainSecret(
  runner: KeychainRunner,
  account: string,
): Promise<void> {
  await runner.run("/usr/bin/security", [
    "delete-generic-password",
    "-a",
    account,
    "-s",
    KEYCHAIN_SERVICE,
  ]);
}

function parseExistingDefaultProfile(
  serialized: string,
): LocalProfile | KeychainProfile {
  const parsed = JSON.parse(serialized) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "version" in parsed &&
    parsed.version === 2
  ) {
    return keychainProfileSchema.parse(parsed);
  }
  return localProfileSchema.parse(parsed);
}

async function readExistingProfile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeProfileAtomically(
  path: string,
  serialized: string,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function serialize(value: LocalProfile | KeychainProfile): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function profilePath(
  path: string | undefined,
  options: LocalProfileStorageOptions,
): string {
  return path ?? options.defaultProfilePath ?? resolveProfilePath();
}

function usesKeychain(
  path: string | undefined,
  options: LocalProfileStorageOptions,
): boolean {
  return (
    path === undefined &&
    !process.env.ONE_STATUS_HOME &&
    (options.platform ?? process.platform) === "darwin"
  );
}

function keychainRunner(options: LocalProfileStorageOptions): KeychainRunner {
  return options.keychainRunner ?? defaultKeychainRunner;
}

export class KeychainCommandError extends Error {
  constructor(readonly exitCode: number | null) {
    super("macOS Keychain command failed.");
    this.name = "KeychainCommandError";
  }
}

const defaultKeychainRunner: KeychainRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let outputTooLarge = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
          outputTooLarge = true;
          child.kill();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code) => {
        if (outputTooLarge) {
          reject(new Error("macOS Keychain command returned too much data."));
        } else if (code !== 0) {
          reject(new KeychainCommandError(code));
        } else {
          resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
        }
      });
      child.stdin.end(options.input ?? "");
    });
  },
};

function isKeychainItemMissing(error: unknown): boolean {
  return error instanceof KeychainCommandError && error.exitCode === 44;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isFileAlreadyPresent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function parseInstallationId(value: string): string {
  return z.uuid().parse(value.trim());
}
