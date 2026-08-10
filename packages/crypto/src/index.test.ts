import { describe, expect, it } from "vitest";
import { createEmptyStatus } from "@one-status/protocol";
import {
  decryptStatus,
  encryptStatus,
  exportStatusKey,
  generateStatusKey,
  importStatusKey,
  StatusDecryptionError,
  StatusKeyUnwrapError,
  unwrapStatusKey,
  wrapStatusKey,
} from "./index.js";

describe("status encryption", () => {
  it("round-trips a status document and internal Status Key", () => {
    const key = generateStatusKey();
    const importedKey = importStatusKey(exportStatusKey(key));
    const status = createEmptyStatus();
    status.preferences.packageManager = "pnpm";

    expect(
      decryptStatus(encryptStatus(status, importedKey, 1), importedKey, 1),
    ).toEqual(status);
  });

  it("rejects a different key", () => {
    const envelope = encryptStatus(createEmptyStatus(), generateStatusKey(), 1);
    expect(() => decryptStatus(envelope, generateStatusKey(), 1)).toThrow(
      StatusDecryptionError,
    );
  });

  it("rejects tampered ciphertext", () => {
    const key = generateStatusKey();
    const envelope = encryptStatus(createEmptyStatus(), key, 1);
    envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    expect(() => decryptStatus(envelope, key, 1)).toThrow(StatusDecryptionError);
  });

  it("binds ciphertext to its sync revision", () => {
    const key = generateStatusKey();
    const envelope = encryptStatus(createEmptyStatus(), key, 1);
    envelope.revision = 2;
    expect(() => decryptStatus(envelope, key, 2)).toThrow(StatusDecryptionError);
  });

  it("wraps a Status Key with the account password", async () => {
    const key = generateStatusKey();
    const wrapped = await wrapStatusKey(key, "correct horse battery staple");

    await expect(
      unwrapStatusKey(wrapped, "correct horse battery staple"),
    ).resolves.toEqual(key);
  });

  it("rejects an incorrect Status Key password", async () => {
    const wrapped = await wrapStatusKey(
      generateStatusKey(),
      "correct horse battery staple",
    );

    await expect(
      unwrapStatusKey(wrapped, "incorrect password value"),
    ).rejects.toBeInstanceOf(StatusKeyUnwrapError);
  });
});
