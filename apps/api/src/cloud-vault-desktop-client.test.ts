import { describe, expect, it, vi } from "vitest";
import { CloudVaultDesktopClient } from "./cloud-vault-desktop-client.js";

describe("CloudVaultDesktopClient", () => {
  it("uses the current device session and returns only approval summaries", async () => {
    const requests: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          headers: new Headers(init?.headers),
          method: String(init?.method),
          url,
        });
        if (init?.method === "PATCH") {
          return Response.json({ decision: "approve" });
        }
        if (url.endsWith("/wallet-pake/login/start")) {
          return Response.json({ flowId, loginResponse: "response" });
        }
        if (url.endsWith("/wallet-pake/login/finish")) {
          return Response.json({ walletGrant });
        }
        if (url.endsWith("/wallet-pake/register/start")) {
          return Response.json({ flowId, registrationResponse: "response" });
        }
        if (url.endsWith("/wallet-pake/register/finish")) {
          return Response.json({ registered: true });
        }
        if (url.endsWith(`/credentials/${credentialId}/reveal`)) {
          return Response.json({ credential: { id: credentialId } });
        }
        return Response.json({
          approvals: [
            {
              agentId: "remote:chatgpt",
              clientId: "chatgpt-client",
              consumedAt: null,
              createdAt: "2026-08-11T06:00:00.000Z",
              decidedAt: null,
              expiresAt: "2026-08-11T06:10:00.000Z",
              id: approvalId,
              operation: "credential.update",
              sessionId: "77777777-7777-4777-8777-777777777777",
              status: "pending",
              summary: {
                credentialId: credentialId,
                fieldKeys: ["host"],
                kind: "ssh",
                label: "Production SSH",
                projectId: "one-status",
                purpose: "credential.update",
                secretKeys: ["password"],
              },
              userId: "user-1",
            },
          ],
        });
      },
    );
    const client = new CloudVaultDesktopClient({
      fetch: fetchMock as typeof fetch,
      loadProfile: async () => profile,
    });

    await expect(client.listApprovals()).resolves.toEqual([
      expect.objectContaining({ id: approvalId, status: "pending" }),
    ]);
    await client.decideApproval(approvalId, "approve");
    await client.startWalletPakeLogin("login-request");
    await client.finishWalletPakeLogin(flowId, "login-finish-request");
    await client.startWalletPakeRegistration({
      authorization: "change",
      registrationRequest: "registration-request",
      walletGrant,
    });
    await client.finishWalletPakeRegistration(flowId, "registration-record");
    await client.revealCredential(credentialId, walletGrant);
    expect(requests).toHaveLength(7);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://os.example.test/v1/vault/approvals?limit=100",
    });
    expect(requests[1]).toMatchObject({
      body: { decision: "approve" },
      method: "PATCH",
      url: `https://os.example.test/v1/vault/approvals/${approvalId}`,
    });
    expect(requests[0]!.headers.get("authorization")).toBe(
      "Bearer device-token",
    );
    expect(requests[2]).toMatchObject({
      body: { startLoginRequest: "login-request" },
      method: "POST",
      url: "https://os.example.test/v1/vault/wallet-pake/login/start",
    });
    expect(requests[3]).toMatchObject({
      body: { finishLoginRequest: "login-finish-request", flowId },
      method: "POST",
      url: "https://os.example.test/v1/vault/wallet-pake/login/finish",
    });
    expect(requests[4]).toMatchObject({
      body: {
        authorization: "change",
        registrationRequest: "registration-request",
        walletGrant,
      },
      method: "POST",
      url: "https://os.example.test/v1/vault/wallet-pake/register/start",
    });
    expect(requests[5]).toMatchObject({
      body: { flowId, registrationRecord: "registration-record" },
      method: "PUT",
      url: "https://os.example.test/v1/vault/wallet-pake/register/finish",
    });
    expect(requests[6]).toMatchObject({
      body: { walletGrant },
      method: "POST",
      url: `https://os.example.test/v1/vault/credentials/${credentialId}/reveal`,
    });
  });
});

const approvalId = "66666666-6666-4666-8666-666666666666";
const credentialId = "33333333-3333-4333-8333-333333333333";
const flowId = "55555555-5555-4555-8555-555555555555";
const walletGrant = `oswg1_${"g".repeat(43)}`;
const profile = {
  baseUrl: "https://os.example.test",
  deviceId: "device-1",
  deviceName: "Test Mac",
  statusKey: `os1_${"a".repeat(43)}`,
  token: "device-token",
  tokenExpiresAt: "2026-09-01T00:00:00.000Z",
  userId: "user-1",
  version: 1 as const,
};
