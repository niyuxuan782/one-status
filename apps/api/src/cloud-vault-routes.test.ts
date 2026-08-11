import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapStatusKeyWithOpaqueExportKey } from "@one-status/crypto";
import {
  finishOpaqueRegistration,
  startOpaqueRegistration,
  type OneStatusOpaqueProfile,
} from "@one-status/pake";
import type { EncryptedEnvelope } from "@one-status/protocol";
import { createApp } from "./app.js";

const initialEnvelope: EncryptedEnvelope = {
  algorithm: "AES-256-GCM",
  authTag: "auth-tag",
  ciphertext: "ciphertext",
  format: "one-status.encrypted-status",
  iv: "iv",
  revision: 1,
  version: 1,
};
const statusKey = new Uint8Array(32).fill(5);

describe("Cloud Vault device routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("binds wallet operations to the authenticated account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-vault-routes-"));
    const calls: Array<{ operation: string; userId: string }> = [];
    const vault = {
      async backfillUserCredentials(input: { userId: string }) {
        calls.push({ operation: "backfill", userId: input.userId });
        return { count: 0, digest: "a".repeat(43), verified: true };
      },
      async createAgentGateway() {
        return { async credential() { return {}; } };
      },
      async listUserCredentials(userId: string) {
        calls.push({ operation: "list", userId });
        return { credentials: [] };
      },
      async listUserApprovals(userId: string) {
        calls.push({ operation: "approvals.list", userId });
        return { approvals: [] };
      },
      async decideUserApproval(input: { userId: string }) {
        calls.push({ operation: "approvals.decide", userId: input.userId });
        return { decision: "approve" };
      },
      async revealUserCredential(input: { userId: string }) {
        calls.push({ operation: "reveal", userId: input.userId });
        return {
          credential: {
            id: credentialId,
            secrets: { password: "temporary-secret" },
          },
        };
      },
      async startUserWalletPakeLogin(input: { userId: string }) {
        calls.push({ operation: "pake.login.start", userId: input.userId });
        return { flowId, loginResponse: "login-response" };
      },
      async finishUserWalletPakeLogin(input: { userId: string }) {
        calls.push({ operation: "pake.login.finish", userId: input.userId });
        return { walletGrant };
      },
      async startUserWalletPakeRegistration(input: { userId: string }) {
        calls.push({ operation: "pake.register.start", userId: input.userId });
        return { flowId, registrationResponse: "registration-response" };
      },
      async finishUserWalletPakeRegistration(input: { userId: string }) {
        calls.push({ operation: "pake.register.finish", userId: input.userId });
        return { registered: true };
      },
    };
    const app = createApp({
      authRateLimit: false,
      dbPath: join(directory, "cloud.sqlite"),
      remoteCloud: {
        issuer: "http://127.0.0.1:9901",
        resource: "http://127.0.0.1:9902/mcp",
        vault,
      },
    });
    cleanups.push(async () => {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    });
    const session = await registerOpaque(app, {
      deviceName: "Test Mac",
      email: "vault-user@example.test",
      password: "correct horse battery staple",
    });
    const authorization = { authorization: `Bearer ${session.token}` };

    const backfill = await app.inject({
      headers: authorization,
      method: "POST",
      payload: {
        credentials: [],
        digest: "a".repeat(43),
        validationKey: "b".repeat(43),
      },
      url: "/v1/vault/migrations/backfill",
    });
    expect(backfill.statusCode).toBe(200);
    const listed = await app.inject({
      headers: authorization,
      method: "POST",
      payload: {},
      url: "/v1/vault/credentials/list",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toContain("no-store");
    const approvals = await app.inject({
      headers: authorization,
      method: "GET",
      url: "/v1/vault/approvals",
    });
    expect(approvals.statusCode).toBe(200);
    const decided = await app.inject({
      headers: authorization,
      method: "PATCH",
      payload: { decision: "approve" },
      url: `/v1/vault/approvals/${approvalId}`,
    });
    expect(decided.statusCode).toBe(200);
    const revealed = await app.inject({
      headers: authorization,
      method: "POST",
      payload: { walletGrant },
      url: `/v1/vault/credentials/${credentialId}/reveal`,
    });
    expect(revealed.json()).toMatchObject({
      credential: { secrets: { password: "temporary-secret" } },
    });
    const loginStart = await app.inject({
      headers: authorization,
      method: "POST",
      payload: { startLoginRequest: "login-request" },
      url: "/v1/vault/wallet-pake/login/start",
    });
    expect(loginStart.statusCode).toBe(200);
    const loginFinish = await app.inject({
      headers: authorization,
      method: "POST",
      payload: {
        finishLoginRequest: "login-finish-request",
        flowId,
      },
      url: "/v1/vault/wallet-pake/login/finish",
    });
    expect(loginFinish.statusCode).toBe(200);
    const registrationStart = await app.inject({
      headers: authorization,
      method: "POST",
      payload: {
        authorization: "change",
        registrationRequest: "registration-request",
        walletGrant,
      },
      url: "/v1/vault/wallet-pake/register/start",
    });
    expect(registrationStart.statusCode).toBe(200);
    const registrationFinish = await app.inject({
      headers: authorization,
      method: "PUT",
      payload: { flowId, registrationRecord: "registration-record" },
      url: "/v1/vault/wallet-pake/register/finish",
    });
    expect(registrationFinish.statusCode).toBe(200);
    expect(registrationFinish.headers["cache-control"]).toContain("no-store");
    expect(calls).toEqual([
      { operation: "backfill", userId: session.userId },
      { operation: "list", userId: session.userId },
      { operation: "approvals.list", userId: session.userId },
      { operation: "approvals.decide", userId: session.userId },
      { operation: "reveal", userId: session.userId },
      { operation: "pake.login.start", userId: session.userId },
      { operation: "pake.login.finish", userId: session.userId },
      { operation: "pake.register.start", userId: session.userId },
      { operation: "pake.register.finish", userId: session.userId },
    ]);
  });
});

async function registerOpaque(
  app: ReturnType<typeof createApp>,
  input: { deviceName: string; email: string; password: string },
): Promise<{ token: string; userId: string }> {
  const started = await startOpaqueRegistration(input.password);
  const startResponse = await app.inject({
    method: "POST",
    payload: {
      email: input.email,
      registrationRequest: started.registrationRequest,
    },
    url: "/v1/auth/opaque/register/start",
  });
  expect(startResponse.statusCode).toBe(200);
  const challenge = startResponse.json<{
    accountBinding: string;
    flowId: string;
    profile: OneStatusOpaqueProfile;
    registrationResponse: string;
  }>();
  const finished = await finishOpaqueRegistration({
    clientRegistrationState: started.clientRegistrationState,
    password: input.password,
    profile: challenge.profile,
    registrationResponse: challenge.registrationResponse,
  });
  const response = await app.inject({
    method: "POST",
    payload: {
      deviceName: input.deviceName,
      flowId: challenge.flowId,
      initialEnvelope,
      registrationRecord: finished.registrationRecord,
      wrappedStatusKey: wrapStatusKeyWithOpaqueExportKey(
        statusKey,
        finished.exportKey,
        challenge.accountBinding,
      ),
    },
    url: "/v1/auth/opaque/register/finish",
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

const credentialId = "33333333-3333-4333-8333-333333333333";
const approvalId = "66666666-6666-4666-8666-666666666666";
const flowId = "55555555-5555-4555-8555-555555555555";
const walletGrant = `oswg1_${"g".repeat(43)}`;
