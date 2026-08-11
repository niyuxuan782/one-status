import { describe, expect, it, vi } from "vitest";
import {
  CloudVaultDecryptionError,
  decryptCloudVaultSecrets,
  encryptCloudVaultSecrets,
} from "./crypto.js";
import {
  FakeCloudVaultKmsProvider,
  TencentCloudKmsHttpProvider,
  TencentCloudKmsSdkProvider,
  tencentCloudAuthorization,
  verifyCloudVaultKmsAccess,
  type CloudVaultKmsProvider,
  type TencentCloudKmsSdkClient,
} from "./kms.js";

describe("Cloud Vault KMS providers", () => {
  it("verifies GenerateDataKey and Decrypt before Vault becomes ready", async () => {
    const generatedKey = new Uint8Array(32).fill(17);
    const unwrappedKey = new Uint8Array(32).fill(17);
    const kms: CloudVaultKmsProvider = {
      providerId: "readiness-test-kms",
      async generateDataKey(context) {
        expect(context).toEqual({
          purpose: "one-status-cloud-vault-kms-readiness-v1",
        });
        return {
          keyId: "readiness-key",
          plaintextKey: generatedKey,
          wrappedKey: "wrapped-readiness-key",
        };
      },
      async unwrapDataKey(input) {
        expect(input).toMatchObject({
          context: {
            purpose: "one-status-cloud-vault-kms-readiness-v1",
          },
          keyId: "readiness-key",
          wrappedKey: "wrapped-readiness-key",
        });
        return unwrappedKey;
      },
    };

    await expect(verifyCloudVaultKmsAccess(kms)).resolves.toBeUndefined();
    expect(generatedKey).toEqual(new Uint8Array(32));
    expect(unwrappedKey).toEqual(new Uint8Array(32));
  });

  it("rejects a KMS readiness round trip that returns another key", async () => {
    const kms: CloudVaultKmsProvider = {
      providerId: "mismatch-test-kms",
      async generateDataKey() {
        return {
          keyId: "readiness-key",
          plaintextKey: new Uint8Array(32).fill(1),
          wrappedKey: "wrapped-readiness-key",
        };
      },
      async unwrapDataKey() {
        return new Uint8Array(32).fill(2);
      },
    };

    await expect(verifyCloudVaultKmsAccess(kms)).rejects.toThrow(
      "Cloud Vault KMS operation failed",
    );
  });

  it("binds Fake KMS wrapped keys and ciphertext to the credential context", async () => {
    const kms = new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(3));
    const envelope = await encryptCloudVaultSecrets({
      credentialId: "credential-1",
      kms,
      revision: 1,
      secrets: { password: "private-value" },
      userId: "user-1",
    });

    await expect(
      decryptCloudVaultSecrets({
        credentialId: "credential-1",
        envelope,
        kms,
        revision: 1,
        userId: "user-1",
      }),
    ).resolves.toEqual({ password: "private-value" });
    await expect(
      decryptCloudVaultSecrets({
        credentialId: "credential-2",
        envelope,
        kms,
        revision: 1,
        userId: "user-1",
      }),
    ).rejects.toBeInstanceOf(CloudVaultDecryptionError);
    expect(JSON.stringify(envelope)).not.toContain("private-value");
  });

  it("adapts the official Tencent Cloud KMS SDK client", async () => {
    const plaintext = Buffer.alloc(32, 7).toString("base64");
    const client: TencentCloudKmsSdkClient = {
      Decrypt: vi.fn(async () => ({
        KeyId: "tencent-key-1",
        Plaintext: plaintext,
      })),
      GenerateDataKey: vi.fn(async () => ({
        CiphertextBlob: "wrapped-by-tencent-kms",
        KeyId: "tencent-key-1",
        Plaintext: plaintext,
      })),
    };
    const kms = new TencentCloudKmsSdkProvider({
      client,
      keyId: "tencent-key-1",
    });
    const context = {
      credentialId: "credential-1",
      purpose: "one-status-cloud-vault-dek-v1",
      revision: "1",
      userId: "user-1",
    };

    const generated = await kms.generateDataKey(context);
    expect(generated).toMatchObject({
      keyId: "tencent-key-1",
      wrappedKey: "wrapped-by-tencent-kms",
    });
    expect(generated.plaintextKey).toEqual(new Uint8Array(32).fill(7));
    await expect(
      kms.unwrapDataKey({
        context,
        keyId: generated.keyId,
        wrappedKey: generated.wrappedKey,
      }),
    ).resolves.toEqual(new Uint8Array(32).fill(7));
    expect(client.GenerateDataKey).toHaveBeenCalledWith(
      expect.objectContaining({
        EncryptionContext: expect.stringContaining('"credentialId"'),
        KeyId: "tencent-key-1",
        KeySpec: "AES_256",
      }),
    );
  });

  it("calls Tencent KMS HTTP API with TC3 signing and no credential fallback", async () => {
    const requests: Array<{ action: string; authorization: string; body: string }> = [];
    const plaintext = Buffer.alloc(32, 11).toString("base64");
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const action = headers.get("X-TC-Action") ?? "";
      requests.push({
        action,
        authorization: headers.get("Authorization") ?? "",
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          Response:
            action === "GenerateDataKey"
              ? {
                  CiphertextBlob: "http-wrapped-key",
                  KeyId: "tencent-key-http",
                  Plaintext: plaintext,
                  RequestId: "request-generate",
                }
              : {
                  KeyId: "tencent-key-http",
                  Plaintext: plaintext,
                  RequestId: "request-decrypt",
                },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    const kms = new TencentCloudKmsHttpProvider({
      fetch: request as typeof fetch,
      keyId: "tencent-key-http",
      now: () => new Date("2026-08-11T04:30:00.000Z"),
      region: "ap-guangzhou",
      secretId: "AKIDEXAMPLE",
      secretKey: "private-signing-value",
    });
    const context = {
      credentialId: "credential-http",
      purpose: "one-status-cloud-vault-dek-v1",
      revision: "1",
      userId: "user-1",
    };

    const generated = await kms.generateDataKey(context);
    await expect(
      kms.unwrapDataKey({
        context,
        keyId: generated.keyId,
        wrappedKey: generated.wrappedKey,
      }),
    ).resolves.toEqual(new Uint8Array(32).fill(11));
    expect(requests.map((entry) => entry.action)).toEqual([
      "GenerateDataKey",
      "Decrypt",
    ]);
    for (const entry of requests) {
      expect(entry.authorization).toMatch(
        /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2026-08-11\/kms\/tc3_request,/,
      );
      expect(entry.authorization).not.toContain("private-signing-value");
      expect(entry.body).toContain('"EncryptionContext"');
    }
    expect(
      () =>
        new TencentCloudKmsHttpProvider({
          keyId: "key",
          region: "ap-guangzhou",
          secretId: "id",
          secretKey: "",
        }),
    ).toThrow("Tencent Cloud SecretKey is invalid");
  });

  it("generates a stable TC3 Authorization value", () => {
    const authorization = tencentCloudAuthorization({
      action: "GenerateDataKey",
      body: '{"KeyId":"key-1"}',
      host: "kms.tencentcloudapi.com",
      secretId: "AKIDEXAMPLE",
      secretKey: "SECRET",
      timestamp: 1_786_422_600,
    });
    expect(authorization).toContain(
      "SignedHeaders=content-type;host;x-tc-action",
    );
    expect(authorization).toMatch(/Signature=[a-f0-9]{64}$/);
  });
});
