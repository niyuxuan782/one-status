import { PermissionVault } from "../permission-vault.js";
import { describe, expect, it } from "vitest";
import { FakeCloudVaultKmsProvider } from "./kms.js";
import { MemoryCloudVaultRepository } from "./memory-repository.js";
import {
  CloudVaultDualWriteStore,
  CloudVaultMigrationCoordinator,
  LocalPermissionVaultMigrationAdapter,
  credentialSetDigest,
  type LegacyPermissionVaultStore,
} from "./migration.js";
import { CloudVaultService } from "./service.js";
import type { CloudVaultCredentialPlaintext } from "./types.js";

describe("Cloud Vault migration", () => {
  it("backfills, dual-writes, validates counts and keyed digests, then cuts over", async () => {
    const local = new MemoryLegacyStore([
      plainCredential("credential-a", "server-a", "password-a"),
      plainCredential("credential-b", "server-b", "password-b"),
    ]);
    const repository = new MemoryCloudVaultRepository();
    const cloud = new CloudVaultService({
      kms: new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(21)),
      repository,
    });
    const migration = new CloudVaultMigrationCoordinator({
      cloud,
      local,
      repository,
    });
    const dualWrite = new CloudVaultDualWriteStore({
      cloud,
      local,
      migration,
    });

    await expect(migration.backfill("user-1")).resolves.toMatchObject({
      cloudCount: 2,
      localCount: 2,
      state: "dual_write",
    });
    const updated = plainCredential(
      "credential-a",
      "server-a-new",
      "password-a-rotated",
    );
    await dualWrite.upsert(updated);
    expect((await local.listCredentials("user-1"))[0]).toMatchObject({
      fields: { host: "server-a-new.example", username: "ubuntu" },
      secrets: { password: "password-a-rotated" },
    });

    const verification = await migration.verify("user-1");
    expect(verification).toMatchObject({
      cloudCount: 2,
      countMatches: true,
      digestMatches: true,
      localCount: 2,
      matches: true,
    });
    expect(await migration.cutover("user-1")).toMatchObject({
      state: "cutover",
    });

    await dualWrite.upsert(
      plainCredential("credential-c", "server-c", "password-c"),
    );
    expect(await local.listCredentials("user-1")).toHaveLength(2);
    expect(await cloud.exportPlaintextForMigration("user-1")).toHaveLength(3);
    expect(JSON.stringify(await cloud.listAuditEvents("user-1"))).not.toContain(
      "password-a-rotated",
    );
  });

  it("moves to failed when validation detects a local/cloud mismatch", async () => {
    const local = new MemoryLegacyStore([
      plainCredential("credential-a", "server-a", "password-a"),
    ]);
    const repository = new MemoryCloudVaultRepository();
    const cloud = new CloudVaultService({
      kms: new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(22)),
      repository,
    });
    const migration = new CloudVaultMigrationCoordinator({
      cloud,
      local,
      repository,
    });
    await migration.backfill("user-1");
    await local.upsertCredential(
      plainCredential("credential-a", "server-a", "local-only-change"),
    );

    await expect(migration.verify("user-1")).resolves.toMatchObject({
      digestMatches: false,
      matches: false,
    });
    expect(await migration.status("user-1")).toMatchObject({
      failureCode: "verification_mismatch",
      state: "failed",
    });
  });

  it("adapts existing generic and model Permission Vault credentials", async () => {
    const vault = new PermissionVault({
      key: new Uint8Array(32).fill(23),
      path: ":memory:",
    });
    const generic = vault.upsertPrivateCredential({
      fields: { host: "server.example", username: "ubuntu" },
      kind: "ssh",
      label: "Server SSH",
      purposes: ["ssh.connect"],
      secrets: { password: "local-password" },
      userId: "user-1",
    });
    vault.setModelCredential("user-1", "model-source-a", "model-api-key");
    const adapter = new LocalPermissionVaultMigrationAdapter(vault);

    const listed = await adapter.listCredentials("user-1");
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: generic.id,
          secrets: { password: "local-password" },
        }),
        expect.objectContaining({
          fields: { sourceId: "model-source-a" },
          kind: "model",
          secrets: { apiKey: "model-api-key" },
        }),
      ]),
    );
    await adapter.deleteCredential("user-1", generic.id);
    expect(vault.listPrivateCredentials("user-1", { kinds: ["ssh"] })).toEqual(
      [],
    );
    vault.close();
  });

  it("uses a keyed order-independent digest", () => {
    const first = plainCredential("credential-a", "server-a", "password-a");
    const second = plainCredential("credential-b", "server-b", "password-b");
    const key = new Uint8Array(32).fill(24);
    expect(credentialSetDigest([first, second], key)).toBe(
      credentialSetDigest([second, first], key),
    );
    expect(credentialSetDigest([first], key)).not.toBe(
      credentialSetDigest([second], key),
    );
  });
});

class MemoryLegacyStore implements LegacyPermissionVaultStore {
  readonly #credentials = new Map<string, CloudVaultCredentialPlaintext>();

  constructor(credentials: CloudVaultCredentialPlaintext[]) {
    for (const credential of credentials) {
      this.#credentials.set(credential.id, structuredClone(credential));
    }
  }

  async deleteCredential(_userId: string, credentialId: string) {
    return this.#credentials.delete(credentialId);
  }

  async listCredentials(userId: string) {
    return [...this.#credentials.values()]
      .filter((credential) => credential.userId === userId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((credential) => structuredClone(credential));
  }

  async upsertCredential(credential: CloudVaultCredentialPlaintext) {
    this.#credentials.set(credential.id, structuredClone(credential));
  }
}

function plainCredential(
  id: string,
  host: string,
  password: string,
): CloudVaultCredentialPlaintext {
  return {
    accessPolicy: {
      allowAgentRead: true,
      allowedAgentIds: [],
      allowedProjectIds: [],
      deniedAgentIds: [],
      deniedProjectIds: [],
      requireApproval: false,
    },
    createdAt: "2026-08-11T04:00:00.000Z",
    expiresAt: null,
    fields: { host: `${host}.example`, username: "ubuntu" },
    id,
    kind: "ssh",
    label: `${host} SSH`,
    purposes: ["ssh.connect", "server.deploy"],
    secrets: { password },
    source: { type: "import" },
    tags: ["production", host],
    updatedAt: "2026-08-11T04:00:00.000Z",
    userId: "user-1",
  };
}
