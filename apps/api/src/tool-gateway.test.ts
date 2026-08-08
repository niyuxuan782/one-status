import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderFetch } from "./oauth-providers.js";
import { PermissionVault } from "./permission-vault.js";
import {
  ToolConnectionExpiredError,
  ToolGateway,
  ToolPermissionDeniedError,
} from "./tool-gateway.js";

describe("Tool Gateway OAuth boundaries", () => {
  const vaults: PermissionVault[] = [];

  afterEach(() => {
    for (const vault of vaults.splice(0)) vault.close();
  });

  it("hides and blocks granted actions when provider scopes are missing", async () => {
    const vault = createVault(vaults);
    const connection = vault.upsertConnection({
      accountId: "T1",
      credential: { accessToken: "slack-access" },
      label: "Workspace",
      provider: "slack",
      scopes: ["channels:read"],
      userId: "user-1",
    });
    vault.setGrant("user-1", connection.id, "codex", [
      "slack.channels.list",
    ]);
    const fetch_ = vi.fn<ProviderFetch>();
    const gateway = new ToolGateway(vault, { fetch: fetch_ });

    expect(gateway.list("user-1", "codex")).toEqual([]);
    await expect(
      gateway.execute({
        action: "slack.channels.list",
        agentId: "codex",
        connectionId: connection.id,
        userId: "user-1",
      }),
    ).rejects.toBeInstanceOf(ToolPermissionDeniedError);
    expect(fetch_).not.toHaveBeenCalled();
  });

  it("serializes concurrent Slack refreshes and stores both rotated tokens", async () => {
    const now = Date.now();
    const vault = createVault(vaults);
    vault.configureProvider("user-1", "slack", {
      clientId: "slack-client",
    });
    const connection = vault.upsertConnection({
      accountId: "T1",
      credential: {
        accessToken: "old-access",
        refreshToken: "single-use-refresh",
      },
      expiresAt: new Date(now - 1_000).toISOString(),
      label: "Workspace",
      provider: "slack",
      scopes: ["channels:read", "groups:read"],
      userId: "user-1",
    });
    vault.setGrant("user-1", connection.id, "codex", [
      "slack.channels.list",
    ]);

    let refreshCalls = 0;
    const actionTokens: string[] = [];
    const fetch_: ProviderFetch = async (input, init) => {
      const url = requestUrl(input);
      if (url === "https://slack.com/api/oauth.v2.access") {
        refreshCalls += 1;
        expect((init?.body as URLSearchParams).get("refresh_token")).toBe(
          "single-use-refresh",
        );
        expect((init?.body as URLSearchParams).get("client_secret")).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json({
          authed_user: {
            access_token: "rotated-access",
            expires_in: 43_200,
            refresh_token: "rotated-refresh",
            scope: "channels:read,groups:read",
            token_type: "user",
          },
          ok: true,
        });
      }
      actionTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return json({ channels: [], ok: true });
    };
    const gateway = new ToolGateway(vault, { fetch: fetch_, now: () => now });
    const execute = () =>
      gateway.execute({
        action: "slack.channels.list",
        agentId: "codex",
        connectionId: connection.id,
        userId: "user-1",
      });

    await Promise.all([execute(), execute()]);

    expect(refreshCalls).toBe(1);
    expect(actionTokens).toEqual([
      "Bearer rotated-access",
      "Bearer rotated-access",
    ]);
    expect(
      vault.getConnectionWithCredential("user-1", connection.id)?.credential,
    ).toEqual({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      tokenType: "user",
    });
    expect(vault.getConnection("user-1", connection.id)?.status).toBe(
      "connected",
    );
  });

  it("marks an expired connection when no refresh token is available", async () => {
    const now = Date.now();
    const vault = createVault(vaults);
    vault.configureProvider("user-1", "google", {
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    const connection = vault.upsertConnection({
      accountId: "google-user",
      credential: { accessToken: "expired-access" },
      expiresAt: new Date(now - 1_000).toISOString(),
      label: "ryan@example.test",
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      userId: "user-1",
    });
    vault.setGrant("user-1", connection.id, "codex", [
      "calendar.events.list",
    ]);
    const fetch_ = vi.fn<ProviderFetch>();
    const gateway = new ToolGateway(vault, { fetch: fetch_, now: () => now });

    await expect(
      gateway.execute({
        action: "calendar.events.list",
        agentId: "codex",
        connectionId: connection.id,
        userId: "user-1",
      }),
    ).rejects.toBeInstanceOf(ToolConnectionExpiredError);
    expect(fetch_).not.toHaveBeenCalled();
    expect(vault.getConnection("user-1", connection.id)?.status).toBe(
      "expired",
    );
  });

  it("blocks execution when a refresh response drops a required scope", async () => {
    const now = Date.now();
    const vault = createVault(vaults);
    vault.configureProvider("user-1", "slack", {
      clientId: "slack-client",
    });
    const connection = vault.upsertConnection({
      accountId: "T1",
      credential: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
      },
      expiresAt: new Date(now - 1_000).toISOString(),
      label: "Workspace",
      provider: "slack",
      scopes: ["channels:read", "groups:read"],
      userId: "user-1",
    });
    vault.setGrant("user-1", connection.id, "codex", [
      "slack.channels.list",
    ]);
    const fetch_ = vi.fn<ProviderFetch>(async () =>
      json({
        authed_user: {
          access_token: "new-access",
          expires_in: 43_200,
          refresh_token: "new-refresh",
          scope: "channels:read",
        },
        ok: true,
      }),
    );
    const gateway = new ToolGateway(vault, { fetch: fetch_, now: () => now });

    await expect(
      gateway.execute({
        action: "slack.channels.list",
        agentId: "codex",
        connectionId: connection.id,
        userId: "user-1",
      }),
    ).rejects.toBeInstanceOf(ToolPermissionDeniedError);
    expect(fetch_).toHaveBeenCalledTimes(1);
    expect(vault.getConnection("user-1", connection.id)).toMatchObject({
      scopes: ["channels:read"],
      status: "error",
    });
  });

  it("marks a connection as errored after an authorization failure", async () => {
    const vault = createVault(vaults);
    const connection = vault.upsertConnection({
      accountId: "42",
      credential: { accessToken: "revoked-access" },
      label: "ryan",
      provider: "github",
      scopes: ["read:user"],
      userId: "user-1",
    });
    vault.setGrant("user-1", connection.id, "codex", ["github.viewer.get"]);
    const gateway = new ToolGateway(vault, {
      fetch: async () =>
        json({ message: "Bad credentials revoked-access" }, 401),
    });

    const error = await gateway
      .execute({
        action: "github.viewer.get",
        agentId: "codex",
        connectionId: connection.id,
        userId: "user-1",
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).not.toContain("revoked-access");
    expect(vault.getConnection("user-1", connection.id)?.status).toBe("error");
    expect(gateway.list("user-1", "codex")).toEqual([]);
  });
});

function createVault(vaults: PermissionVault[]): PermissionVault {
  const vault = new PermissionVault({
    path: ":memory:",
    key: new Uint8Array(32).fill(9),
  });
  vaults.push(vault);
  return vault;
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
