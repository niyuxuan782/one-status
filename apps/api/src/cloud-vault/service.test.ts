import { describe, expect, it } from "vitest";
import { CloudVaultAgentApi } from "./agent-api.js";
import { FakeCloudVaultKmsProvider } from "./kms.js";
import { MemoryCloudVaultRepository } from "./memory-repository.js";
import {
  CloudVaultAccessDeniedError,
  CloudVaultApprovalRequiredError,
  CloudVaultService,
} from "./service.js";

describe("CloudVaultService", () => {
  it("encrypts every credential with an independent DEK and masks all lists", async () => {
    const { repository, service } = fixture();
    const firstSecret = "first-private-password";
    const secondSecret = "second-private-password";
    const first = await service.createCredential(
      credentialInput("server-a", firstSecret),
      userActor,
    );
    const second = await service.createCredential(
      credentialInput("server-b", secondSecret),
      userActor,
    );

    expect(first.secrets).toEqual({ password: "********" });
    expect(first).not.toHaveProperty("envelope");
    const storedFirst = await repository.getCredential("user-1", first.id);
    const storedSecond = await repository.getCredential("user-1", second.id);
    expect(storedFirst?.envelope.wrappedDek).not.toBe(
      storedSecond?.envelope.wrappedDek,
    );
    expect(storedFirst?.envelope.ciphertext).not.toBe(
      storedSecond?.envelope.ciphertext,
    );
    expect(JSON.stringify(storedFirst)).not.toContain(firstSecret);
    expect(JSON.stringify(storedSecond)).not.toContain(secondSecret);

    const listed = await service.listCredentials(
      { search: "server-a.example", userId: "user-1" },
      userActor,
    );
    expect(listed).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ host: "server-a.example" }),
        secrets: { password: "********" },
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(firstSecret);
  });

  it("accepts only approved non-secret plaintext matching fields", async () => {
    const { service } = fixture();
    await expect(
      service.createCredential(
        {
          ...credentialInput("unsafe", "encrypted-password"),
          fields: {
            host: "unsafe.example",
            apiKey: "must-not-be-indexed",
          },
        },
        userActor,
      ),
    ).rejects.toThrow("Sensitive credential values must be stored in secrets");
    await expect(
      service.createCredential(
        {
          ...credentialInput("unsafe-alias", "encrypted-password"),
          fields: {
            host: "unsafe-alias.example",
            token_value: "must-not-be-indexed",
          },
        },
        userActor,
      ),
    ).rejects.toThrow("Sensitive credential values must be stored in secrets");
  });

  it("resolves by purpose, grant, tags, and non-secret fields before reading", async () => {
    const { service } = fixture();
    const first = await service.createCredential(
      credentialInput("server-a", "server-a-password"),
      userActor,
    );
    await service.createCredential(
      credentialInput("server-b", "server-b-password"),
      userActor,
    );
    await service.createAgentGrant({
      actor: userActor,
      agentId: "codex",
      projectIds: ["one-status"],
      purposes: ["ssh"],
      userId: "user-1",
    });
    const session = await service.issueAgentSession({
      agentId: "codex",
      clientId: "codex-desktop",
      projectIds: ["one-status"],
      userId: "user-1",
    });

    const resolved = await service.resolveForAgent(session.token, {
      kinds: ["ssh"],
      matchFields: { host: "server-a.example", username: "ubuntu" },
      projectId: "one-status",
      purpose: "ssh.connect",
      tags: ["production"],
    });
    expect(resolved.credentials).toHaveLength(1);
    expect(resolved.selected?.id).toBe(first.id);
    expect(JSON.stringify(resolved)).not.toContain("server-a-password");

    await expect(
      service.getForAgent(session.token, {
        credentialId: first.id,
        projectId: "one-status",
        purpose: "ssh",
      }),
    ).rejects.toBeInstanceOf(CloudVaultAccessDeniedError);

    const revealed = await service.getForAgent(session.token, {
      credentialId: first.id,
      projectId: "one-status",
      purpose: "ssh.connect",
    });
    expect(revealed.secrets).toEqual({ password: "server-a-password" });

    const audit = await service.listAuditEvents("user-1", 100);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "credential.resolve",
          actorId: "codex",
          decision: "allow",
        }),
        expect.objectContaining({
          action: "credential.get",
          actorId: "codex",
          decision: "allow",
        }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("server-a-password");
  });

  it("denies an Agent without a matching grant and records a masked denial", async () => {
    const { service } = fixture();
    const credential = await service.createCredential(
      credentialInput("server-a", "denied-password"),
      userActor,
    );
    const session = await service.issueAgentSession({
      agentId: "claude-code",
      userId: "user-1",
    });

    await expect(
      service.getForAgent(session.token, {
        credentialId: credential.id,
        purpose: "ssh.connect",
      }),
    ).rejects.toBeInstanceOf(CloudVaultAccessDeniedError);
    expect(await service.listAuditEvents("user-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "credential.get",
          decision: "deny",
          reason: "grant_missing",
        }),
      ]),
    );
  });

  it("rotates the DEK on update and cryptographically erases on delete", async () => {
    const { repository, service } = fixture();
    const created = await service.createCredential(
      credentialInput("server-a", "old-password"),
      userActor,
    );
    const before = await repository.getCredential("user-1", created.id);
    const updated = await service.updateCredential({
      actor: userActor,
      credentialId: created.id,
      patch: {
        fields: { port: "2222" },
        secrets: { password: "rotated-password" },
      },
      userId: "user-1",
    });
    const after = await repository.getCredential("user-1", created.id);

    expect(updated.revision).toBe(2);
    expect(after?.envelope.wrappedDek).not.toBe(before?.envelope.wrappedDek);
    expect(after?.fields).toMatchObject({ port: "2222" });

    await expect(
      service.deleteCredential({
        actor: userActor,
        credentialId: created.id,
        userId: "user-1",
      }),
    ).resolves.toBe(true);
    const deleted = await repository.getCredential("user-1", created.id, true);
    expect(deleted).toMatchObject({
      deletedAt: expect.any(String),
      envelope: {
        authTag: "",
        ciphertext: "",
        iv: "",
        wrappedDek: "",
      },
      secretKeys: [],
    });
    expect(JSON.stringify(deleted)).not.toContain("rotated-password");
  });

  it("rolls back credential writes when the audit record cannot persist", async () => {
    class FailingAuditRepository extends MemoryCloudVaultRepository {
      override async insertAuditEvent(): Promise<void> {
        throw new Error("audit unavailable");
      }
    }
    const repository = new FailingAuditRepository();
    const service = new CloudVaultService({
      kms: new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(23)),
      repository,
    });
    await expect(
      service.createCredential(
        credentialInput("transaction", "transaction-password"),
        userActor,
      ),
    ).rejects.toThrow("audit unavailable");
    await expect(
      repository.listCredentials({ userId: "user-1" }),
    ).resolves.toEqual([]);
  });

  it("expires and revokes short-lived Agent sessions", async () => {
    let now = new Date("2026-08-11T04:00:00.000Z");
    const { service } = fixture(() => now);
    const session = await service.issueAgentSession({
      agentId: "codex",
      ttlMs: 5_000,
      userId: "user-1",
    });
    expect(await service.authenticateAgentSession(session.token)).toMatchObject({
      agentId: "codex",
      id: session.id,
    });
    now = new Date("2026-08-11T04:00:06.000Z");
    expect(await service.authenticateAgentSession(session.token)).toBeNull();

    const second = await service.issueAgentSession({
      agentId: "codex",
      userId: "user-1",
    });
    expect(
      await service.revokeAgentSession({
        sessionId: second.id,
        userId: "user-1",
      }),
    ).toBe(true);
    expect(await service.authenticateAgentSession(second.token)).toBeNull();
  });

  it("provides a transport-neutral Agent API for Remote MCP wiring", async () => {
    const { service } = fixture();
    const api = new CloudVaultAgentApi(service);
    const session = await service.issueAgentSession({
      agentId: "remote:codex",
      projectIds: ["one-status"],
      userId: "user-1",
    });
    const createRequest = {
      fields: { host: "remote.example", username: "ubuntu" },
      kind: "ssh" as const,
      label: "Remote SSH",
      projectId: "one-status",
      purposes: ["ssh.connect"],
      secrets: { password: "remote-private-password" },
      tags: ["remote"],
    };
    const credential = await api.register(session.token, {
      ...createRequest,
      approvalToken: await approveAgentAction(
        service,
        session.token,
        "credential.create",
        createRequest,
      ),
    });
    await service.createAgentGrant({
      actor: userActor,
      agentId: "remote:codex",
      credentialId: credential.id,
      projectIds: ["one-status"],
      purposes: ["*"],
      userId: "user-1",
    });

    const listed = await api.list(session.token, {
      projectId: "one-status",
      purposes: ["ssh.connect"],
    });
    expect(listed).toEqual([expect.objectContaining({ id: credential.id })]);
    await expect(
      api.get(session.token, {
        credentialId: credential.id,
        projectId: "one-status",
        purpose: "ssh.connect",
      }),
    ).resolves.toMatchObject({
      secrets: { password: "remote-private-password" },
    });
    const updateRequest = {
      credentialId: credential.id,
      patch: { secrets: { password: "remote-rotated-password" } },
      projectId: "one-status",
      purpose: "ssh.connect",
    };
    await api.update(session.token, {
      ...updateRequest,
      approvalToken: await approveAgentAction(
        service,
        session.token,
        "credential.update",
        updateRequest,
      ),
    });
    const deleteRequest = {
      credentialId: credential.id,
      projectId: "one-status",
      purpose: "ssh.connect",
    };
    await expect(
      api.delete(session.token, {
        ...deleteRequest,
        approvalToken: await approveAgentAction(
          service,
          session.token,
          "credential.delete",
          deleteRequest,
        ),
      }),
    ).resolves.toBe(true);
  });

  it("enforces credential policy, approval, and expiration after a grant", async () => {
    let now = new Date("2026-08-11T04:00:00.000Z");
    const { service } = fixture(() => now);
    const credential = await service.createCredential(
      {
        ...credentialInput("restricted", "restricted-password"),
        accessPolicy: {
          allowAgentRead: true,
          allowedAgentIds: ["codex"],
          allowedProjectIds: ["one-status"],
          requireApproval: true,
        },
        expiresAt: "2026-08-11T05:00:00.000Z",
      },
      userActor,
    );
    await service.createAgentGrant({
      actor: userActor,
      agentId: "codex",
      projectIds: ["one-status"],
      purposes: ["ssh.connect"],
      userId: "user-1",
    });
    const session = await service.issueAgentSession({
      agentId: "codex",
      projectIds: ["one-status"],
      userId: "user-1",
    });

    await expect(
      service.getForAgent(session.token, {
        credentialId: credential.id,
        projectId: "one-status",
        purpose: "ssh.connect",
      }),
    ).rejects.toBeInstanceOf(CloudVaultApprovalRequiredError);
    const getRequest = {
      credentialId: credential.id,
      projectId: "one-status",
      purpose: "ssh.connect",
    };
    const approvalToken = await approveAgentAction(
      service,
      session.token,
      "credential.get",
      getRequest,
    );
    await expect(
      service.getForAgent(session.token, {
        ...getRequest,
        approvalToken,
      }),
    ).resolves.toMatchObject({
      secrets: { password: "restricted-password" },
    });

    now = new Date("2026-08-11T05:00:01.000Z");
    await expect(
      service.getForAgent(session.token, {
        ...getRequest,
        approvalToken,
      }),
    ).rejects.toBeInstanceOf(CloudVaultAccessDeniedError);
  });

  it("rejects a project ID that is not bound to the Agent session", async () => {
    const { service } = fixture();
    const credential = await service.createCredential(
      {
        ...credentialInput("project-bound", "project-password"),
        accessPolicy: {
          allowAgentRead: true,
          allowedProjectIds: ["private-project"],
        },
      },
      userActor,
    );
    await service.createAgentGrant({
      actor: userActor,
      agentId: "codex",
      credentialId: credential.id,
      projectIds: ["private-project"],
      purposes: ["ssh.connect"],
      userId: "user-1",
    });
    const session = await service.issueAgentSession({
      agentId: "codex",
      projectIds: ["different-project"],
      userId: "user-1",
    });

    await expect(
      service.getForAgent(session.token, {
        credentialId: credential.id,
        projectId: "private-project",
        purpose: "ssh.connect",
      }),
    ).rejects.toBeInstanceOf(CloudVaultAccessDeniedError);
  });

  it("stores only an OPAQUE wallet record and reveals after external authorization", async () => {
    const { repository, service } = fixture();
    const credential = await service.createCredential(
      credentialInput("wallet", "wallet-private-password"),
      userActor,
    );
    const walletPakeRecord = {
      createdAt: "2026-08-11T05:00:00.000Z",
      profile: {
        version: 1 as const,
        suite: "opaque-rfc9807-ristretto255-sha512" as const,
        keyStretching: "memory-constrained" as const,
        argon2id: {
          memoryKiB: 65_536 as const,
          iterations: 3 as const,
          parallelism: 4 as const,
        },
      },
      registrationRecord: "opaque-registration-record",
      updatedAt: "2026-08-11T05:00:00.000Z",
      userId: "user-1",
    };

    await service.upsertWalletPakeRecord(walletPakeRecord);
    await expect(service.getWalletPakeRecord("user-1")).resolves.toEqual(
      walletPakeRecord,
    );
    await expect(
      service.revealForUserAuthorized({
        credentialId: credential.id,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({
      secrets: { password: "wallet-private-password" },
    });
    expect("revealForUser" in service).toBe(false);
    expect("verifyWalletPassword" in service).toBe(false);
    expect("changeWalletPassword" in service).toBe(false);
    expect("resetWalletPassword" in service).toBe(false);
    expect("importWalletPasswordVerifier" in service).toBe(false);
    expect(await repository.listAuditEvents("user-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "wallet.password.change",
          reason: "wallet_pake_record_updated",
        }),
        expect.objectContaining({
          action: "credential.reveal",
          reason: "wallet_pake_valid",
        }),
      ]),
    );
  });
});

const userActor = { id: "user-1", type: "user" as const };

function fixture(now?: () => Date) {
  const repository = new MemoryCloudVaultRepository();
  const service = new CloudVaultService({
    kms: new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(19)),
    now,
    repository,
  });
  return { repository, service };
}

async function approveAgentAction(
  service: CloudVaultService,
  token: string,
  operation:
    | "credential.create"
    | "credential.get"
    | "credential.update"
    | "credential.delete",
  request: Record<string, unknown>,
) {
  const issued = await service.requestAgentApproval(token, {
    operation,
    request,
  });
  await expect(
    service.decideAgentApproval({
      approvalId: issued.approval.id,
      decision: "approve",
      userId: issued.approval.userId,
    }),
  ).resolves.toBe(true);
  return issued.approvalToken;
}

function credentialInput(host: string, password: string) {
  return {
    fields: { host: `${host}.example`, username: "ubuntu" },
    kind: "ssh" as const,
    label: `${host} SSH`,
    purposes: ["ssh.connect", "server.deploy"],
    secrets: { password },
    source: { agentId: "codex", type: "agent" as const },
    tags: ["production", host],
    userId: "user-1",
  };
}
