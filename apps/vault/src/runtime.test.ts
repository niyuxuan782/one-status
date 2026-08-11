import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVaultRuntimeConfig } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Vault Service production configuration", () => {
  it("loads PostgreSQL and the self-hosted KEK only from explicit env", () => {
    const config = loadVaultRuntimeConfig({
      ONE_STATUS_VAULT_DATABASE_MAX_CONNECTIONS: "20",
      ONE_STATUS_VAULT_DATABASE_SSL: "verify-full",
      ONE_STATUS_VAULT_DATABASE_URL:
        "postgresql://vault@postgres.internal/one_status",
      ONE_STATUS_VAULT_HOST: "10.0.0.8",
      ONE_STATUS_VAULT_KEK: Buffer.alloc(32, 17).toString("base64url"),
      ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
      ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      ONE_STATUS_VAULT_MIGRATE: "true",
      ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP: "opaque-wallet-server-setup",
      ONE_STATUS_VAULT_PORT: "8791",
      ONE_STATUS_VAULT_SERVICE_TOKEN:
        "service-token-0123456789-abcdefghijklmnopqrstuvwxyz",
    });
    expect(config).toMatchObject({
      databaseMaxConnections: 20,
      databaseSsl: "verify-full",
      host: "10.0.0.8",
      kms: {
        keyId: "one-status-production-v1",
        provider: "self-hosted",
      },
      migrate: true,
      port: 8791,
      walletOpaqueServerSetup: "opaque-wallet-server-setup",
    });
    expect(
      config.kms.provider === "self-hosted" &&
        new Uint8Array(config.kms.kek),
    ).toEqual(new Uint8Array(32).fill(17));
    if (config.kms.provider === "self-hosted") config.kms.kek.fill(0);
  });

  it("reads a self-hosted KEK from a private absolute Secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "one-status-vault-kek-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "vault-kek");
    writeFileSync(file, Buffer.alloc(32, 23).toString("base64url"), {
      mode: 0o600,
    });
    chmodSync(file, 0o600);

    const config = loadVaultRuntimeConfig({
      ...baseEnv(),
      ONE_STATUS_VAULT_KEK_FILE: file,
      ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
      ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
    });

    expect(
      config.kms.provider === "self-hosted" &&
        new Uint8Array(config.kms.kek),
    ).toEqual(new Uint8Array(32).fill(23));
    if (config.kms.provider === "self-hosted") config.kms.kek.fill(0);
    chmodSync(file, 0o644);
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK_FILE: file,
        ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("must reference a private regular file");
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK: Buffer.alloc(32, 23).toString("base64url"),
        ONE_STATUS_VAULT_KEK_FILE: file,
        ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("cannot both be set");
  });

  it("rejects symbolic links and oversized KEK Secret files", () => {
    const directory = mkdtempSync(join(tmpdir(), "one-status-vault-kek-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "vault-kek-target");
    const link = join(directory, "vault-kek-link");
    writeFileSync(target, Buffer.alloc(32, 29).toString("base64url"), {
      mode: 0o600,
    });
    symlinkSync(target, link);

    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK_FILE: link,
        ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("must reference a private regular file");

    const oversized = join(directory, "vault-kek-oversized");
    writeFileSync(oversized, "x".repeat(1_025), { mode: 0o600 });
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK_FILE: oversized,
        ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("must not exceed 1024 bytes");
  });

  it("clears a decoded KEK when its ID fails validation", () => {
    const encodedKek = Buffer.alloc(32, 31).toString("base64url");
    const from = vi.spyOn(Buffer, "from");

    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK: encodedKek,
        ONE_STATUS_VAULT_KEK_ID: "invalid kek id",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("must contain 1-256 ASCII");

    const decoded = from.mock.results[
      (from.mock.calls as unknown[][]).findIndex(
        ([value, encoding]) => value === encodedKek && encoding === "base64url",
      )
    ]?.value as Buffer | undefined;
    expect(decoded).toEqual(Buffer.alloc(32));
  });

  it("clears a decoded KEK when later runtime configuration fails", () => {
    const encodedKek = Buffer.alloc(32, 37).toString("base64url");
    const from = vi.spyOn(Buffer, "from");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      ONE_STATUS_VAULT_KEK: encodedKek,
      ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
      ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
    };
    delete env.ONE_STATUS_VAULT_SERVICE_TOKEN;

    expect(() => loadVaultRuntimeConfig(env)).toThrow(
      "ONE_STATUS_VAULT_SERVICE_TOKEN is required",
    );
    const decoded = from.mock.results[
      (from.mock.calls as unknown[][]).findIndex(
        ([value, encoding]) => value === encodedKek && encoding === "base64url",
      )
    ]?.value as Buffer | undefined;
    expect(decoded).toEqual(Buffer.alloc(32));
  });

  it("restricts KEK IDs to a bounded ASCII whitelist", () => {
    for (const keyId of ["contains space", "plus+sign", "a".repeat(257)]) {
      expect(() =>
        loadVaultRuntimeConfig({
          ...baseEnv(),
          ONE_STATUS_VAULT_KEK: Buffer.alloc(32, 41).toString("base64url"),
          ONE_STATUS_VAULT_KEK_ID: keyId,
          ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
        }),
      ).toThrow("must contain 1-256 ASCII");
    }
  });

  it("keeps Tencent KMS available through its explicit provider selection", () => {
    expect(
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KMS_KEY_ID: "kms-key-id",
        ONE_STATUS_VAULT_KMS_PROVIDER: "tencent-kms",
        ONE_STATUS_VAULT_KMS_REGION: "ap-guangzhou",
        TENCENTCLOUD_SECRET_ID: "AKIDEXAMPLE",
        TENCENTCLOUD_SECRET_KEY: "tencent-private-secret",
      }),
    ).toMatchObject({
      kms: {
        keyId: "kms-key-id",
        provider: "tencent-kms",
        region: "ap-guangzhou",
      },
    });
  });

  it("refuses startup when PostgreSQL, provider, or provider Secret is absent", () => {
    expect(() => loadVaultRuntimeConfig({})).toThrow(
      "ONE_STATUS_VAULT_DATABASE_URL is required",
    );
    expect(() =>
      loadVaultRuntimeConfig({
        ONE_STATUS_VAULT_DATABASE_URL: "sqlite:///tmp/vault.db",
      }),
    ).toThrow("must use PostgreSQL");
    expect(() => loadVaultRuntimeConfig(baseEnv())).toThrow(
      "ONE_STATUS_VAULT_KMS_PROVIDER is required",
    );
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KMS_PROVIDER: "local",
      }),
    ).toThrow("must be self-hosted or tencent-kms");
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("ONE_STATUS_VAULT_KEK is required");
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KEK: "too-short",
        ONE_STATUS_VAULT_KEK_ID: "one-status-production-v1",
        ONE_STATUS_VAULT_KMS_PROVIDER: "self-hosted",
      }),
    ).toThrow("must be an unpadded Base64URL 256-bit key");
    expect(() =>
      loadVaultRuntimeConfig({
        ...baseEnv(),
        ONE_STATUS_VAULT_KMS_KEY_ID: "kms-key-id",
        ONE_STATUS_VAULT_KMS_PROVIDER: "tencent-kms",
      }),
    ).toThrow("TENCENTCLOUD_REGION is required");
  });
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ONE_STATUS_VAULT_DATABASE_URL:
      "postgresql://vault@postgres.internal/one_status",
    ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP: "opaque-wallet-server-setup",
    ONE_STATUS_VAULT_SERVICE_TOKEN:
      "service-token-0123456789-abcdefghijklmnopqrstuvwxyz",
  };
}
