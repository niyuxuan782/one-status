import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("encrypts model source API keys and exposes only availability metadata", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(21),
    });
    vault.setModelCredential("user-1", "third-party-a", "model-secret-key");

    expect(vault.hasModelCredential("user-1", "third-party-a")).toBe(true);
    expect(vault.getModelCredential("user-1", "third-party-a")).toBe(
      "model-secret-key",
    );
    expect(vault.listModelCredentialStatus("user-1")).toEqual([
      expect.objectContaining({ sourceId: "third-party-a" }),
    ]);
    expect(vault.exportBundle("user-1").modelCredentials).toEqual([
      expect.objectContaining({
        sourceId: "third-party-a",
        apiKey: "model-secret-key",
      }),
    ]);
    expect(vault.deleteModelCredential("user-1", "third-party-a")).toBe(true);
    expect(vault.hasModelCredential("user-1", "third-party-a")).toBe(false);
    vault.close();
  });

  it("keeps repeated credential discovery idempotent", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(22),
    });
    expect(
      vault.setModelCredential("user-1", "discovered-source", "same-secret"),
    ).toBe(true);
    const first = vault.listModelCredentialStatus("user-1")[0];

    expect(
      vault.setModelCredential("user-1", "discovered-source", "same-secret"),
    ).toBe(false);
    expect(vault.listModelCredentialStatus("user-1")[0]).toEqual(first);
    expect(
      vault.setModelCredential("user-1", "discovered-source", "new-secret"),
    ).toBe(true);
    expect(vault.getModelCredential("user-1", "discovered-source")).toBe(
      "new-secret",
    );
    vault.close();
  });

  it("bridges model wallet keys into stable Agent-readable credentials", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(45),
    });
    vault.setModelCredential(
      "user-1",
      "third-party-openai",
      "initial-model-secret",
    );
    const [credential] = vault.listPrivateCredentials("user-1", {
      kinds: ["model"],
    });
    expect(credential).toMatchObject({
      fields: { sourceId: "third-party-openai" },
      kind: "model",
      purposes: ["model.api", "model.configure"],
      secrets: { apiKey: "********" },
      tags: ["model-wallet"],
    });
    expect(
      vault.findPrivateCredentialsForAgent({
        agentId: "codex",
        kinds: ["model"],
        purpose: "model",
        userId: "user-1",
      }),
    ).toEqual([expect.objectContaining({ id: credential!.id })]);
    expect(
      vault.readPrivateCredentialForAgent({
        agentId: "codex",
        credentialId: credential!.id,
        purpose: "model.api",
        userId: "user-1",
      })?.secrets,
    ).toEqual({ apiKey: "initial-model-secret" });

    expect(
      vault.patchPrivateCredential({
        credentialId: credential!.id,
        secrets: { apiKey: "rotated-model-secret" },
        userId: "user-1",
      }),
    ).toMatchObject({ id: credential!.id, secrets: { apiKey: "********" } });
    expect(vault.getModelCredential("user-1", "third-party-openai")).toBe(
      "rotated-model-secret",
    );
    expect(vault.exportBundle("user-1").privateCredentials).toEqual([]);
    expect(vault.exportBundle("user-1").modelCredentials).toEqual([
      expect.objectContaining({
        apiKey: "rotated-model-secret",
        sourceId: "third-party-openai",
      }),
    ]);
    expect(vault.deletePrivateCredential("user-1", credential!.id)).toBe(true);
    expect(vault.listPrivateCredentials("user-1", { kinds: ["model"] })).toEqual(
      [],
    );
    expect(vault.isModelCredentialIgnored("user-1", "third-party-openai")).toBe(
      true,
    );
    vault.close();
  });

  it("keeps an ignored discovered source deleted until manually restored", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(23),
    });
    expect(
      vault.setDiscoveredModelCredential(
        "user-1",
        "discovered-source",
        "same-secret",
      ),
    ).toBe(true);
    expect(vault.ignoreModelCredential("user-1", "discovered-source")).toBe(
      true,
    );
    expect(vault.isModelCredentialIgnored("user-1", "discovered-source")).toBe(
      true,
    );
    expect(
      vault.setDiscoveredModelCredential(
        "user-1",
        "discovered-source",
        "same-secret",
      ),
    ).toBe(false);
    expect(vault.hasModelCredential("user-1", "discovered-source")).toBe(false);
    expect(vault.exportBundle("user-1").modelCredentialIgnores).toEqual([
      expect.objectContaining({ sourceId: "discovered-source" }),
    ]);

    expect(
      vault.setModelCredential(
        "user-1",
        "discovered-source",
        "manually-restored-secret",
      ),
    ).toBe(true);
    expect(vault.isModelCredentialIgnored("user-1", "discovered-source")).toBe(
      false,
    );
    expect(vault.getModelCredential("user-1", "discovered-source")).toBe(
      "manually-restored-secret",
    );
    vault.close();
  });

  it("gates wallet reveal with a persisted scrypt verifier", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "one-status-wallet-password-"),
    );
    directories.push(directory);
    const path = join(directory, "permissions.sqlite");
    const vault = new PermissionVault({
      path,
      keyPath: join(directory, "permission.key"),
    });

    expect(vault.verifyModelWalletPassword("user-1", "wrong-password")).toBe(
      false,
    );
    expect(vault.verifyModelWalletPassword("user-1", "123456")).toBe(true);
    expect(
      vault.changeModelWalletPassword("user-1", "wrong-password", "654321"),
    ).toBe(false);
    expect(
      vault.changeModelWalletPassword("user-1", "123456", "654321"),
    ).toBe(true);
    expect(vault.verifyModelWalletPassword("user-1", "123456")).toBe(false);
    expect(vault.verifyModelWalletPassword("user-1", "654321")).toBe(true);
    expect(vault.exportBundle("user-1").walletPassword).toMatchObject({
      salt: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    vault.close();

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("123456");
    expect(persisted).not.toContain("654321");
    const reopened = new PermissionVault({
      path,
      keyPath: join(directory, "permission.key"),
    });
    expect(reopened.verifyModelWalletPassword("user-1", "123456")).toBe(false);
    expect(reopened.verifyModelWalletPassword("user-1", "654321")).toBe(true);
    reopened.close();
  });

  it("preserves a custom wallet password when importing a legacy bundle", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(24),
    });
    expect(vault.verifyModelWalletPassword("user-1", "123456")).toBe(true);
    expect(
      vault.changeModelWalletPassword("user-1", "123456", "654321"),
    ).toBe(true);
    const legacy = structuredClone(vault.exportBundle("user-1"));
    delete legacy.walletPassword;

    vault.importBundle("user-1", legacy);

    expect(vault.verifyModelWalletPassword("user-1", "123456")).toBe(false);
    expect(vault.verifyModelWalletPassword("user-1", "654321")).toBe(true);
    vault.close();
  });

  it("encrypts model source API keys and exposes availability metadata", () => {
    const vault = new PermissionVault({
      key: new Uint8Array(32).fill(31),
      path: ":memory:",
    });
    vault.setModelCredential("user-1", "third-party-a", "model-secret-key");

    expect(vault.hasModelCredential("user-1", "third-party-a")).toBe(true);
    expect(vault.getModelCredential("user-1", "third-party-a")).toBe(
      "model-secret-key",
    );
    expect(vault.listModelCredentialStatus("user-1")).toEqual([
      expect.objectContaining({ sourceId: "third-party-a" }),
    ]);
    expect(vault.exportBundle("user-1").modelCredentials).toEqual([
      expect.objectContaining({
        sourceId: "third-party-a",
        apiKey: "model-secret-key",
      }),
    ]);
    expect(vault.deleteModelCredential("user-1", "third-party-a")).toBe(true);
    expect(vault.hasModelCredential("user-1", "third-party-a")).toBe(false);
    vault.close();
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

  it("keeps only the latest flow for each user and provider", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(11),
    });
    const superseded = vault.createFlow({
      provider: "google",
      redirectUri: "https://os.example.test/oauth/google/callback",
      userId: "user-1",
    });
    const otherProvider = vault.createFlow({
      provider: "github",
      redirectUri: "https://os.example.test/oauth/github/callback",
      userId: "user-1",
    });
    const otherUser = vault.createFlow({
      provider: "google",
      redirectUri: "https://os.example.test/oauth/google/callback",
      userId: "user-2",
    });
    const latest = vault.createFlow({
      provider: "google",
      redirectUri: "https://os.example.test/oauth/google/callback",
      userId: "user-1",
    });

    expect(vault.consumeFlow(superseded.state)).toBeNull();
    expect(vault.consumeFlow(latest.state)?.userId).toBe("user-1");
    expect(vault.consumeFlow(otherProvider.state)?.provider).toBe("github");
    expect(vault.consumeFlow(otherUser.state)?.userId).toBe("user-2");
    vault.close();
  });

  it("returns bounded tool audit events without credential material", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(12),
    });
    vault.recordAudit({
      userId: "user-1",
      connectionId: "connection-1",
      agentId: "codex",
      action: "slack.channels.list",
      decision: "allow",
      outcome: "success",
      durationMs: 42,
      providerRequestId: "request-1",
    });
    vault.recordAudit({
      userId: "user-2",
      agentId: "claude-code",
      action: "github.repositories.list",
      decision: "deny",
      outcome: "blocked",
    });

    expect(vault.listAuditEvents("user-1", 1)).toEqual([
      expect.objectContaining({
        action: "slack.channels.list",
        agentId: "codex",
        connectionId: "connection-1",
        decision: "allow",
        durationMs: 42,
        outcome: "success",
        providerRequestId: "request-1",
      }),
    ]);
    expect(JSON.stringify(vault.listAuditEvents("user-1"))).not.toContain(
      "accessToken",
    );
    vault.close();
  });

  it("removes expired flows whenever a new flow is created", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "one-status-permissions-"));
    directories.push(directory);
    const path = join(directory, "permissions.sqlite");
    const vault = new PermissionVault({
      path,
      keyPath: join(directory, "permission.key"),
    });
    try {
      vault.createFlow({
        provider: "google",
        redirectUri: "https://os.example.test/oauth/google/callback",
        userId: "expired-user",
      });
      vi.advanceTimersByTime(10 * 60 * 1_000 + 1);
      vault.createFlow({
        provider: "github",
        redirectUri: "https://os.example.test/oauth/github/callback",
        userId: "active-user",
      });

      const inspection = new DatabaseSync(path, { readOnly: true });
      const rows = inspection
        .prepare("SELECT user_id, provider FROM oauth_flows ORDER BY user_id")
        .all();
      inspection.close();
      expect(rows).toEqual([{ user_id: "active-user", provider: "github" }]);
    } finally {
      vault.close();
      vi.useRealTimers();
    }
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

  it("encrypts structured private credentials and masks every secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-status-private-vault-"));
    directories.push(directory);
    const path = join(directory, "permissions.sqlite");
    const vault = new PermissionVault({
      path,
      keyPath: join(directory, "permission.key"),
    });
    const stored = vault.upsertPrivateCredential({
      fields: {
        host: "124.220.104.225",
        port: "22",
        username: "ubuntu",
      },
      kind: "ssh",
      label: "Production SSH",
      purposes: ["deployment.ssh"],
      secrets: {
        password: "server-password-plaintext",
        privateKey: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      },
      source: {
        agentId: "codex",
        projectId: "one-status",
        type: "agent",
      },
      tags: ["production", "tencent-cloud"],
      userId: "user-1",
    });

    expect(stored).toMatchObject({
      fields: { host: "124.220.104.225", username: "ubuntu" },
      kind: "ssh",
      secrets: { password: "********", privateKey: "********" },
      source: { agentId: "codex", projectId: "one-status" },
    });
    expect(JSON.stringify(vault.listPrivateCredentials("user-1"))).not.toContain(
      "server-password-plaintext",
    );
    expect(
      vault.revealPrivateCredential("user-1", stored.id, "incorrect"),
    ).toBeNull();
    expect(
      vault.revealPrivateCredential("user-1", stored.id, "123456")?.secrets,
    ).toEqual({
      password: "server-password-plaintext",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    });
    vault.upsertPrivateCredential({
      fields: {
        host: "124.220.104.225",
        port: "22",
        username: "ubuntu",
      },
      id: stored.id,
      kind: "ssh",
      label: "Production SSH",
      purposes: ["deployment.ssh"],
      secrets: { password: "rotated-server-password" },
      source: {
        agentId: "codex",
        projectId: "one-status",
        type: "agent",
      },
      tags: ["production", "tencent-cloud"],
      userId: "user-1",
    });
    expect(
      vault.revealPrivateCredential("user-1", stored.id, "123456")?.secrets,
    ).toEqual({
      password: "rotated-server-password",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    });
    expect(
      vault.patchPrivateCredential({
        credentialId: stored.id,
        label: "Primary production SSH",
        userId: "user-1",
      }),
    ).toMatchObject({
      id: stored.id,
      label: "Primary production SSH",
      secrets: { password: "********", privateKey: "********" },
    });
    expect(
      vault.revealPrivateCredential("user-1", stored.id, "123456")?.secrets,
    ).toEqual({
      password: "rotated-server-password",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    });
    vault.close();

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("124.220.104.225");
    expect(persisted).not.toContain("ubuntu");
    expect(persisted).not.toContain("server-password-plaintext");
    expect(persisted).not.toContain("rotated-server-password");
    expect(persisted).not.toContain("private-material");
  });

  it("selects credentials by purpose and audits controlled Agent reads", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(41),
    });
    const credential = vault.upsertPrivateCredential({
      accessPolicy: {
        allowedAgentIds: ["codex"],
        allowedProjectIds: ["one-status"],
      },
      fields: { host: "db.internal", username: "service" },
      kind: "database",
      label: "One Status database",
      purposes: ["deployment.database"],
      secrets: { password: "database-secret" },
      source: { type: "user" },
      tags: ["production"],
      userId: "user-1",
    });

    expect(
      vault.findPrivateCredentialsForAgent({
        agentId: "codex",
        projectId: "one-status",
        purpose: "deployment",
        tags: ["production"],
        userId: "user-1",
      }),
    ).toEqual([expect.objectContaining({ id: credential.id })]);
    expect(
      vault.findPrivateCredentialsForAgent({
        agentId: "claude-code",
        projectId: "one-status",
        purpose: "deployment",
        userId: "user-1",
      }),
    ).toEqual([]);
    expect(
      vault.readPrivateCredentialForAgent({
        agentId: "codex",
        credentialId: credential.id,
        projectId: "one-status",
        purpose: "deployment.database",
        userId: "user-1",
      })?.secrets,
    ).toEqual({ password: "database-secret" });
    expect(
      vault.readPrivateCredentialForAgent({
        agentId: "claude-code",
        credentialId: credential.id,
        projectId: "one-status",
        purpose: "deployment.database",
        userId: "user-1",
      }),
    ).toBeNull();
    expect(vault.listCredentialAccessAuditEvents("user-1")).toEqual([
      expect.objectContaining({
        agentId: "claude-code",
        decision: "deny",
        reason: "agent_not_allowed",
      }),
      expect.objectContaining({
        agentId: "codex",
        decision: "allow",
        reason: "allowed",
      }),
    ]);
    expect(
      JSON.stringify(vault.listCredentialAccessAuditEvents("user-1")),
    ).not.toContain("database-secret");
    vault.close();
  });

  it("syncs private credential tombstones and preserves them for legacy bundles", () => {
    const first = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(42),
    });
    const second = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(43),
    });
    const credential = first.upsertPrivateCredential({
      fields: { account: "ryan" },
      kind: "github",
      label: "GitHub personal access token",
      purposes: ["github.repository"],
      secrets: { token: "github-private-token" },
      userId: "user-1",
    });
    second.importBundle("user-1", first.exportBundle("user-1"));
    expect(
      second.revealPrivateCredential("user-1", credential.id, "123456")
        ?.secrets,
    ).toEqual({ token: "github-private-token" });

    const legacyBundle = structuredClone(first.exportBundle("user-1"));
    delete legacyBundle.privateCredentials;
    delete legacyBundle.privateCredentialTombstones;
    second.importBundle("user-1", legacyBundle);
    expect(second.listPrivateCredentials("user-1")).toHaveLength(1);

    expect(second.deletePrivateCredential("user-1", credential.id)).toBe(true);
    const deletion = second.exportBundle("user-1");
    expect(deletion.privateCredentials).toEqual([]);
    expect(deletion.privateCredentialTombstones).toEqual([
      expect.objectContaining({ credentialId: credential.id }),
    ]);
    first.importBundle("user-1", deletion);
    expect(first.listPrivateCredentials("user-1")).toEqual([]);
    first.close();
    second.close();
  });

  it("rejects ambiguous or malformed private credential records", () => {
    const vault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(44),
    });
    expect(() =>
      vault.upsertPrivateCredential({
        accessPolicy: {
          allowedAgentIds: ["codex"],
          deniedAgentIds: ["codex"],
        },
        kind: "api",
        label: "Service API",
        purposes: ["service.read"],
        secrets: { apiKey: "secret" },
        userId: "user-1",
      }),
    ).toThrow("allow and deny lists overlap");
    expect(() =>
      vault.upsertPrivateCredential({
        fields: { "invalid key": "value" },
        kind: "generic",
        label: "Invalid",
        purposes: ["test"],
        secrets: { password: "secret" },
        userId: "user-1",
      }),
    ).toThrow();
    expect(() =>
      vault.upsertPrivateCredential({
        kind: "api",
        label: "Unknown field",
        purposes: ["test"],
        secrets: { token: "secret" },
        userId: "user-1",
        unexpected: true,
      } as never),
    ).toThrow();
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
