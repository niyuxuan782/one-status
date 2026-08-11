import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createOpaqueServerSetup,
  opaqueServerPublicKey,
} from "./index.js";

export async function loadOrCreateOpaqueServerSetup(input: {
  explicit?: string;
  path: string;
}): Promise<string> {
  const explicit = input.explicit?.trim();
  if (explicit) {
    await opaqueServerPublicKey(explicit);
    return explicit;
  }
  try {
    const existing = (await readFile(input.path, "utf8")).trim();
    await opaqueServerPublicKey(existing);
    await chmod(input.path, 0o600);
    return existing;
  } catch (error) {
    if (isMissing(error)) return createPersistedSetup(input.path);
    throw error;
  }
}

async function createPersistedSetup(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const setup = await createOpaqueServerSetup();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${setup}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // A same-directory hard link publishes a complete file without replacing
      // the setup selected by another process.
      await link(temporary, path);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const stored = (await readFile(path, "utf8")).trim();
    await opaqueServerPublicKey(stored);
    await chmod(path, 0o600);
    return stored;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
