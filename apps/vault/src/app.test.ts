import {
  CloudVaultService,
  FakeCloudVaultKmsProvider,
  MemoryCloudVaultRepository,
  credentialSetDigest,
} from "@one-status/api/cloud-vault";
import { randomBytes } from "node:crypto";
import {
  finishOpaqueLogin,
  finishOpaqueRegistration,
  startOpaqueLogin,
  startOpaqueRegistration,
  type OneStatusOpaqueProfile,
} from "@one-status/pake";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultServiceApp } from "./app.js";

const serviceToken = "vault-service-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const apps: ReturnType<typeof createVaultServiceApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Vault Service internal HTTP API", () => {
  it("requires service Bearer authentication even for health", async () => {
    const { app } = fixture();
    const denied = await app.inject({ method: "GET", url: "/health" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["cache-control"]).toBe("no-store, private");

    const healthy = await app.inject({
      headers: serviceHeaders(),
      method: "GET",
      url: "/health",
    });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toEqual({
      kms: "ready",
      kmsProvider: "test",
      kmsVerifiedAt: "2026-08-11T00:00:00.000Z",
      service: "one-status-vault",
      status: "ok",
    });
    expect(healthy.headers.pragma).toBe("no-cache");
    expect(healthy.headers.etag).toBeUndefined();
  });

  it("issues a scoped session and completes credential CRUD", async () => {
    const { app } = fixture();
    const issued = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: {
        agentId: "remote:codex",
        clientId: "remote-mcp-client",
        grants: [
          {
            projectIds: ["one-status"],
            purposes: ["*"],
          },
        ],
        ttlSeconds: 300,
        userId: "user-1",
      },
      url: "/v1/internal/agent-sessions",
    });
    expect(issued.statusCode).toBe(201);
    const agentToken = issued.json().session.token as string;
    expect(agentToken).toMatch(/^osva1_/);

    const createRequest = {
      fields: { host: "server.example", username: "ubuntu" },
      kind: "ssh",
      label: "Production SSH",
      projectId: "one-status",
      purposes: ["ssh.connect", "server.deploy"],
      secrets: { password: "private-http-password" },
      tags: ["production", "tencent"],
    };
    const createApproval = await approveHttpAction(
      app,
      agentToken,
      "credential.create",
      createRequest,
    );
    const created = await app.inject({
      headers: agentHeaders(agentToken),
      method: "POST",
      payload: {
        ...createRequest,
        approvalToken: createApproval,
      },
      url: "/v1/internal/credentials",
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("private-http-password");
    expect(created.json().credential.secrets).toEqual({
      password: "********",
    });
    const credentialId = created.json().credential.id as string;

    const resolved = await app.inject({
      headers: agentHeaders(agentToken),
      method: "POST",
      payload: {
        kinds: ["ssh"],
        limit: 20,
        matchFields: { host: "server.example" },
        projectId: "one-status",
        purpose: "ssh.connect",
        tags: ["production"],
      },
      url: "/v1/internal/credentials/resolve",
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().selected.id).toBe(credentialId);
    expect(resolved.body).not.toContain("private-http-password");

    const revealed = await app.inject({
      headers: agentHeaders(agentToken),
      method: "POST",
      payload: { projectId: "one-status", purpose: "ssh.connect" },
      url: `/v1/internal/credentials/${credentialId}/get`,
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().credential.secrets).toEqual({
      password: "private-http-password",
    });
    expect(revealed.headers["cache-control"]).toBe("no-store, private");

    const updateRequest = {
      credentialId,
      patch: { secrets: { password: "rotated-http-password" } },
      projectId: "one-status",
      purpose: "ssh.connect",
    };
    const updateApproval = await approveHttpAction(
      app,
      agentToken,
      "credential.update",
      updateRequest,
    );
    const updated = await app.inject({
      headers: agentHeaders(agentToken),
      method: "PATCH",
      payload: {
        approvalToken: updateApproval,
        patch: updateRequest.patch,
        projectId: "one-status",
        purpose: "ssh.connect",
      },
      url: `/v1/internal/credentials/${credentialId}`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain("rotated-http-password");

    const deleteRequest = {
      credentialId,
      projectId: "one-status",
      purpose: "ssh.connect",
    };
    const deleteApproval = await approveHttpAction(
      app,
      agentToken,
      "credential.delete",
      deleteRequest,
    );
    const deleted = await app.inject({
      headers: agentHeaders(agentToken),
      method: "DELETE",
      payload: {
        approvalToken: deleteApproval,
        projectId: "one-status",
        purpose: "ssh.connect",
      },
      url: `/v1/internal/credentials/${credentialId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ credentialId, deleted: true });
  });

  it("keeps Agent tokens separate and never reflects rejected body secrets", async () => {
    const { app } = fixture();
    const missingAgent = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: { purpose: "ssh.connect" },
      url: "/v1/internal/credentials/resolve",
    });
    expect(missingAgent.statusCode).toBe(403);

    const rejected = await app.inject({
      headers: {
        ...serviceHeaders(),
        "x-one-status-agent-token": "osva1_invalid",
      },
      method: "POST",
      payload: {
        label: "Invalid",
        secrets: { password: "must-not-be-reflected" },
      },
      url: "/v1/internal/credentials",
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain("must-not-be-reflected");
    expect(rejected.json()).toEqual({
      error: { code: "invalid_request", message: "Request is invalid." },
    });
  });

  it("requires a one-use Wallet OPAQUE grant for user-facing plaintext access", async () => {
    const { app, service } = fixture();
    const credential = await service.createCredential(
      {
        fields: { account: "developer@example.test" },
        kind: "account",
        label: "Developer account",
        purposes: ["account.login"],
        secrets: { password: "private-account-password" },
        source: { type: "user" },
        userId: "user-1",
      },
      { id: "user-1", type: "user" },
    );

    const listed = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: {},
      url: "/v1/internal/users/user-1/credentials/list",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("private-account-password");

    await registerWalletPake(app, "user-1", "initial", "123456");
    const initialGrant = await loginWalletPake(app, "user-1", "123456");
    const revealed = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: { walletGrant: initialGrant },
      url: `/v1/internal/users/user-1/credentials/${credential.id}/reveal`,
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().credential.secrets).toEqual({
      password: "private-account-password",
    });

    const changeGrant = await loginWalletPake(app, "user-1", "123456");
    await registerWalletPake(
      app,
      "user-1",
      "change",
      "new-wallet-password",
      changeGrant,
    );
    await expect(loginWalletPake(app, "user-1", "123456")).rejects.toThrow(
      "wallet password is invalid",
    );
    await registerWalletPake(
      app,
      "user-1",
      "reset",
      "recovered-wallet-password",
    );
    const recoveredGrant = await loginWalletPake(
      app,
      "user-1",
      "recovered-wallet-password",
    );
    const recovered = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: { walletGrant: recoveredGrant },
      url: `/v1/internal/users/user-1/credentials/${credential.id}/reveal`,
    });
    expect(recovered.statusCode).toBe(200);
  });

  it("backfills a local wallet and verifies the exact uploaded set", async () => {
    const { app, service } = fixture();
    const validationKey = randomBytes(32);
    const localCredential = {
      accessPolicy: {
        allowAgentRead: true,
        allowedAgentIds: [],
        allowedProjectIds: [],
        deniedAgentIds: [],
        deniedProjectIds: [],
        requireApproval: false,
      },
      createdAt: "2026-08-11T05:00:00.000Z",
      expiresAt: null,
      fields: { host: "migration.example" },
      id: "44444444-4444-4444-8444-444444444444",
      kind: "ssh" as const,
      label: "Migration SSH",
      purposes: ["ssh.connect"],
      secrets: { password: "migration-private-password" },
      source: { type: "import" as const },
      tags: ["migration"],
      updatedAt: "2026-08-11T05:00:00.000Z",
      userId: "user-1",
    };
    const digest = credentialSetDigest([localCredential], validationKey);
    const { userId: _userId, ...uploaded } = localCredential;
    const response = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: {
        credentials: [uploaded],
        digest,
        validationKey: validationKey.toString("base64url"),
      },
      url: "/v1/internal/users/user-1/migrations/backfill",
    });
    validationKey.fill(0);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 1, digest, verified: true });
    expect(response.body).not.toContain("migration-private-password");
    await expect(
      service.revealForUserAuthorized({
        credentialId: localCredential.id,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ id: localCredential.id });
  });

  it("replays identical Backfill data and refuses to overwrite cloud changes", async () => {
    const { app, service } = fixture();
    const validationKey = randomBytes(32);
    const localCredential = migrationCredential("original-private-password");
    const digest = credentialSetDigest([localCredential], validationKey);
    const { userId: _userId, ...uploaded } = localCredential;
    const payload = {
      credentials: [uploaded],
      digest,
      validationKey: validationKey.toString("base64url"),
    };

    const first = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload,
      url: "/v1/internal/users/user-1/migrations/backfill",
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload,
      url: "/v1/internal/users/user-1/migrations/backfill",
    });
    expect(replay.statusCode).toBe(200);

    await service.updateCredential({
      actor: { id: "remote:codex", type: "agent" },
      credentialId: localCredential.id,
      patch: { secrets: { password: "cloud-rotated-password" } },
      userId: "user-1",
    });
    const conflict = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload,
      url: "/v1/internal/users/user-1/migrations/backfill",
    });
    validationKey.fill(0);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "migration_conflict",
        message: "Cloud credentials changed after migration started.",
      },
    });
    await expect(
      service.revealForUserAuthorized({
        credentialId: localCredential.id,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({
      secrets: { password: "cloud-rotated-password" },
    });
  });

  it("refuses Backfill when cloud contains a credential missing locally", async () => {
    const { app, service } = fixture();
    await service.createCredential(
      {
        fields: { host: "cloud-only.example" },
        kind: "ssh",
        label: "Cloud only",
        purposes: ["ssh.connect"],
        secrets: { password: "cloud-only-password" },
        source: { type: "agent" },
        userId: "user-1",
      },
      { id: "remote:codex", type: "agent" },
    );
    const validationKey = randomBytes(32);
    const response = await app.inject({
      headers: serviceHeaders(),
      method: "POST",
      payload: {
        credentials: [],
        digest: credentialSetDigest([], validationKey),
        validationKey: validationKey.toString("base64url"),
      },
      url: "/v1/internal/users/user-1/migrations/backfill",
    });
    validationKey.fill(0);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("migration_conflict");
  });
});

function migrationCredential(password: string) {
  return {
    accessPolicy: {
      allowAgentRead: true,
      allowedAgentIds: [],
      allowedProjectIds: [],
      deniedAgentIds: [],
      deniedProjectIds: [],
      requireApproval: false,
    },
    createdAt: "2026-08-11T05:00:00.000Z",
    expiresAt: null,
    fields: { host: "migration-replay.example" },
    id: "55555555-5555-4555-8555-555555555555",
    kind: "ssh" as const,
    label: "Migration replay SSH",
    purposes: ["ssh.connect"],
    secrets: { password },
    source: { type: "import" as const },
    tags: ["migration"],
    updatedAt: "2026-08-11T05:00:00.000Z",
    userId: "user-1",
  };
}

async function registerWalletPake(
  app: ReturnType<typeof createVaultServiceApp>,
  userId: string,
  authorization: "initial" | "change" | "reset",
  password: string,
  walletGrant?: string,
): Promise<void> {
  const started = await startOpaqueRegistration(password);
  const startResponse = await app.inject({
    headers: serviceHeaders(),
    method: "POST",
    payload: {
      authorization,
      registrationRequest: started.registrationRequest,
      ...(walletGrant ? { walletGrant } : {}),
    },
    url: `/v1/internal/users/${userId}/wallet-pake/register/start`,
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<{
    flowId: string;
    profile: OneStatusOpaqueProfile;
    registrationResponse: string;
    serverPublicKey: string;
  }>();
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  const finishResponse = await app.inject({
    headers: serviceHeaders(),
    method: "PUT",
    payload: {
      flowId: challenge.flowId,
      registrationRecord: finished.registrationRecord,
    },
    url: `/v1/internal/users/${userId}/wallet-pake/register/finish`,
  });
  expect(finishResponse.statusCode).toBe(200);
}

async function loginWalletPake(
  app: ReturnType<typeof createVaultServiceApp>,
  userId: string,
  password: string,
): Promise<string> {
  const started = await startOpaqueLogin(password);
  const startResponse = await app.inject({
    headers: serviceHeaders(),
    method: "POST",
    payload: { startLoginRequest: started.startLoginRequest },
    url: `/v1/internal/users/${userId}/wallet-pake/login/start`,
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<{
    flowId: string;
    loginResponse: string;
    profile: OneStatusOpaqueProfile;
    serverPublicKey: string;
  }>();
  const finished = await finishOpaqueLogin({
    clientLoginState: started.clientLoginState,
    loginResponse: challenge.loginResponse,
    password,
    profile: challenge.profile,
  });
  if (!finished) throw new Error("wallet password is invalid");
  expect(finished.serverStaticPublicKey).toBe(challenge.serverPublicKey);
  const finishResponse = await app.inject({
    headers: serviceHeaders(),
    method: "POST",
    payload: {
      finishLoginRequest: finished.finishLoginRequest,
      flowId: challenge.flowId,
    },
    url: `/v1/internal/users/${userId}/wallet-pake/login/finish`,
  });
  expect(finishResponse.statusCode).toBe(200);
  return finishResponse.json<{ walletGrant: string }>().walletGrant;
}

function fixture() {
  const service = new CloudVaultService({
    kms: new FakeCloudVaultKmsProvider(new Uint8Array(32).fill(31)),
    repository: new MemoryCloudVaultRepository(),
  });
  const app = createVaultServiceApp({
    kmsProvider: "test",
    kmsVerifiedAt: "2026-08-11T00:00:00.000Z",
    logger: false,
    service,
    serviceToken,
  });
  apps.push(app);
  return { app, service };
}

function serviceHeaders() {
  return { authorization: `Bearer ${serviceToken}` };
}

function agentHeaders(agentToken: string) {
  return {
    ...serviceHeaders(),
    "x-one-status-agent-token": agentToken,
  };
}

async function approveHttpAction(
  app: ReturnType<typeof createVaultServiceApp>,
  agentToken: string,
  operation:
    | "credential.create"
    | "credential.get"
    | "credential.update"
    | "credential.delete",
  request: Record<string, unknown>,
) {
  const pending = await app.inject({
    headers: agentHeaders(agentToken),
    method: "POST",
    payload: { operation, request },
    url: "/v1/internal/approvals",
  });
  expect(pending.statusCode).toBe(201);
  const approval = pending.json();
  const decided = await app.inject({
    headers: serviceHeaders(),
    method: "PATCH",
    payload: { decision: "approve" },
    url: `/v1/internal/users/user-1/approvals/${approval.approval.id}`,
  });
  expect(decided.statusCode).toBe(200);
  return approval.approvalToken as string;
}
