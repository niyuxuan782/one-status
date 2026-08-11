import { describe, expect, it, vi } from "vitest";
import {
  CloudVaultDecryptionError,
  decryptCloudVaultSecrets,
  encryptCloudVaultSecrets,
} from "./crypto.js";
import {
  FakeCloudVaultKmsProvider,
  SelfHostedCloudVaultKekProvider,
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

  it("wraps each DEK with the self-hosted KEK and a versioned provider envelope", async () => {
    const kms = new SelfHostedCloudVaultKekProvider({
      kek: new Uint8Array(32).fill(29),
      keyId: "one-status-production-v1",
    });
    const context = {
      credentialId: "credential-self-hosted",
      purpose: "one-status-cloud-vault-dek-v1",
      revision: "1",
      userId: "user-1",
    };

    const first = await kms.generateDataKey(context);
    const second = await kms.generateDataKey(context);

    expect(first.keyId).toBe("one-status-production-v1");
    expect(first.wrappedKey).toMatch(/^oswk1\.self-hosted-kek\./);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.plaintextKey).not.toEqual(second.plaintextKey);
    const encodedEnvelope = first.wrappedKey.split(".").at(-1) ?? "";
    expect(
      JSON.parse(Buffer.from(encodedEnvelope, "base64url").toString("utf8")),
    ).toMatchObject({
      algorithm: "A256GCM",
      keyId: "one-status-production-v1",
      provider: "self-hosted-kek",
      version: 1,
    });
    await expect(
      kms.unwrapDataKey({
        context,
        keyId: first.keyId,
        wrappedKey: first.wrappedKey,
      }),
    ).resolves.toEqual(new Uint8Array(first.plaintextKey));
  });

  it("rejects self-hosted wrapped DEKs with changed context, key ID, or bytes", async () => {
    const kms = new SelfHostedCloudVaultKekProvider({
      kek: new Uint8Array(32).fill(13),
      keyId: "one-status-production-v1",
    });
    const generated = await kms.generateDataKey({ purpose: "credential" });

    await expect(
      kms.unwrapDataKey({
        context: { purpose: "another-credential" },
        keyId: generated.keyId,
        wrappedKey: generated.wrappedKey,
      }),
    ).rejects.toMatchObject({ code: "self_hosted_unwrap_failed" });
    await expect(
      kms.unwrapDataKey({
        context: { purpose: "credential" },
        keyId: "rotated-key",
        wrappedKey: generated.wrappedKey,
      }),
    ).rejects.toMatchObject({ code: "self_hosted_key_id_mismatch" });
    await expect(
      kms.unwrapDataKey({
        context: { purpose: "credential" },
        keyId: generated.keyId,
        wrappedKey: `${generated.wrappedKey.slice(0, -1)}A`,
      }),
    ).rejects.toMatchObject({ code: "self_hosted_unwrap_failed" });
  });

  it("rejects oversized or malformed self-hosted wrapped DEK fields", async () => {
    const kms = new SelfHostedCloudVaultKekProvider({
      kek: new Uint8Array(32).fill(23),
      keyId: "one-status-production-v1",
    });
    const context = { purpose: "credential" };
    const generated = await kms.generateDataKey(context);
    try {
      await expect(
        kms.unwrapDataKey({
          context,
          keyId: generated.keyId,
          wrappedKey: `oswk1.self-hosted-kek.${"A".repeat(2_048)}`,
        }),
      ).rejects.toMatchObject({ code: "self_hosted_unwrap_failed" });
      await expect(
        kms.unwrapDataKey({
          context,
          keyId: generated.keyId,
          wrappedKey: rewriteSelfHostedEnvelope(generated.wrappedKey, {
            authTag: "A".repeat(21),
          }),
        }),
      ).rejects.toMatchObject({ code: "self_hosted_unwrap_failed" });
      await expect(
        kms.unwrapDataKey({
          context,
          keyId: generated.keyId,
          wrappedKey: rewriteSelfHostedEnvelope(generated.wrappedKey, {
            keyId: "invalid/key-id",
          }),
        }),
      ).rejects.toMatchObject({ code: "self_hosted_unwrap_failed" });
    } finally {
      generated.plaintextKey.fill(0);
      kms.destroy();
    }
  });

  it("limits self-hosted KEK IDs and rejects operations after destruction", async () => {
    const kek = new Uint8Array(32).fill(31);
    expect(
      () =>
        new SelfHostedCloudVaultKekProvider({
          kek,
          keyId: "x".repeat(257),
        }),
    ).toThrow("Self-hosted Vault KEK ID is invalid");
    expect(
      () =>
        new SelfHostedCloudVaultKekProvider({
          kek,
          keyId: "invalid/key-id",
        }),
    ).toThrow("Self-hosted Vault KEK ID is invalid");

    const kms = new SelfHostedCloudVaultKekProvider({
      kek,
      keyId: "one-status-production-v1",
    });
    const generated = await kms.generateDataKey({ purpose: "credential" });
    generated.plaintextKey.fill(0);
    kms.destroy();
    kms.destroy();
    await expect(
      kms.generateDataKey({ purpose: "credential" }),
    ).rejects.toMatchObject({ code: "self_hosted_provider_destroyed" });
    await expect(
      kms.unwrapDataKey({
        context: { purpose: "credential" },
        keyId: generated.keyId,
        wrappedKey: generated.wrappedKey,
      }),
    ).rejects.toMatchObject({ code: "self_hosted_provider_destroyed" });
  });

  it("cleans up a failed self-hosted generation and remains usable", async () => {
    const kms = new SelfHostedCloudVaultKekProvider({
      kek: new Uint8Array(32).fill(5),
      keyId: "one-status-production-v1",
    });
    const invalidContext = Object.defineProperty({}, "purpose", {
      enumerable: true,
      get() {
        throw new Error("context getter failed");
      },
    }) as Record<string, string>;

    await expect(kms.generateDataKey(invalidContext)).rejects.toMatchObject({
      code: "self_hosted_generate_failed",
    });
    const generated = await kms.generateDataKey({ purpose: "credential" });
    expect(generated.plaintextKey).toHaveLength(32);
    generated.plaintextKey.fill(0);
    kms.destroy();
  });

  it("uses the self-hosted provider for the full credential envelope", async () => {
    const kms = new SelfHostedCloudVaultKekProvider({
      kek: new Uint8Array(32).fill(7),
      keyId: "one-status-production-v1",
    });
    const envelope = await encryptCloudVaultSecrets({
      credentialId: "credential-1",
      kms,
      revision: 1,
      secrets: { token: "private-value" },
      userId: "user-1",
    });

    expect(envelope.kmsProvider).toBe("self-hosted-kek");
    expect(envelope.kmsKeyId).toBe("one-status-production-v1");
    expect(envelope.wrappedDek).toMatch(/^oswk1\.self-hosted-kek\./);
    await expect(
      decryptCloudVaultSecrets({
        credentialId: "credential-1",
        envelope,
        kms,
        revision: 1,
        userId: "user-1",
      }),
    ).resolves.toEqual({ token: "private-value" });
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

function rewriteSelfHostedEnvelope(
  wrappedKey: string,
  patch: Record<string, unknown>,
): string {
  const prefix = "oswk1.self-hosted-kek.";
  const encoded = wrappedKey.slice(prefix.length);
  const envelope = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  return (
    prefix +
    Buffer.from(JSON.stringify({ ...envelope, ...patch }), "utf8").toString(
      "base64url",
    )
  );
}
