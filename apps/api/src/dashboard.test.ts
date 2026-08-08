import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyStatus, type StatusDocument } from "@one-status/protocol";
import type { LocalProfile } from "@one-status/local-config";
import { encryptStatus, generateStatusKey } from "@one-status/crypto";
import { createApp } from "./app.js";
import type {
  DashboardBackend,
  DashboardStatusSnapshot,
} from "./dashboard-backend.js";
import { LocalDashboardBackend } from "./dashboard-backend.js";
import { PermissionVault } from "./permission-vault.js";
import { ToolGateway } from "./tool-gateway.js";
import type { HandoffPreview, HandoffService } from "./handoff.js";

describe("local dashboard", () => {
  let app: FastifyInstance;
  let directory: string;
  let backend: MemoryDashboardBackend;
  let handoffs: TestHandoffRuntime;
  let githubCliImporter: {
    import(userId: string): Promise<ReturnType<PermissionVault["upsertConnection"]>>;
  };
  let permissionVault: PermissionVault;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-dashboard-"));
    backend = new MemoryDashboardBackend();
    handoffs = new TestHandoffRuntime();
    permissionVault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(7),
    });
    githubCliImporter = {
      async import() {
        throw new Error("GitHub CLI importer was not configured for this test.");
      },
    };
    app = createApp({
      dbPath: join(directory, "sync.sqlite"),
      dashboard: {
        backend,
        githubCliImporter,
        handoffs,
        inventory: {
          async get() {
            return inventorySnapshot;
          },
          async refresh() {
            return { ...inventorySnapshot, scannedAt: new Date().toISOString() };
          },
        },
        permissionVault,
        toolGateway: new ToolGateway(permissionVault),
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("serves the dashboard and protects local mutation routes", async () => {
    const page = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html", host: "127.0.0.1:8787" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("One Status");
    expect(page.body).toContain("连接与权限");
    const setCookie = page.headers["set-cookie"]!;
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
    const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();

    const snapshot = await app.inject({
      method: "GET",
      url: "/v1/dashboard/snapshot",
      headers: { cookie, host: "127.0.0.1:8787" },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      version: 1,
      integrations: { connections: [], grants: [] },
    });
    const onboarding = await app.inject({
      method: "GET",
      url: "/v1/dashboard/onboarding",
      headers: { cookie, host: "127.0.0.1:8787" },
    });
    expect(onboarding.json()).toMatchObject({ authenticated: true });

    const inventory = await app.inject({
      method: "GET",
      url: "/v1/dashboard/local-inventory",
      headers: { cookie, host: "127.0.0.1:8787" },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({
      schemaVersion: 1,
      agents: [{ id: "codex", installed: true }],
    });

    const blockedRefresh = await app.inject({
      method: "POST",
      url: "/v1/dashboard/local-inventory/refresh",
      headers: { cookie, host: "127.0.0.1:8787" },
      payload: {},
    });
    expect(blockedRefresh.statusCode).toBe(403);

    const blocked = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/identity",
      headers: { cookie, host: "127.0.0.1:8787" },
      payload: { displayName: "Ryan" },
    });
    expect(blocked.statusCode).toBe(403);

    const updated = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/identity",
      headers: {
        cookie,
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        "x-one-status-csrf": csrf!,
      },
      payload: { displayName: "Ryan" },
    });
    expect(updated.statusCode).toBe(200);
    expect(backend.status.identity.displayName).toBe("Ryan");
  });

  it("rejects DNS rebinding hosts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html", host: "attacker.example" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("preserves an OAuth secret while updating the public client ID", async () => {
    const page = await app.inject({
      method: "GET",
      url: "/integrations",
      headers: { accept: "text/html", host: "127.0.0.1:8787" },
    });
    const setCookie = page.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
    const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];
    const headers = {
      cookie,
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "x-one-status-csrf": csrf!,
    };

    const configured = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/oauth/providers/google/config",
      headers,
      payload: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
    });
    expect(configured.statusCode).toBe(200);

    const updated = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/oauth/providers/google/config",
      headers,
      payload: {
        clientId: "updated-google-client-id",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(permissionVault.getProviderConfig("user-1", "google")).toEqual({
      clientId: "updated-google-client-id",
      clientSecret: "google-client-secret",
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/v1/dashboard/snapshot",
      headers: { cookie, host: "127.0.0.1:8787" },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(
      snapshot
        .json()
        .integrations.providers.find(
          (provider: { id: string }) => provider.id === "google",
        ),
    ).toMatchObject({
      clientId: "updated-google-client-id",
      configured: true,
    });
    expect(snapshot.body).not.toContain("google-client-secret");
    expect(snapshot.body).not.toContain("clientSecret");

    const started = await app.inject({
      method: "POST",
      url: "/v1/dashboard/oauth/providers/google/start",
      headers,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const authorizationUrl = new URL(started.json().authorizationUrl);
    expect(authorizationUrl.hostname).toBe("accounts.google.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "updated-google-client-id",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/oauth/google/callback",
    );

    const missingGitHubSecret = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/oauth/providers/github/config",
      headers,
      payload: { clientId: "github-client-id" },
    });
    expect(missingGitHubSecret.statusCode).toBe(422);

    const configuredSlack = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/oauth/providers/slack/config",
      headers,
      payload: { clientId: "slack-public-client-id" },
    });
    expect(configuredSlack.statusCode).toBe(200);

    const startedSlack = await app.inject({
      method: "POST",
      url: "/v1/dashboard/oauth/providers/slack/start",
      headers,
      payload: {},
    });
    expect(startedSlack.statusCode).toBe(200);
    const slackAuthorizationUrl = new URL(
      startedSlack.json().authorizationUrl,
    );
    expect(slackAuthorizationUrl.searchParams.get("user_scope")).toBe(
      "channels:read,groups:read",
    );
    expect(slackAuthorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(slackAuthorizationUrl.searchParams.get("scope")).toBe("");

    const configuredSnapshot = await app.inject({
      method: "GET",
      url: "/v1/dashboard/snapshot",
      headers: { cookie, host: "127.0.0.1:8787" },
    });
    const slackProvider = configuredSnapshot
      .json()
      .integrations.providers.find(
        (provider: { id: string }) => provider.id === "slack",
      );
    expect(slackProvider).toMatchObject({
      clientId: "slack-public-client-id",
      configured: true,
      requiresPkce: true,
      requiresSecret: false,
    });
  });

  it("returns fixed OAuth callback errors without reflecting provider details", async () => {
    const page = await app.inject({
      method: "GET",
      url: "/integrations",
      headers: { accept: "text/html", host: "127.0.0.1:8787" },
    });
    const setCookie = page.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
    const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];
    const headers = {
      cookie,
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "x-one-status-csrf": csrf!,
    };
    await app.inject({
      method: "PUT",
      url: "/v1/dashboard/oauth/providers/google/config",
      headers,
      payload: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
    });

    const start = async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/dashboard/oauth/providers/google/start",
        headers,
        payload: {},
      });
      return new URL(response.json().authorizationUrl).searchParams.get("state")!;
    };

    const deniedState = await start();
    const denied = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?error=access_denied&state=${deniedState}&error_description=${encodeURIComponent("secret provider diagnostic")}`,
      headers: { host: "127.0.0.1:8787" },
    });
    expect(denied.statusCode).toBe(303);
    expect(denied.headers.location).toBe(
      "/integrations?oauth=error&provider=google&reason=access_denied",
    );
    expect(denied.headers.location).not.toContain("diagnostic");

    const unknownState = await start();
    const unknown = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?error=internal_secret_error&state=${unknownState}`,
      headers: { host: "127.0.0.1:8787" },
    });
    expect(unknown.statusCode).toBe(303);
    expect(unknown.headers.location).toBe(
      "/integrations?oauth=error&provider=google&reason=provider_error",
    );

    const replay = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?code=unused&state=${deniedState}`,
      headers: { host: "127.0.0.1:8787" },
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe(
      "/integrations?oauth=error&provider=google&reason=invalid_oauth_state",
    );
  });

  it("serves OAuth configuration, permission, and mobile controls", async () => {
    const [script, styles] = await Promise.all([
      app.inject({ method: "GET", url: "/assets/dashboard.js" }),
      app.inject({ method: "GET", url: "/assets/dashboard.css" }),
    ]);
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain("copy-callback");
    expect(script.body).toContain("已保存；留空继续使用");
    expect(script.body).toContain("set-grant-selection");
    expect(script.body).toContain("PKCE public client");
    expect(script.body).toContain("provider.requiresSecret");
    expect(script.body).toContain("onboarding-register");
    expect(script.body).toContain("/v1/dashboard/onboarding/login");
    expect(script.body).toContain("connectionDisplayStatus");
    expect(script.body).toContain("import-github-cli");
    expect(script.body).toContain("从 gh 导入");
    expect(script.body).toContain("gatewayAddress.textContent = location.host");
    expect(script.body).toContain('data-form="handoff-publish"');
    expect(script.body).toContain('data-form="handoff-open"');
    expect(script.body).toContain("confirmCommit");
    expect(script.body).toContain("confirmPush");
    expect(script.body).not.toContain('params.get("message")');
    expect(styles.statusCode).toBe(200);
    expect(styles.body).toContain("max-height: calc(100dvh - 16px)");
    expect(styles.body).toContain(".provider-buttons");
  });

  it("persists supported Agent grants and clears them on disconnect", async () => {
    permissionVault.configureProvider("user-1", "google", {
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
    const connection = permissionVault.upsertConnection({
      accountId: "google-account-1",
      credential: { accessToken: "encrypted-in-vault" },
      expiresAt: null,
      label: "ryan@example.test",
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      userId: "user-1",
    });
    const page = await app.inject({
      method: "GET",
      url: "/integrations",
      headers: { accept: "text/html", host: "127.0.0.1:8787" },
    });
    const setCookie = page.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
    const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];
    const headers = {
      cookie,
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "x-one-status-csrf": csrf!,
    };

    const granted = await app.inject({
      method: "PUT",
      url: `/v1/dashboard/oauth/connections/${connection.id}/grants/codex`,
      headers,
      payload: { actions: ["calendar.events.list"] },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({
      actions: ["calendar.events.list"],
      agentId: "codex",
      connectionId: connection.id,
    });

    const unsupported = await app.inject({
      method: "PUT",
      url: `/v1/dashboard/oauth/connections/${connection.id}/grants/codex`,
      headers,
      payload: { actions: ["calendar.events.delete"] },
    });
    expect(unsupported.statusCode).toBe(422);
    expect(permissionVault.listGrants("user-1")).toHaveLength(1);

    const revokeFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revokeFetch);
    const disconnected = await app.inject({
      method: "DELETE",
      url: `/v1/dashboard/oauth/connections/${connection.id}`,
      headers,
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toEqual({ disconnected: true });
    expect(revokeFetch).toHaveBeenCalledOnce();
    expect(permissionVault.listConnections("user-1")).toEqual([]);
    expect(permissionVault.listGrants("user-1")).toEqual([]);
  });

  it("imports an external GitHub CLI credential without Provider App config", async () => {
    const importToken = "github-cli-import-token";
    const importMock = vi.fn(async (userId: string) =>
      permissionVault.upsertConnection({
        accountId: "42",
        credential: { accessToken: importToken, tokenType: "Bearer" },
        label: "ryan",
        provider: "github",
        scopes: ["repo", "read:org"],
        source: "imported",
        userId,
      }),
    );
    githubCliImporter.import = importMock;
    const page = await app.inject({
      method: "GET",
      url: "/integrations",
      headers: { accept: "text/html", host: "127.0.0.1:8787" },
    });
    const setCookie = page.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
    const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];
    const headers = {
      cookie,
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "x-one-status-csrf": csrf!,
    };

    const imported = await app.inject({
      method: "POST",
      url: "/v1/dashboard/oauth/providers/github/import-cli",
      headers,
      payload: {},
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      connected: true,
      connection: {
        accountId: "42",
        credentialOwnership: "external",
        label: "ryan",
        source: "imported",
      },
    });
    expect(imported.body).not.toContain(importToken);
    expect(importMock).toHaveBeenCalledWith("user-1");
    expect(permissionVault.getProviderConfig("user-1", "github")).toBeNull();

    const connectionId = imported.json().connection.id as string;
    permissionVault.setGrant("user-1", connectionId, "codex", [
      "github.repositories.list",
    ]);
    const revokeFetch = vi.fn();
    vi.stubGlobal("fetch", revokeFetch);
    const disconnected = await app.inject({
      method: "DELETE",
      url: `/v1/dashboard/oauth/connections/${connectionId}`,
      headers,
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toEqual({ disconnected: true });
    expect(revokeFetch).not.toHaveBeenCalled();
    expect(permissionVault.listConnections("user-1")).toEqual([]);
    expect(permissionVault.listGrants("user-1")).toEqual([]);
  });

  it("accepts the current remote profile bearer with an empty local sync DB", async () => {
    await app.close();
    permissionVault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(8),
    });
    const remoteProfile: LocalProfile = {
      version: 1,
      baseUrl: "https://os.example.test",
      userId: "remote-user-1",
      deviceId: "18f6680f-79de-4df6-8d88-08e66ddfbb53",
      deviceName: "Remote Mac",
      token: "remote-profile-device-token",
      tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      statusKey: `os1_${"a".repeat(43)}`,
    };
    const remoteBackend = new LocalDashboardBackend(async () => remoteProfile);
    const connection = permissionVault.upsertConnection({
      accountId: "42",
      credential: { accessToken: "encrypted-in-vault" },
      label: "ryan",
      provider: "github",
      scopes: ["read:user"],
      userId: remoteProfile.userId,
    });
    permissionVault.setGrant(remoteProfile.userId, connection.id, "codex", [
      "github.viewer.get",
    ]);
    app = createApp({
      dbPath: join(directory, "empty-local-sync.sqlite"),
      dashboard: {
        backend: remoteBackend,
        handoffs,
        inventory: {
          async get() {
            return inventorySnapshot;
          },
          async refresh() {
            return inventorySnapshot;
          },
        },
        permissionVault,
        toolGateway: new ToolGateway(permissionVault),
      },
    });
    await app.ready();

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/tools?agentId=codex",
      headers: {
        authorization: `Bearer ${remoteProfile.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      connections: [
        {
          actions: [{ id: "github.viewer.get" }],
          connection: { id: connection.id, provider: "github" },
        },
      ],
    });

    const wrongBearer = await app.inject({
      method: "GET",
      url: "/v1/tools?agentId=codex",
      headers: {
        authorization: "Bearer wrong-remote-token",
        host: "127.0.0.1:8787",
      },
    });
    expect(wrongBearer.statusCode).toBe(401);

    const publicHost = await app.inject({
      method: "GET",
      url: "/v1/tools?agentId=codex",
      headers: {
        authorization: `Bearer ${remoteProfile.token}`,
        host: "os.example.test",
      },
    });
    expect(publicHost.statusCode).toBe(403);

    remoteProfile.tokenExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const expired = await app.inject({
      method: "GET",
      url: "/v1/tools?agentId=codex",
      headers: {
        authorization: `Bearer ${remoteProfile.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(expired.statusCode).toBe(401);
  });

  it("keeps local sync database sessions valid for Tool Gateway routes", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "local-tools@example.test",
        password: "local tools password",
        deviceName: "Local Mac",
        initialEnvelope: encryptStatus(createEmptyStatus(), generateStatusKey(), 1),
      },
    });
    expect(registration.statusCode).toBe(201);
    const session = registration.json<{
      token: string;
      userId: string;
    }>();
    const connection = permissionVault.upsertConnection({
      accountId: "local-42",
      credential: { accessToken: "encrypted-in-vault" },
      label: "local-user",
      provider: "github",
      scopes: ["read:user"],
      userId: session.userId,
    });
    permissionVault.setGrant(session.userId, connection.id, "codex", [
      "github.viewer.get",
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/tools?agentId=codex",
      headers: {
        authorization: `Bearer ${session.token}`,
        host: "127.0.0.1:8787",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connections: [{ connection: { id: connection.id } }],
    });
  });

  it("protects local project mapping and Handoff writes", async () => {
    const page = await app.inject({
      method: "GET",
      url: "/handoffs",
      headers: { accept: "text/html", host: "127.0.0.1:8787" },
    });
    expect(page.statusCode).toBe(200);
    const setCookie = page.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
    const csrf = page.body.match(/name="one-status-csrf" content="([^"]+)"/)?.[1];

    const overview = await app.inject({
      method: "GET",
      url: "/v1/dashboard/handoffs",
      headers: { cookie, host: "127.0.0.1:8787" },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      projects: [{ id: "project-1", mapped: false }],
    });

    const blocked = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/local-project-mappings/project-1",
      headers: { cookie, host: "127.0.0.1:8787" },
      payload: { path: "/tmp/project-1" },
    });
    expect(blocked.statusCode).toBe(403);

    const headers = {
      cookie,
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "x-one-status-csrf": csrf!,
    };
    const mapped = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/local-project-mappings/project-1",
      headers,
      payload: { path: "/tmp/project-1" },
    });
    expect(mapped.statusCode).toBe(200);
    expect(handoffs.mappingPath).toBe("/tmp/project-1");

    const preview = await app.inject({
      method: "POST",
      url: "/v1/dashboard/handoffs/project-1/preview",
      headers,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<HandoffPreview>();

    const written = await app.inject({
      method: "POST",
      url: "/v1/dashboard/handoffs/project-1/write",
      headers,
      payload: {
        expectedCommit: previewBody.manifest.repository.commit,
        expectedStatusVersion: previewBody.manifest.statusVersion,
        overwrite: false,
      },
    });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({
      written: true,
      committed: false,
      pushed: false,
    });
    expect(handoffs.lastWrite).toMatchObject({
      projectId: "project-1",
      overwrite: false,
    });

    const unconfirmedPublish = await app.inject({
      method: "POST",
      url: "/v1/dashboard/handoffs/project-1/publish",
      headers,
      payload: {
        expectedCommit: previewBody.manifest.repository.commit,
        expectedStatusVersion: previewBody.manifest.statusVersion,
        overwrite: false,
        confirmCommit: false,
        confirmPush: false,
      },
    });
    expect(unconfirmedPublish.statusCode).toBe(400);

    const published = await app.inject({
      method: "POST",
      url: "/v1/dashboard/handoffs/project-1/publish",
      headers,
      payload: {
        expectedCommit: previewBody.manifest.repository.commit,
        expectedStatusVersion: previewBody.manifest.statusVersion,
        overwrite: false,
        confirmCommit: true,
        confirmPush: true,
      },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ committed: true, pushed: true });
    expect(handoffs.lastPublish).toMatchObject({
      projectId: "project-1",
      confirmCommit: true,
      confirmPush: true,
    });

    const opened = await app.inject({
      method: "POST",
      url: "/v1/dashboard/handoffs/project-1/open",
      headers,
      payload: {
        agentId: "claude-code",
        confirmCheckout: true,
        destinationPath: "/tmp/project-1",
      },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      opened: true,
      launch: { agentId: "claude-code", launched: true },
    });
    expect(handoffs.lastOpen).toMatchObject({
      projectId: "project-1",
      agentId: "claude-code",
      confirmCheckout: true,
    });
  });
});

const inventorySnapshot = {
  schemaVersion: 1 as const,
  scannedAt: new Date(0).toISOString(),
  agents: [{ id: "codex" as const, name: "Codex", installed: true }],
  projects: [],
  mcpServers: [],
  plugins: [],
  skills: [],
  rules: [],
  warnings: [],
};

class MemoryDashboardBackend implements DashboardBackend {
  status: StatusDocument = createEmptyStatus();
  version = 1;

  async getSnapshot(): Promise<DashboardStatusSnapshot> {
    return this.snapshot();
  }

  async mutateStatus(
    mutator: (status: StatusDocument) => void,
  ): Promise<DashboardStatusSnapshot> {
    const next = structuredClone(this.status);
    mutator(next);
    this.status = next;
    this.version += 1;
    return this.snapshot();
  }

  async revokeDevice(): Promise<void> {}
  async userId(): Promise<string> {
    return "user-1";
  }

  private snapshot(): DashboardStatusSnapshot {
    return {
      account: {
        user: {
          id: "user-1",
          email: "ryan@example.test",
          createdAt: new Date(0).toISOString(),
        },
        devices: [
          {
            id: "device-1",
            name: "Mac",
            createdAt: new Date(0).toISOString(),
            lastSeenAt: new Date(0).toISOString(),
            online: false,
          },
        ],
      },
      profile: {
        baseUrl: "http://127.0.0.1:8787",
        deviceId: "device-1",
        deviceName: "Mac",
        tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "user-1",
      },
      status: structuredClone(this.status),
      updatedAt: new Date().toISOString(),
      version: this.version,
    };
  }
}

class TestHandoffRuntime
  implements
    Pick<
      HandoffService,
      | "mapProject"
      | "openAndContinue"
      | "overview"
      | "preview"
      | "publish"
      | "unmapProject"
      | "write"
    >
{
  mappingPath?: string;
  lastOpen?: Parameters<HandoffService["openAndContinue"]>[0];
  lastPublish?: Parameters<HandoffService["publish"]>[0];
  lastWrite?: Parameters<HandoffService["write"]>[0];

  async mapProject(projectId: string, path: string) {
    this.mappingPath = path;
    const now = new Date(0).toISOString();
    return { projectId, path, repoRoot: path, createdAt: now, updatedAt: now };
  }

  async overview() {
    return {
      activity: [],
      mappings: [],
      projects: [
        {
          id: "project-1",
          name: "One Status",
          goal: "Publish Handoff",
          handoff: null,
          mapped: false,
        },
      ],
    };
  }

  async preview(projectId: string): Promise<HandoffPreview> {
    const manifest = {
      format: "one-status.handoff" as const,
      version: 1 as const,
      generatedAt: new Date(0).toISOString(),
      projectId,
      statusVersion: 3,
      repository: {
        branch: "main",
        changedFiles: [],
        commit: "a".repeat(40),
        dirty: false,
        remote: null,
      },
      context: {
        completed: [],
        currentContext: null,
        currentGoal: "Publish Handoff",
        decisions: [],
        next: [],
        blocked: [],
        lastAgentId: "codex",
      },
      validation: { secretScan: "passed" as const, test: "not_run" as const },
    };
    return {
      canWrite: true,
      existingFiles: [],
      findings: [],
      manifest,
      markdown: "# One Status Handoff",
      mapping: { projectId, path: "/tmp/project-1", repoRoot: "/tmp/project-1" },
    };
  }

  unmapProject(): boolean {
    this.mappingPath = undefined;
    return true;
  }

  async write(input: Parameters<HandoffService["write"]>[0]) {
    this.lastWrite = input;
    const preview = await this.preview(input.projectId);
    return {
      written: true as const,
      files: [...(["HANDOFF.md", ".one-status/handoff.json"] as const)],
      manifest: preview.manifest,
      committed: false,
      pushed: false,
    };
  }

  async publish(input: Parameters<HandoffService["publish"]>[0]) {
    this.lastPublish = input;
    return {
      written: true as const,
      committed: true as const,
      pushed: true as const,
      files: [...(["HANDOFF.md", ".one-status/handoff.json"] as const)],
      repository: {
        provider: "github" as const,
        url: "https://github.com/acme/one-status.git",
        branch: "main",
        commit: "b".repeat(40),
      },
      statusVersion: 4,
    };
  }

  async openAndContinue(
    input: Parameters<HandoffService["openAndContinue"]>[0],
  ) {
    this.lastOpen = input;
    return {
      branch: `one-status/continue/${input.projectId}-${"b".repeat(12)}`,
      cloned: true,
      commit: "b".repeat(40),
      mapping: {
        projectId: input.projectId,
        path: "/tmp/project-1",
        repoRoot: "/tmp/project-1",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      launch: {
        agentId: input.agentId,
        command: input.agentId === "codex" ? "codex" : "claude",
        cwd: "/tmp/project-1",
        launched: true as const,
        mode: "terminal" as const,
      },
      opened: true as const,
    };
  }
}
