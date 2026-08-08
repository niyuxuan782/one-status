import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PermissionVault,
  type PermissionVaultBundle,
} from "./permission-vault.js";

describe("Permission Vault", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("encrypts provider secrets, OAuth state, and credentials at rest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-permissions-"));
    directories.push(directory);
    const path = join(directory, "permissions.sqlite");
    const vault = new PermissionVault({
      path,
      keyPath: join(directory, "permission.key"),
    });
    vault.configureProvider("user-1", "google", {
      clientId: "google-client-id",
      clientSecret: "google-client-secret-plaintext",
    });
    const flow = vault.createFlow({
      provider: "google",
      redirectUri: "http://127.0.0.1:8787/oauth/google/callback",
      userId: "user-1",
    });
    const consumed = vault.consumeFlow(flow.state);
    expect(consumed?.codeVerifier).toBe(flow.codeVerifier);
    expect(vault.consumeFlow(flow.state)).toBeNull();

    const connection = vault.upsertConnection({
      accountId: "google-account",
      credential: {
        accessToken: "google-access-token-plaintext",
        refreshToken: "google-refresh-token-plaintext",
      },
      label: "ryan@example.test",
      provider: "google",
      scopes: ["calendar.readonly"],
      userId: "user-1",
    });
    vault.setGrant("user-1", connection.id, "codex", [
      "calendar.events.list",
    ]);
    expect(
      vault.getAllowedActions("user-1", connection.id, "codex"),
    ).toEqual(["calendar.events.list"]);
    expect(
      vault.getConnectionWithCredential("user-1", connection.id)?.credential,
    ).toMatchObject({ refreshToken: "google-refresh-token-plaintext" });
    vault.close();

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("google-client-secret-plaintext");
    expect(persisted).not.toContain("google-access-token-plaintext");
    expect(persisted).not.toContain("google-refresh-token-plaintext");
    expect(persisted).not.toContain(flow.codeVerifier);
  });

  it("retains refresh material when Google omits it during reauthorization", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(4),
    });
    const original = vault.upsertConnection({
      accountId: "google-account",
      credential: {
        accessToken: "first-access",
        refreshToken: "durable-refresh",
        tokenType: "Bearer",
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      label: "ryan@example.test",
      provider: "google",
      scopes: ["openid", "calendar.readonly"],
      userId: "user-1",
    });

    const updated = vault.upsertConnection({
      accountId: "google-account",
      credential: { accessToken: "second-access" },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      label: "ryan@example.test",
      provider: "google",
      scopes: ["openid", "calendar.readonly"],
      userId: "user-1",
    });

    expect(updated.id).toBe(original.id);
    expect(
      vault.getConnectionWithCredential("user-1", original.id)?.credential,
    ).toEqual({
      accessToken: "second-access",
      refreshToken: "durable-refresh",
      tokenType: "Bearer",
    });
    vault.close();
  });

  it("tracks imported credential ownership and resets it on OAuth reconnect", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(9),
    });
    const imported = vault.upsertConnection({
      accountId: "42",
      credential: { accessToken: "github-cli-token" },
      label: "ryan",
      provider: "github",
      scopes: ["repo", "read:org"],
      source: "imported",
      userId: "user-1",
    });
    expect(imported).toMatchObject({
      credentialOwnership: "external",
      source: "imported",
    });

    const restored = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(10),
    });
    restored.importBundle("user-1", vault.exportBundle("user-1"));
    expect(restored.getConnection("user-1", imported.id)).toMatchObject({
      credentialOwnership: "external",
      source: "imported",
    });

    const managed = vault.upsertConnection({
      accountId: "42",
      credential: {
        accessToken: "oauth-token",
        refreshToken: "oauth-refresh",
      },
      label: "ryan",
      provider: "github",
      scopes: ["read:user", "repo"],
      userId: "user-1",
    });
    expect(managed).toMatchObject({
      credentialOwnership: "managed",
      id: imported.id,
      source: "oauth",
    });
    expect(
      vault.getConnectionWithCredential("user-1", managed.id)?.credential,
    ).toEqual({
      accessToken: "oauth-token",
      refreshToken: "oauth-refresh",
    });
    vault.close();
    restored.close();
  });

  it("derives expiration status and rejects unsafe OAuth redirects", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(5),
    });
    vault.configureProvider("user-1", "slack", {
      clientId: "slack-public-client",
    });
    expect(vault.getProviderConfig("user-1", "slack")).toEqual({
      clientId: "slack-public-client",
    });
    const connection = vault.upsertConnection({
      accountId: "T1",
      credential: { accessToken: "expired-access" },
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      label: "Workspace",
      provider: "slack",
      scopes: ["channels:read", "groups:read"],
      userId: "user-1",
    });
    expect(vault.getConnection("user-1", connection.id)?.status).toBe(
      "expired",
    );

    expect(() =>
      vault.createFlow({
        provider: "google",
        redirectUri: "http://attacker.example/oauth/callback",
        userId: "user-1",
      }),
    ).toThrow("OAuth redirect URI must use HTTPS or a loopback address.");
    const flow = vault.createFlow({
      provider: "google",
      redirectUri: "https://os.example.test/oauth/google/callback",
      returnTo: "/\\attacker.example/path",
      userId: "user-1",
    });
    expect(flow.returnTo).toBe("/integrations");
    vault.close();
  });

  it("exports and imports a complete user vault across device-local keys", () => {
    const first = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(6),
    });
    const second = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(7),
    });
    first.configureProvider("user-1", "google", {
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    const connection = first.upsertConnection({
      accountId: "google-account",
      credential: {
        accessToken: "google-access",
        refreshToken: "google-refresh",
      },
      expiresAt: "2026-09-08T10:00:00.000Z",
      label: "ryan@example.test",
      provider: "google",
      scopes: ["calendar.readonly"],
      userId: "user-1",
    });
    first.setGrant("user-1", connection.id, "codex", [
      "calendar.events.list",
    ]);

    const bundle = first.exportBundle("user-1");
    second.importBundle("user-1", bundle);

    expect(second.getProviderConfig("user-1", "google")).toEqual({
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    expect(
      second.getConnectionWithCredential("user-1", connection.id),
    ).toMatchObject({
      credential: {
        accessToken: "google-access",
        refreshToken: "google-refresh",
      },
      label: "ryan@example.test",
    });
    expect(second.getAllowedActions("user-1", connection.id, "codex")).toEqual(
      ["calendar.events.list"],
    );

    const legacyBundle = structuredClone(bundle) as PermissionVaultBundle;
    const legacyConnection = legacyBundle.connections[0]! as unknown as Record<
      string,
      unknown
    >;
    delete legacyConnection.source;
    delete legacyConnection.credentialOwnership;
    second.importBundle("user-1", legacyBundle);
    expect(second.getConnection("user-1", connection.id)).toMatchObject({
      credentialOwnership: "managed",
      source: "oauth",
    });

    second.deleteConnection("user-1", connection.id);
    const deletion = second.exportBundle("user-1");
    expect(Date.parse(deletion.updatedAt)).toBeGreaterThan(
      Date.parse(bundle.updatedAt),
    );
    first.importBundle("user-1", deletion);
    expect(first.listConnections("user-1")).toEqual([]);
    expect(first.listGrants("user-1")).toEqual([]);
    first.close();
    second.close();
  });
});
