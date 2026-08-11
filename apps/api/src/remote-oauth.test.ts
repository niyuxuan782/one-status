import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import {
  remoteMcpDefaultScopes,
  remoteMcpScopes,
} from "@one-status/mcp/remote";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteOAuthService,
  type RemoteOAuthOptions,
} from "./remote-oauth.js";

const resource = "https://mcp.os.example.test/mcp";
const issuer = "https://os.example.test";
const scopes = [
  "status:read",
  "status:profile:read",
  "status:context:read",
  "status:memory:read",
] as const;
const openServices: RemoteOAuthService[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const service of openServices.splice(0)) service.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("RemoteOAuthService", () => {
  it("completes PKCE authorization, refresh rotation, and revocation", async () => {
    const { app, service } = fixture();
    const client = await registerClient(app);
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await app.inject({
      method: "GET",
      url:
        "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: "https://agent.example.test/oauth/callback",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "status:profile:read status:memory:read",
          resource,
          state: "client-state",
        }),
    });
    expect(authorize.statusCode).toBe(200);
    expect(authorize.headers["cache-control"]).toBe("no-store");
    expect(authorize.body).not.toContain(challenge);
    const requestToken = authorize.body.match(/name="request" value="([^"]+)"/u)?.[1];
    expect(requestToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const decision = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        request: requestToken!,
        decision: "allow",
        accountProof,
      }).toString(),
    });
    expect(decision.statusCode).toBe(302);
    const callback = new URL(String(decision.headers.location));
    expect(callback.searchParams.get("state")).toBe("client-state");
    const code = callback.searchParams.get("code");
    expect(code).toMatch(/^osac_/u);

    const tokens = await exchangeCode(app, {
      clientId: client.client_id,
      code: code!,
      verifier,
    });
    expect(tokens.access_token).toMatch(/^osmcp_/u);
    expect(tokens.refresh_token).toMatch(/^osmr_/u);
    expect(tokens.scope).toBe("status:profile:read status:memory:read");
    const auth = await service.verifyAccessToken(tokens.access_token);
    expect(auth).toMatchObject({
      clientId: client.client_id,
      scopes: ["status:profile:read", "status:memory:read"],
      extra: { subject: "user-1" },
    });
    expect(String(auth.extra?.agentId)).toMatch(/^remote:test-agent:/u);
    expect(auth.resource?.toString()).toBe(resource);

    const refreshed = await refresh(app, client.client_id, tokens.refresh_token);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    const reuse = await refreshResponse(app, client.client_id, tokens.refresh_token);
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toMatchObject({ error: "invalid_grant" });
    await expect(service.verifyAccessToken(tokens.access_token)).rejects.toThrow(
      "Invalid access token",
    );
    await expect(service.verifyAccessToken(refreshed.access_token)).rejects.toThrow(
      "Invalid access token",
    );
    const revokedFamily = await refreshResponse(
      app,
      client.client_id,
      refreshed.refresh_token,
    );
    expect(revokedFamily.statusCode).toBe(400);
  });

  it("revokes the complete refresh family when given an access token", async () => {
    const { app, service } = fixture();
    const client = await registerClient(app);
    const verifier = "r".repeat(64);
    const code = await authorize(app, client.client_id, verifier);
    const tokens = await exchangeCode(app, {
      clientId: client.client_id,
      code,
      verifier,
    });
    const refreshed = await refresh(app, client.client_id, tokens.refresh_token);

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        token: tokens.access_token,
        client_id: client.client_id,
      }).toString(),
    });

    expect(revoke.statusCode).toBe(200);
    await expect(service.verifyAccessToken(tokens.access_token)).rejects.toThrow(
      "Invalid access token",
    );
    await expect(service.verifyAccessToken(refreshed.access_token)).rejects.toThrow(
      "Invalid access token",
    );
    const refreshAfterRevoke = await refreshResponse(
      app,
      client.client_id,
      refreshed.refresh_token,
    );
    expect(refreshAfterRevoke.statusCode).toBe(400);
    expect(refreshAfterRevoke.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("migrates legacy access tokens and revokes them with their refresh family", async () => {
    const directory = mkdtempSync(join(tmpdir(), "one-status-oauth-migration-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "oauth.sqlite");
    const accessToken = `osmcp_${"a".repeat(43)}`;
    const refreshToken = `osmr_${"b".repeat(43)}`;
    const clientId = "osc_legacy-client";
    const createdAt = "2026-08-01T00:00:00.000Z";
    const expiresAt = "2099-08-01T00:00:00.000Z";
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE oauth_access_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO oauth_access_tokens
           (token_hash, user_id, client_id, agent_id, scope, resource,
            expires_at, revoked_at, created_at, last_used_at)
         VALUES (?, 'user-1', ?, 'remote:legacy', 'status:read', ?, ?, NULL, ?, NULL)`,
      )
      .run(tokenHash(accessToken), clientId, resource, expiresAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, family_id, user_id, client_id, agent_id, scope,
            resource, expires_at, used_at, revoked_at, created_at)
         VALUES (?, 'legacy-family', 'user-1', ?, 'remote:legacy',
                 'status:read', ?, ?, NULL, NULL, ?)`,
      )
      .run(tokenHash(refreshToken), clientId, resource, expiresAt, createdAt);
    legacy.close();

    const { app, service } = fixture({ dbPath });
    await expect(service.verifyAccessToken(accessToken)).resolves.toMatchObject({
      clientId,
      extra: { subject: "user-1" },
    });

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    expect(revoke.statusCode).toBe(200);
    await expect(service.verifyAccessToken(accessToken)).rejects.toThrow(
      "Invalid access token",
    );
  });

  it("revokes a legacy access token that has no refresh family", async () => {
    const directory = mkdtempSync(join(tmpdir(), "one-status-oauth-legacy-access-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "oauth.sqlite");
    const accessToken = `osmcp_${"c".repeat(43)}`;
    const clientId = "osc_legacy-access-only";
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE oauth_access_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO oauth_access_tokens
           (token_hash, user_id, client_id, agent_id, scope, resource,
            expires_at, revoked_at, created_at, last_used_at)
         VALUES (?, 'user-1', ?, 'remote:legacy-access-only', 'status:read', ?,
                 '2099-08-01T00:00:00.000Z', NULL, '2026-08-01T00:00:00.000Z', NULL)`,
      )
      .run(tokenHash(accessToken), clientId, resource);
    legacy.close();

    const { app, service } = fixture({ dbPath });
    await expect(service.verifyAccessToken(accessToken)).resolves.toMatchObject({
      clientId,
      extra: { subject: "user-1" },
    });

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        token: accessToken,
        client_id: clientId,
      }).toString(),
    });

    expect(revoke.statusCode).toBe(200);
    await expect(service.verifyAccessToken(accessToken)).rejects.toThrow(
      "Invalid access token",
    );
  });

  it("rejects an unregistered redirect and a wrong verifier", async () => {
    const { app } = fixture();
    const client = await registerClient(app);
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const invalidRedirect = await app.inject({
      method: "GET",
      url:
        "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: "https://attacker.example.test/callback",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "status:read",
          resource,
        }),
    });
    expect(invalidRedirect.statusCode).toBe(400);
    expect(invalidRedirect.body).toContain("not registered");

    const code = await authorize(app, client.client_id, verifier);
    const invalidVerifier = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "https://agent.example.test/oauth/callback",
        code_verifier: "b".repeat(64),
        resource,
      }).toString(),
    });
    expect(invalidVerifier.statusCode).toBe(400);
    expect(invalidVerifier.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("publishes authorization metadata and enforces secure client redirects", async () => {
    const { app } = fixture();
    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(metadata.json()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });

    const insecure = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        client_name: "Unsafe client",
        redirect_uris: ["http://agent.example.test/callback"],
        token_endpoint_auth_method: "none",
      },
    });
    expect(insecure.statusCode).toBe(400);
    expect(insecure.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("uses configured read-only Status scopes when a client omits scope", async () => {
    const { app, service } = fixture({
      defaultScopes: remoteMcpDefaultScopes,
      supportedScopes: [...scopes, remoteMcpScopes.vaultRead],
    });
    const client = await registerClient(app);
    const verifier = "d".repeat(64);
    const response = await app.inject({
      method: "GET",
      url:
        "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: "https://agent.example.test/oauth/callback",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          resource,
        }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Read your permitted profile and preferences");
    expect(response.body).toContain("Read your current project and task context");
    expect(response.body).toContain("Read your confirmed One Status memory");
    expect(response.body).not.toContain("Resolve and read credentials");
    expect(response.body).toContain('href="https://os.example.test/privacy/"');
    expect(response.body).toContain('href="https://os.example.test/terms/"');
    expect(response.body).toContain('href="https://os.example.test/support/"');

    const request = response.body.match(/name="request" value="([^"]+)"/u)?.[1];
    const approval = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        request: request!,
        decision: "allow",
        accountProof,
      }).toString(),
    });
    const code = new URL(String(approval.headers.location)).searchParams.get("code");
    const tokens = await exchangeCode(app, {
      clientId: client.client_id,
      code: code!,
      verifier,
    });
    expect(tokens.scope).toBe(remoteMcpDefaultScopes.join(" "));
    await expect(service.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
      scopes: [...remoteMcpDefaultScopes],
    });

    const refreshed = await refresh(app, client.client_id, tokens.refresh_token);
    expect(refreshed.scope).toBe(remoteMcpDefaultScopes.join(" "));
    await expect(service.verifyAccessToken(refreshed.access_token)).resolves.toMatchObject({
      scopes: [...remoteMcpDefaultScopes],
    });

    expect(() =>
      fixture({
        defaultScopes: [remoteMcpScopes.vaultRead],
        supportedScopes: [...scopes, remoteMcpScopes.vaultRead],
      }),
    ).toThrow("defaults must contain only read-only Status scopes");
  });

  it("rate limits unauthenticated dynamic client registration", async () => {
    const { app } = fixture();
    for (let index = 0; index < 20; index += 1) {
      const response = await app.inject({
        method: "POST",
        payload: {
          client_name: `Dynamic client ${index}`,
          redirect_uris: ["https://agent.example.test/oauth/callback"],
          token_endpoint_auth_method: "none",
        },
        url: "/oauth/register",
      });
      expect(response.statusCode).toBe(201);
    }
    const limited = await app.inject({
      method: "POST",
      payload: {
        client_name: "Dynamic client over limit",
        redirect_uris: ["https://agent.example.test/oauth/callback"],
        token_endpoint_auth_method: "none",
      },
      url: "/oauth/register",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ error: "slow_down" });
  });

  it("binds a user-approved project scope into the Access Token", async () => {
    const { app, service } = fixture({ allowProjectScopes: true });
    const client = await registerClient(app);
    const verifier = "p".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await app.inject({
      method: "GET",
      url:
        "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: "https://agent.example.test/oauth/callback",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "status:read project:one-status",
          resource,
        }),
    });
    expect(start.statusCode).toBe(200);
    expect(start.body).toContain("Verified redirect: <strong>https://agent.example.test</strong>");
    expect(start.body).toContain("Use project-scoped credentials for one-status");
    const request = start.body.match(/name="request" value="([^"]+)"/u)?.[1];
    const decision = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        request: request!,
        decision: "allow",
        accountProof,
      }).toString(),
    });
    const code = new URL(String(decision.headers.location)).searchParams.get("code");
    const tokens = await exchangeCode(app, {
      clientId: client.client_id,
      code: code!,
      verifier,
    });
    await expect(service.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
      scopes: ["status:read", "project:one-status"],
    });
  });

  it("limits sensitive scopes to trusted connector redirects", async () => {
    const { app } = fixture({ supportedScopes: [...scopes, "vault:read"] });
    const untrusted = await registerClient(app);
    const query = (clientId: string, redirectUri: string) =>
      "/oauth/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256")
          .update("t".repeat(64))
          .digest("base64url"),
        code_challenge_method: "S256",
        scope: "vault:read",
        resource,
      });
    const rejected = await app.inject({
      method: "GET",
      url: query(
        untrusted.client_id,
        "https://agent.example.test/oauth/callback",
      ),
    });
    expect(rejected.statusCode).toBe(400);

    const trusted = await registerClient(
      app,
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    const allowed = await app.inject({
      method: "GET",
      url: query(
        trusted.client_id,
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain(
      "Verified redirect: <strong>https://chatgpt.com</strong>",
    );
  });

  it("rate limits Token rotation per client and network origin", async () => {
    const { app } = fixture();
    const client = await registerClient(app);
    const verifier = "l".repeat(64);
    const code = await authorize(app, client.client_id, verifier);
    let tokens = await exchangeCode(app, {
      clientId: client.client_id,
      code,
      verifier,
    });
    for (let index = 0; index < 59; index += 1) {
      tokens = await refresh(app, client.client_id, tokens.refresh_token);
    }
    const limited = await refreshResponse(
      app,
      client.client_id,
      tokens.refresh_token,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "slow_down" });
  });

  it("consumes an OPAQUE account proof without receiving an account password", async () => {
    const proofs: string[] = [];
    const { app } = fixture({
      consumeAccountProof(proofToken) {
        proofs.push(proofToken);
        return proofToken === accountProof ? { userId: "user-1" } : null;
      },
    });
    const client = await registerClient(app);
    const verifier = "c".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await app.inject({
      method: "GET",
      url:
        "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: "https://agent.example.test/oauth/callback",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "status:read",
          resource,
        }),
    });
    const request = start.body.match(/name="request" value="([^"]+)"/u)?.[1];
    const decision = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        request: request!,
        decision: "allow",
        accountProof,
      }).toString(),
    });

    expect(decision.statusCode).toBe(302);
    expect(proofs).toEqual([accountProof]);
  });
});

function fixture(
  options: Partial<
    Pick<
      RemoteOAuthOptions,
      | "allowProjectScopes"
      | "consumeAccountProof"
      | "dbPath"
      | "defaultScopes"
      | "supportedScopes"
    >
  > = {},
) {
  const app = Fastify({ logger: false });
  const service = new RemoteOAuthService({
    allowProjectScopes: options.allowProjectScopes,
    consumeAccountProof:
      options.consumeAccountProof ??
      ((proofToken) =>
        proofToken === accountProof ? { userId: "user-1" } : null),
    dbPath: options.dbPath ?? ":memory:",
    defaultScopes: options.defaultScopes,
    issuer,
    resource,
    supportedScopes: options.supportedScopes ?? scopes,
  });
  service.registerRoutes(app);
  openServices.push(service);
  return { app, service };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function registerClient(
  app: ReturnType<typeof Fastify>,
  redirectUri = "https://agent.example.test/oauth/callback",
) {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: {
      client_name: "Test Agent",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { client_id: string };
}

async function authorize(
  app: ReturnType<typeof Fastify>,
  clientId: string,
  verifier: string,
): Promise<string> {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await app.inject({
    method: "GET",
    url:
      "/oauth/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://agent.example.test/oauth/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "status:read",
        resource,
      }),
  });
  const request = start.body.match(/name="request" value="([^"]+)"/u)?.[1];
  const decision = await app.inject({
    method: "POST",
    url: "/oauth/authorize",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      request: request!,
      decision: "allow",
      accountProof,
    }).toString(),
  });
  return new URL(String(decision.headers.location)).searchParams.get("code")!;
}

const accountProof = `osp1_${"p".repeat(43)}`;

async function exchangeCode(
  app: ReturnType<typeof Fastify>,
  input: { clientId: string; code: string; verifier: string },
) {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      redirect_uri: "https://agent.example.test/oauth/callback",
      code_verifier: input.verifier,
      resource,
    }).toString(),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
}

async function refresh(
  app: ReturnType<typeof Fastify>,
  clientId: string,
  refreshToken: string,
) {
  const response = await refreshResponse(app, clientId, refreshToken);
  expect(response.statusCode).toBe(200);
  return response.json() as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
}

function refreshResponse(
  app: ReturnType<typeof Fastify>,
  clientId: string,
  refreshToken: string,
) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    }).toString(),
  });
}
