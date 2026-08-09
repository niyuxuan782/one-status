import { access, mkdtemp, rm } from "node:fs/promises";
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
import {
  ProviderRequestError,
  type ProviderFetch,
} from "./oauth-providers.js";
import {
  ToolConnectionExpiredError,
  ToolGateway,
  ToolPermissionDeniedError,
} from "./tool-gateway.js";
import type { HandoffPreview, HandoffService } from "./handoff.js";
import { LocalCapabilityManager } from "./local-capability-manager.js";

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
    const capabilityManager = new LocalCapabilityManager({
      codexMarketplaceRoot: join(directory, "codex-marketplace"),
      claudeSkillsRoot: join(directory, "claude-skills"),
      exportRoot: join(directory, "capability-exports"),
      homeDir: directory,
      environment: {},
    });
    app = createApp({
      dbPath: join(directory, "sync.sqlite"),
      dashboard: {
        backend,
        capabilityManager,
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
    const snapshotBody = snapshot.json();
    expect(snapshotBody).toMatchObject({
      version: 1,
      integrations: { connections: [], grants: [] },
    });
    expect(
      snapshotBody.capabilityPacks.map(
        (entry: { manifest: { name: string } }) => entry.manifest.name,
      ),
    ).toEqual([
      "google-workspace",
      "github-workflow",
      "slack-workspace",
      "microsoft-365",
      "notion-workspace",
      "dropbox-files",
      "zoom-meetings",
      "canva-design",
      "asana-work-management",
      "trello-boards",
      "airtable-bases",
      "linear-issues",
      "figma-design",
      "box-files",
    ]);
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

    const capability = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/capabilities/google-workspace",
      headers: {
        cookie,
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        "x-one-status-csrf": csrf!,
      },
      payload: { targets: ["codex", "claude-code"], enabled: true },
    });
    expect(capability.statusCode).toBe(200);
    expect(
      backend.status.capabilities.installations["google-workspace"],
    ).toMatchObject({
      version: "1.0.0",
      targets: ["codex", "claude-code"],
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const capabilityPreview = await app.inject({
      method: "POST",
      url: "/v1/dashboard/capabilities/google-workspace/preview",
      headers: {
        cookie,
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        "x-one-status-csrf": csrf!,
      },
      payload: { target: "markdown" },
    });
    expect(capabilityPreview.statusCode).toBe(200);
    const previewBody = capabilityPreview.json();
    expect(previewBody).toMatchObject({
      target: "markdown",
      preview: { installable: true },
    });
    const installedCapability = await app.inject({
      method: "POST",
      url: "/v1/dashboard/capabilities/google-workspace/install",
      headers: {
        cookie,
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        "x-one-status-csrf": csrf!,
      },
      payload: {
        target: "markdown",
        approvalId: previewBody.approvalId,
        confirmed: true,
      },
    });
    expect(installedCapability.statusCode).toBe(200);
    expect(installedCapability.json()).toMatchObject({ applied: true });
    await expect(
      access(
        join(
          directory,
          "capability-exports/markdown/google-workspace/google-workspace.md",
        ),
      ),
    ).resolves.toBeUndefined();

    const removedCapability = await app.inject({
      method: "DELETE",
      url: "/v1/dashboard/capabilities/google-workspace",
      headers: {
        cookie,
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        "x-one-status-csrf": csrf!,
      },
    });
    expect(removedCapability.statusCode).toBe(200);
    expect(
      backend.status.capabilities.installations["google-workspace"],
    ).toBeUndefined();
  });

  it("rejects DNS rebinding hosts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html", host: "attacker.example" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("manages task state and confirmed memory with provenance", async () => {
    const page = await app.inject({
      method: "GET",
      url: "/projects",
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
      url: "/v1/dashboard/projects/one-status",
      headers,
      payload: { name: "One Status", makeActive: true },
    });
    const task = await app.inject({
      method: "PUT",
      url: "/v1/dashboard/tasks/phase%3Aoauth",
      headers,
      payload: {
        title: "Complete OAuth",
        projectId: "one-status",
        status: "in_progress",
        completed: ["Google"],
        next: ["Slack"],
      },
    });
    expect(task.statusCode).toBe(200);
    expect(backend.status.tasks["phase:oauth"]).toMatchObject({
      title: "Complete OAuth",
      status: "in_progress",
      next: ["Slack"],
    });

    const createdMemory = await app.inject({
      method: "POST",
      url: "/v1/dashboard/memories",
      headers,
      payload: {
        scope: "project",
        projectId: "one-status",
        content: "Use PKCE",
        tags: ["oauth"],
      },
    });
    expect(createdMemory.statusCode).toBe(200);
    expect(backend.status.memory[0]).toMatchObject({
      state: "confirmed",
      origin: { type: "manual", label: "One Status Dashboard" },
    });

    const candidateId = "legacy-memory";
    backend.status.memory.push({
      id: candidateId,
      scope: "user",
      content: "Candidate",
      tags: [],
      state: "candidate",
      origin: { type: "agent", label: "codex" },
      createdByAgentId: "codex",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const confirmed = await app.inject({
      method: "PUT",
      url: `/v1/dashboard/memories/${candidateId}/confirm`,
      headers,
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    expect(
      backend.status.memory.find((entry) => entry.id === candidateId)?.state,
    ).toBe("confirmed");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/dashboard/tasks/phase%3Aoauth",
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(backend.status.tasks["phase:oauth"]).toBeUndefined();
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
    expect(slackAuthorizationUrl.searchParams.get("user_scope")?.split(",")).toEqual([
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "search:read",
      "chat:write",
    ]);
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

  it("imports a Trello user Token through the encrypted local Vault", async () => {
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
      url: "/v1/dashboard/oauth/providers/trello/config",
      headers,
      payload: { clientId: "trello-api-key" },
    });
    expect(configured.statusCode).toBe(200);

    const oauthStart = await app.inject({
      method: "POST",
      url: "/v1/dashboard/oauth/providers/trello/start",
      headers,
      payload: {},
    });
    expect(oauthStart.statusCode).toBe(422);

    let trelloRequest = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        trelloRequest += 1;
        const authorization = new Headers(init?.headers).get("authorization");
        expect(authorization).toContain('oauth_consumer_key="trello-api-key"');
        expect(authorization).toContain('oauth_token="trello-user-token"');
        if (trelloRequest === 2) {
          expect(String(input)).toContain(
            "https://api.trello.com/1/tokens/trello-user-token",
          );
          return new Response(
            JSON.stringify({
              permissions: [{ read: true, write: false }],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        expect(String(input)).toBe(
          "https://api.trello.com/1/members/me?fields=id,username,fullName",
        );
        return new Response(
          JSON.stringify({
            fullName: "Ryan",
            id: "trello-user-1",
            username: "ryan",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );

    const imported = await app.inject({
      method: "POST",
      url: "/v1/dashboard/oauth/providers/trello/import-token",
      headers,
      payload: { accessToken: "trello-user-token" },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.body).not.toContain("trello-user-token");
    expect(imported.json().connection).toMatchObject({
      accountId: "trello-user-1",
      label: "ryan",
      provider: "trello",
      scopes: ["read"],
      source: "imported",
    });
    expect(
      permissionVault.getConnectionWithCredential(
        "user-1",
        imported.json().connection.id,
      )?.credential.accessToken,
    ).toBe("trello-user-token");
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

    const crossProviderState = await start();
    const crossProvider = await app.inject({
      method: "GET",
      url: `/oauth/github/callback?code=unused&state=${crossProviderState}`,
      headers: { host: "127.0.0.1:8787" },
    });
    expect(crossProvider.statusCode).toBe(303);
    expect(crossProvider.headers.location).toBe(
      "/integrations?oauth=error&provider=github&reason=invalid_oauth_state",
    );

    const crossProviderReplay = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?code=unused&state=${crossProviderState}`,
      headers: { host: "127.0.0.1:8787" },
    });
    expect(crossProviderReplay.statusCode).toBe(303);
    expect(crossProviderReplay.headers.location).toBe(
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
    expect(script.body).toContain("import-inventory-project");
    expect(script.body).toContain('data.get("git") === "true"');
    expect(script.body).toContain('data-form="task"');
    expect(script.body).toContain("confirm-memory");
    expect(script.body).toContain("Agent Permission Firewall");
    expect(script.body).toContain("auditEvents");
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

  it("issues an Agent credential from the remote profile with an empty local sync DB", async () => {
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

    const credential = await issueAgentCredential(
      app,
      remoteProfile.token,
      "codex",
    );
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/tools",
      headers: {
        authorization: `Bearer ${credential.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      connections: [
        {
          actions: [
            {
              id: "github.viewer.get",
              inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
              readOnly: true,
              requiresConfirmation: false,
            },
          ],
          connection: { id: connection.id, provider: "github" },
        },
      ],
    });
    expect(authorized.body).not.toContain("encrypted-in-vault");

    const deviceBearer = await app.inject({
      method: "GET",
      url: "/v1/tools",
      headers: {
        authorization: `Bearer ${remoteProfile.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(deviceBearer.statusCode).toBe(401);
    expect(deviceBearer.json()).toMatchObject({
      error: { code: "agent_credential_required" },
    });

    const spoofedIdentity = await app.inject({
      method: "GET",
      url: "/v1/tools?agentId=claude-code",
      headers: {
        authorization: `Bearer ${credential.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(spoofedIdentity.statusCode).toBe(403);
    expect(spoofedIdentity.json()).toMatchObject({
      error: { code: "agent_identity_mismatch" },
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
      url: "/v1/tools",
      headers: {
        authorization: `Bearer ${credential.token}`,
        host: "os.example.test",
      },
    });
    expect(publicHost.statusCode).toBe(403);

    remoteProfile.tokenExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const expired = await app.inject({
      method: "POST",
      url: "/v1/tools/credentials",
      headers: {
        authorization: `Bearer ${remoteProfile.token}`,
        host: "127.0.0.1:8787",
      },
      payload: { agentId: "claude-code" },
    });
    expect(expired.statusCode).toBe(401);

    remoteProfile.tokenExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/tools/credentials/${credential.credentialId}`,
      headers: {
        authorization: `Bearer ${remoteProfile.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(revoked.statusCode).toBe(200);
    const revokedBearer = await app.inject({
      method: "GET",
      url: "/v1/tools",
      headers: {
        authorization: `Bearer ${credential.token}`,
        host: "127.0.0.1:8787",
      },
    });
    expect(revokedBearer.statusCode).toBe(401);
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
    permissionVault.setGrant(session.userId, connection.id, "claude-code", [
      "github.repositories.list",
    ]);

    const credential = await issueAgentCredential(app, session.token, "codex");
    const response = await app.inject({
      method: "GET",
      url: "/v1/tools",
      headers: {
        authorization: `Bearer ${credential.token}`,
        host: "127.0.0.1:8787",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connections: [
        {
          actions: [{ id: "github.viewer.get" }],
          connection: { id: connection.id },
        },
      ],
    });
    expect(response.body).not.toContain("github.repositories.list");
  });

  it("validates and forwards a one-time Tool Gateway approval ID", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "tool-confirmation@example.test",
        password: "tool confirmation password",
        deviceName: "Local Mac",
        initialEnvelope: encryptStatus(
          createEmptyStatus(),
          generateStatusKey(),
          1,
        ),
      },
    });
    expect(registration.statusCode).toBe(201);
    const session = registration.json<{ token: string; userId: string }>();
    const credential = await issueAgentCredential(app, session.token, "codex");
    const execute = vi
      .spyOn(ToolGateway.prototype, "execute")
      .mockResolvedValue({ number: 7 });
    const payload = {
      action: "github.issues.create",
      approvalId: "8aac7c59-f780-4ebb-a72e-b3c9ecbbf999",
      arguments: {
        owner: "one-status",
        repo: "core",
        title: "Confirm tool writes",
      },
      connectionId: "2cc16694-140d-4575-8189-3283163c15c7",
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ result: { number: 7 } });
      expect(execute).toHaveBeenCalledWith({
        ...payload,
        agentId: "codex",
        userId: session.userId,
      });

      const invalid = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: { ...payload, confirmed: true },
      });
      expect(invalid.statusCode).toBe(400);
      expect(execute).toHaveBeenCalledTimes(1);

      const spoofed = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: { ...payload, agentId: "claude-code" },
      });
      expect(spoofed.statusCode).toBe(403);
      expect(spoofed.json()).toMatchObject({
        error: { code: "agent_identity_mismatch" },
      });
      expect(execute).toHaveBeenCalledTimes(1);

      execute.mockRejectedValueOnce(new ToolPermissionDeniedError());
      const denied = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({
        error: { code: "tool_permission_denied" },
      });

      execute.mockRejectedValueOnce(new ToolConnectionExpiredError(true));
      const expired = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload,
      });
      expect(expired.statusCode).toBe(409);
      expect(expired.json()).toMatchObject({
        error: {
          code: "tool_connection_expired",
          recoverableFromSync: true,
        },
      });

      execute.mockRejectedValueOnce(
        new ProviderRequestError(
          "Slack API request failed.",
          "provider_temporarily_unavailable",
          503,
        ),
      );
      const providerFailure = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload,
      });
      expect(providerFailure.statusCode).toBe(502);
      expect(providerFailure.json()).toMatchObject({
        error: {
          code: "provider_temporarily_unavailable",
          message: "Slack API request failed.",
        },
      });

      execute.mockRejectedValueOnce(
        new ProviderRequestError(
          "GitHub authorization is invalid.",
          "invalid_auth",
          401,
        ),
      );
      const invalidProviderAuthorization = await app.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${credential.token}`,
          host: "127.0.0.1:8787",
        },
        payload,
      });
      expect(invalidProviderAuthorization.statusCode).toBe(409);
      expect(invalidProviderAuthorization.json()).toMatchObject({
        error: { code: "provider_authorization_invalid" },
      });
    } finally {
      execute.mockRestore();
    }
  });

  it("enforces Dashboard approval, request binding, expiry, and route boundaries", async () => {
    let now = Date.parse("2026-08-09T10:00:00.000Z");
    const toolBackend = new MemoryDashboardBackend();
    const toolVault = new PermissionVault({
      path: ":memory:",
      key: new Uint8Array(32).fill(8),
    });
    const providerFetch = vi.fn<ProviderFetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://api.github.com/repos/one-status/core/issues",
      );
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          assignees: [],
          created_at: "2026-08-09T10:01:00Z",
          html_url: "https://github.com/one-status/core/issues/7",
          labels: [],
          number: 7,
          state: "open",
          title: "Ship approvals",
          updated_at: "2026-08-09T10:01:00Z",
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const toolGateway = new ToolGateway(toolVault, {
      fetch: providerFetch,
      now: () => now,
    });
    const toolApp = createApp({
      authRateLimit: false,
      dbPath: join(directory, "tool-approval.sqlite"),
      dashboard: {
        backend: toolBackend,
        handoffs: new TestHandoffRuntime(),
        inventory: {
          async get() {
            return inventorySnapshot;
          },
          async refresh() {
            return inventorySnapshot;
          },
        },
        permissionVault: toolVault,
        toolGateway,
      },
    });
    await toolApp.ready();

    try {
      const github = toolVault.upsertConnection({
        accountId: "github-user",
        credential: { accessToken: "github-access" },
        label: "ryan",
        provider: "github",
        scopes: ["repo"],
        userId: "user-1",
      });
      const githubAlternate = toolVault.upsertConnection({
        accountId: "github-user-alternate",
        credential: { accessToken: "github-access-alternate" },
        label: "ryan-alternate",
        provider: "github",
        scopes: ["repo"],
        userId: "user-1",
      });
      const slack = toolVault.upsertConnection({
        accountId: "slack-workspace",
        credential: { accessToken: "slack-access" },
        label: "One Status",
        provider: "slack",
        scopes: ["chat:write"],
        userId: "user-1",
      });
      for (const connectionId of [github.id, githubAlternate.id]) {
        toolVault.setGrant("user-1", connectionId, "codex", [
          "github.issues.create",
        ]);
      }
      toolVault.setGrant("user-1", github.id, "claude-code", [
        "github.issues.create",
      ]);
      toolVault.setGrant("user-1", slack.id, "codex", [
        "slack.messages.post",
      ]);
      const codexCredential = await issueAgentCredential(
        toolApp,
        "tool-token",
        "codex",
      );
      const otherUserCredential = await issueAgentCredential(
        toolApp,
        "other-tool-token",
        "codex",
      );

      const page = await toolApp.inject({
        method: "GET",
        url: "/integrations",
        headers: { accept: "text/html", host: "127.0.0.1:8787" },
      });
      const setCookie = page.headers["set-cookie"]!;
      const cookie = (
        Array.isArray(setCookie) ? setCookie[0]! : setCookie
      ).split(";")[0]!;
      const csrf = page.body.match(
        /name="one-status-csrf" content="([^"]+)"/,
      )?.[1];
      expect(csrf).toBeTruthy();
      const dashboardHeaders = {
        cookie,
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
        "x-one-status-csrf": csrf!,
      };
      const request = {
        action: "github.issues.create",
        agentId: "codex",
        arguments: {
          owner: "one-status",
          repo: "core",
          title: "Ship approvals",
        },
        connectionId: github.id,
      };

      const wrongBearer = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/approval-requests",
        headers: {
          authorization: "Bearer wrong-tool-token",
          host: "127.0.0.1:8787",
        },
        payload: request,
      });
      expect(wrongBearer.statusCode).toBe(401);

      const publicHost = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/approval-requests",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "os.example.test",
        },
        payload: request,
      });
      expect(publicHost.statusCode).toBe(403);

      const requested = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/approval-requests",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: request,
      });
      expect(requested.statusCode).toBe(200);
      const approval = requested.json().approval as { id: string };

      const snapshot = await toolApp.inject({
        method: "GET",
        url: "/v1/dashboard/snapshot",
        headers: { cookie, host: "127.0.0.1:8787" },
      });
      expect(snapshot.json().integrations.approvals).toEqual([
        expect.objectContaining({
          action: request.action,
          agentId: request.agentId,
          arguments: request.arguments,
          connectionId: github.id,
          id: approval.id,
          status: "pending",
        }),
      ]);

      const noCsrf = await toolApp.inject({
        method: "POST",
        url: `/v1/dashboard/tool-approvals/${approval.id}`,
        headers: { cookie, host: "127.0.0.1:8787" },
        payload: { decision: "approve" },
      });
      expect(noCsrf.statusCode).toBe(403);

      toolBackend.activeUserId = "user-2";
      const wrongDashboardUser = await toolApp.inject({
        method: "POST",
        url: `/v1/dashboard/tool-approvals/${approval.id}`,
        headers: dashboardHeaders,
        payload: { decision: "approve" },
      });
      expect(wrongDashboardUser.statusCode).toBe(409);
      toolBackend.activeUserId = "user-1";

      const approved = await toolApp.inject({
        method: "POST",
        url: `/v1/dashboard/tool-approvals/${approval.id}`,
        headers: dashboardHeaders,
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().approval).toMatchObject({ status: "approved" });

      const duplicateDecision = await toolApp.inject({
        method: "POST",
        url: `/v1/dashboard/tool-approvals/${approval.id}`,
        headers: dashboardHeaders,
        payload: { decision: "deny" },
      });
      expect(duplicateDecision.statusCode).toBe(409);

      const changedArguments = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          approvalId: approval.id,
          arguments: { ...request.arguments, title: "Changed after approval" },
        },
      });
      expect(changedArguments.statusCode).toBe(409);

      const changedAgent = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          agentId: "claude-code",
          approvalId: approval.id,
        },
      });
      expect(changedAgent.statusCode).toBe(403);
      expect(changedAgent.json()).toMatchObject({
        error: { code: "agent_identity_mismatch" },
      });

      const changedConnection = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          approvalId: approval.id,
          connectionId: githubAlternate.id,
        },
      });
      expect(changedConnection.statusCode).toBe(409);

      const changedAction = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          action: "slack.messages.post",
          agentId: "codex",
          approvalId: approval.id,
          arguments: { channel: "C123", text: "Changed action" },
          connectionId: slack.id,
        },
      });
      expect(changedAction.statusCode).toBe(409);

      const wrongUser = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${otherUserCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: { ...request, approvalId: approval.id },
      });
      expect(wrongUser.statusCode).toBe(403);

      const executed = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          action: request.action,
          agentId: request.agentId,
          approvalId: approval.id,
          arguments: {
            title: request.arguments.title,
            repo: request.arguments.repo,
            owner: request.arguments.owner,
          },
          connectionId: request.connectionId,
        },
      });
      expect(executed.statusCode).toBe(200);
      expect(executed.json().result).toMatchObject({ number: 7 });

      const replayed = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: { ...request, approvalId: approval.id },
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toEqual(executed.json());
      expect(providerFetch).toHaveBeenCalledTimes(1);

      const deniedRequest = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/approval-requests",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          arguments: { ...request.arguments, title: "Reject this" },
        },
      });
      const deniedApproval = deniedRequest.json().approval as { id: string };
      const denied = await toolApp.inject({
        method: "POST",
        url: `/v1/dashboard/tool-approvals/${deniedApproval.id}`,
        headers: dashboardHeaders,
        payload: { decision: "deny" },
      });
      expect(denied.statusCode).toBe(200);
      const deniedExecution = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          approvalId: deniedApproval.id,
          arguments: { ...request.arguments, title: "Reject this" },
        },
      });
      expect(deniedExecution.statusCode).toBe(409);

      const expiringRequest = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/approval-requests",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          arguments: { ...request.arguments, title: "Expire this" },
        },
      });
      const expiringApproval = expiringRequest.json().approval as { id: string };
      now += 10 * 60_000 + 1;

      const expiredSnapshot = await toolApp.inject({
        method: "GET",
        url: "/v1/dashboard/snapshot",
        headers: { cookie, host: "127.0.0.1:8787" },
      });
      expect(
        expiredSnapshot
          .json()
          .integrations.approvals.some(
            (entry: { id: string }) => entry.id === expiringApproval.id,
          ),
      ).toBe(false);
      const expiredDecision = await toolApp.inject({
        method: "POST",
        url: `/v1/dashboard/tool-approvals/${expiringApproval.id}`,
        headers: dashboardHeaders,
        payload: { decision: "approve" },
      });
      expect(expiredDecision.statusCode).toBe(409);
      const expiredExecution = await toolApp.inject({
        method: "POST",
        url: "/v1/tools/execute",
        headers: {
          authorization: `Bearer ${codexCredential.token}`,
          host: "127.0.0.1:8787",
        },
        payload: {
          ...request,
          approvalId: expiringApproval.id,
          arguments: { ...request.arguments, title: "Expire this" },
        },
      });
      expect(expiredExecution.statusCode).toBe(409);
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      await toolApp.close();
    }
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

async function issueAgentCredential(
  targetApp: FastifyInstance,
  deviceToken: string,
  agentId: string,
): Promise<{
  agentId: string;
  credentialId: string;
  expiresAt: string;
  token: string;
}> {
  const response = await targetApp.inject({
    method: "POST",
    url: "/v1/tools/credentials",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      host: "127.0.0.1:8787",
    },
    payload: { agentId },
  });
  expect(response.statusCode).toBe(200);
  const credential = response.json().credential;
  expect(credential).toMatchObject({
    agentId,
    credentialId: expect.any(String),
    expiresAt: expect.any(String),
    token: expect.stringMatching(/^osa1_[A-Za-z0-9_-]{43}$/),
  });
  return credential;
}

class MemoryDashboardBackend implements DashboardBackend {
  activeUserId = "user-1";
  status: StatusDocument = createEmptyStatus();
  version = 1;

  async authenticateDevice(
    authorization?: string,
  ): Promise<{ deviceId: string; userId: string } | undefined> {
    if (authorization === "Bearer tool-token") {
      return { deviceId: "device-1", userId: "user-1" };
    }
    if (authorization === "Bearer other-tool-token") {
      return { deviceId: "device-2", userId: "user-2" };
    }
    return undefined;
  }

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
    return this.activeUserId;
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
      | "registerProjectPath"
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

  async registerProjectPath(projectId: string, path: string) {
    this.mappingPath = path;
    const now = new Date(0).toISOString();
    return { projectId, path, createdAt: now, updatedAt: now };
  }

  async overview() {
    return {
      activity: [],
      localPaths: [],
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
