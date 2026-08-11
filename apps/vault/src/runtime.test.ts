import { describe, expect, it } from "vitest";
import { loadVaultRuntimeConfig } from "./runtime.js";

describe("Vault Service production configuration", () => {
  it("loads PostgreSQL and Tencent Cloud KMS only from explicit env", () => {
    expect(
      loadVaultRuntimeConfig({
        ONE_STATUS_VAULT_DATABASE_MAX_CONNECTIONS: "20",
        ONE_STATUS_VAULT_DATABASE_SSL: "verify-full",
        ONE_STATUS_VAULT_DATABASE_URL:
          "postgresql://vault@postgres.internal/one_status",
        ONE_STATUS_VAULT_HOST: "10.0.0.8",
        ONE_STATUS_VAULT_KMS_KEY_ID: "kms-key-id",
        ONE_STATUS_VAULT_KMS_REGION: "ap-guangzhou",
        ONE_STATUS_VAULT_MIGRATE: "true",
        ONE_STATUS_VAULT_OPAQUE_SERVER_SETUP: "opaque-wallet-server-setup",
        ONE_STATUS_VAULT_PORT: "8791",
        ONE_STATUS_VAULT_SERVICE_TOKEN:
          "service-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        TENCENTCLOUD_SECRET_ID: "AKIDEXAMPLE",
        TENCENTCLOUD_SECRET_KEY: "tencent-private-secret",
      }),
    ).toMatchObject({
      databaseMaxConnections: 20,
      databaseSsl: "verify-full",
      host: "10.0.0.8",
      kmsKeyId: "kms-key-id",
      kmsRegion: "ap-guangzhou",
      migrate: true,
      port: 8791,
      walletOpaqueServerSetup: "opaque-wallet-server-setup",
    });
  });

  it("refuses startup when PostgreSQL, KMS, or service credentials are absent", () => {
    expect(() => loadVaultRuntimeConfig({})).toThrow(
      "ONE_STATUS_VAULT_DATABASE_URL is required",
    );
    expect(() =>
      loadVaultRuntimeConfig({
        ONE_STATUS_VAULT_DATABASE_URL: "sqlite:///tmp/vault.db",
      }),
    ).toThrow("must use PostgreSQL");
    expect(() =>
      loadVaultRuntimeConfig({
        ONE_STATUS_VAULT_DATABASE_URL:
          "postgresql://vault@postgres.internal/one_status",
      }),
    ).toThrow("ONE_STATUS_VAULT_KMS_KEY_ID is required");
  });
});
