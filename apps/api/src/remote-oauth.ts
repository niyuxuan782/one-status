import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

const nodeRequire = createRequire(import.meta.url);
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const ACCESS_TOKEN_PREFIX = "osmcp_";
const AUTHORIZATION_CODE_PREFIX = "osac_";
const CLIENT_ID_PREFIX = "osc_";
const REFRESH_TOKEN_PREFIX = "osmr_";
const MAX_DYNAMIC_CLIENTS = 10_000;
const PUBLIC_REQUEST_WINDOW_MS = 15 * 60_000;
const MAX_REGISTRATIONS_PER_WINDOW = 20;
const MAX_AUTHORIZATION_STARTS_PER_WINDOW = 120;
const MAX_TOKEN_REQUESTS_PER_WINDOW = 60;
const MAX_REFRESH_TOKENS_PER_FAMILY = 1_024;
const OAUTH_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PROJECT_SCOPE_PATTERN =
  /^project:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SENSITIVE_REMOTE_SCOPES = new Set([
  "tools:execute",
  "vault:read",
  "vault:write",
]);
const DEFAULT_ELIGIBLE_REMOTE_SCOPES = new Set([
  "status:read",
  "status:profile:read",
  "status:context:read",
  "status:memory:read",
]);

interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  disabled: number;
}

interface AuthorizationRequestRow {
  request_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  state: string | null;
  expires_at: string;
}

interface AuthorizationCodeRow {
  code_hash: string;
  user_id: string;
  client_id: string;
  agent_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: string;
  consumed_at: string | null;
}

interface RefreshTokenRow {
  token_hash: string;
  family_id: string;
  user_id: string;
  client_id: string;
  agent_id: string;
  scope: string;
  resource: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

interface AccessTokenRow {
  user_id: string;
  client_id: string;
  agent_id: string;
  scope: string;
  resource: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface RemoteOAuthOptions {
  allowProjectScopes?: boolean;
  consumeAccountProof(proofToken: string): { userId: string } | null;
  dbPath: string;
  defaultScopes?: readonly string[];
  issuer: string;
  resource: string;
  supportedScopes: readonly string[];
}

export class RemoteOAuthService implements OAuthTokenVerifier {
  readonly #allowProjectScopes: boolean;
  readonly #consumeAccountProof: RemoteOAuthOptions["consumeAccountProof"];
  readonly #database: import("node:sqlite").DatabaseSync;
  readonly #defaultScopes: string[];
  readonly #issuer: URL;
  readonly #resource: URL;
  readonly #requestLimiter = new RemoteOAuthRequestLimiter(
    PUBLIC_REQUEST_WINDOW_MS,
  );
  readonly #supportedScopes: Set<string>;

  constructor(options: RemoteOAuthOptions) {
    this.#allowProjectScopes = options.allowProjectScopes === true;
    this.#consumeAccountProof = options.consumeAccountProof;
    this.#issuer = securePublicUrl(options.issuer, "OAuth issuer");
    this.#resource = securePublicUrl(options.resource, "OAuth resource");
    this.#supportedScopes = new Set(options.supportedScopes);
    if (this.#supportedScopes.size === 0) {
      throw new Error("Remote OAuth requires at least one supported scope.");
    }
    this.#defaultScopes = normalizeDefaultScopes(
      options.defaultScopes ?? [],
      this.#supportedScopes,
    );
    const persistent = options.dbPath !== ":memory:";
    if (persistent) {
      const directory = dirname(options.dbPath);
      const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (created) chmodSync(directory, 0o700);
    }
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    this.#database = new DatabaseSync(options.dbPath);
    if (persistent) chmodSync(options.dbPath, 0o600);
    this.#database.exec("PRAGMA busy_timeout = 1000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
        request_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        state TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT,
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

      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
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

      CREATE INDEX IF NOT EXISTS oauth_access_tokens_expiry
        ON oauth_access_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS oauth_refresh_token_family
        ON oauth_refresh_tokens(family_id);

      CREATE TABLE IF NOT EXISTS oauth_audit (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        client_id TEXT,
        agent_id TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
    const accessTokenColumns = this.#database
      .prepare("PRAGMA table_info(oauth_access_tokens)")
      .all() as Array<{ name: string }>;
    if (!accessTokenColumns.some((column) => column.name === "family_id")) {
      this.#database.exec("SAVEPOINT migrate_oauth_access_token_family");
      try {
        this.#database.exec(`
          ALTER TABLE oauth_access_tokens ADD COLUMN family_id TEXT;

          UPDATE oauth_access_tokens
             SET family_id = (
               SELECT CASE
                        WHEN COUNT(DISTINCT refresh.family_id) = 1
                        THEN MIN(refresh.family_id)
                      END
                 FROM oauth_refresh_tokens AS refresh
                WHERE refresh.user_id = oauth_access_tokens.user_id
                  AND refresh.client_id = oauth_access_tokens.client_id
                  AND refresh.agent_id = oauth_access_tokens.agent_id
                  AND refresh.scope = oauth_access_tokens.scope
                  AND refresh.resource = oauth_access_tokens.resource
                  AND refresh.created_at = oauth_access_tokens.created_at
             )
           WHERE family_id IS NULL;
        `);
        this.#database.exec(
          "RELEASE SAVEPOINT migrate_oauth_access_token_family",
        );
      } catch (error) {
        this.#database.exec(
          "ROLLBACK TO SAVEPOINT migrate_oauth_access_token_family",
        );
        this.#database.exec(
          "RELEASE SAVEPOINT migrate_oauth_access_token_family",
        );
        throw error;
      }
    }
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS oauth_access_token_family
        ON oauth_access_tokens(family_id);
    `);
  }

  get issuer(): string {
    return this.#issuer.toString().replace(/\/$/u, "");
  }

  get resource(): string {
    return this.#resource.toString();
  }

  close(): void {
    this.#database.close();
  }

  recordAgentAction(input: {
    action: string;
    agentId: string;
    clientId: string;
    outcome: "attempted" | "failed" | "success";
    userId: string;
  }): void {
    this.#audit(
      input.userId,
      input.clientId,
      input.agentId,
      input.action,
      input.outcome,
    );
  }

  registerRoutes(app: FastifyInstance): void {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, formToRecord(body));
        } catch (error) {
          done(error as Error);
        }
      },
    );

    const metadata = () => this.metadata();
    app.get("/.well-known/oauth-authorization-server", metadata);
    app.get("/.well-known/oauth-authorization-server/oauth", metadata);
    app.get("/oauth/.well-known/oauth-authorization-server", metadata);

    app.post("/oauth/register", async (request, reply) => {
      try {
        this.#requestLimiter.consume(
          `register:${request.ip}`,
          MAX_REGISTRATIONS_PER_WINDOW,
        );
        this.#purgeExpiredState();
        const clientCount = this.#database
          .prepare("SELECT COUNT(*) AS count FROM oauth_clients")
          .get() as { count: number };
        if (clientCount.count >= MAX_DYNAMIC_CLIENTS) {
          return oauthError(
            reply,
            503,
            "temporarily_unavailable",
            "Dynamic client capacity has been reached.",
          );
        }
        const body = registrationSchema.parse(request.body);
        const redirectUris = body.redirect_uris.map(validateRedirectUri);
        const clientId = `${CLIENT_ID_PREFIX}${randomBytes(24).toString("base64url")}`;
        const now = new Date().toISOString();
        this.#database
          .prepare(
            `INSERT INTO oauth_clients
               (client_id, client_name, redirect_uris, disabled, created_at)
             VALUES (?, ?, ?, 0, ?)`,
          )
          .run(clientId, body.client_name, JSON.stringify(redirectUris), now);
        this.#audit(null, clientId, null, "client.register", "success");
        return reply.code(201).send({
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.parse(now) / 1_000),
          client_name: body.client_name,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      } catch (error) {
        if (error instanceof RemoteOAuthRateLimitError) {
          reply.header("retry-after", String(error.retryAfterSeconds));
          return oauthError(
            reply,
            429,
            "slow_down",
            "Too many OAuth requests. Try again later.",
          );
        }
        return oauthError(reply, 400, "invalid_client_metadata", safeValidationMessage(error));
      }
    });

    app.get("/oauth/authorize", async (request, reply) => {
      let authorization: AuthorizationInput;
      try {
        this.#requestLimiter.consume(
          `authorize:${request.ip}`,
          MAX_AUTHORIZATION_STARTS_PER_WINDOW,
        );
        this.#purgeExpiredState();
        authorization = this.#validateAuthorization(request.query);
      } catch (error) {
        if (error instanceof RemoteOAuthRateLimitError) {
          reply.header("retry-after", String(error.retryAfterSeconds));
          return reply
            .code(429)
            .type("text/html; charset=utf-8")
            .send(renderErrorPage("Too many authorization requests. Try again later."));
        }
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(renderErrorPage(safeValidationMessage(error)));
      }
      const requestToken = randomToken();
      const now = new Date();
      this.#database
        .prepare(
          `INSERT INTO oauth_authorization_requests
             (request_hash, client_id, redirect_uri, code_challenge, scope,
              resource, state, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hashSecret(requestToken),
          authorization.client.client_id,
          authorization.redirectUri,
          authorization.codeChallenge,
          authorization.scopes.join(" "),
          authorization.resource,
          authorization.state ?? null,
          new Date(now.getTime() + AUTHORIZATION_REQUEST_TTL_MS).toISOString(),
          now.toISOString(),
        );
      return reply
        .header("cache-control", "no-store")
        .header("content-security-policy", authorizationPageCsp)
        .type("text/html; charset=utf-8")
        .send(
          renderAuthorizationPage({
            clientName: authorization.client.client_name,
            redirectOrigin: new URL(authorization.redirectUri).origin,
            requestToken,
            scopes: authorization.scopes,
          }),
        );
    });

    app.post(
      "/oauth/authorize",
      { logLevel: "silent" },
      async (request, reply) => {
      const body = authorizationDecisionSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(renderErrorPage("The authorization form is invalid."));
      }
      const stored = this.#readAuthorizationRequest(body.data.request);
      if (!stored) {
        return reply
          .code(400)
          .type("text/html; charset=utf-8")
          .send(renderErrorPage("This authorization request expired. Start again from the Agent."));
      }
      if (body.data.decision === "deny") {
        this.#consumeAuthorizationRequest(stored.request_hash);
        this.#audit(null, stored.client_id, null, "authorization", "denied");
        return redirectAuthorizationResult(reply, stored, { error: "access_denied" });
      }
      const identity = this.#consumeAccountProof(body.data.accountProof);
      if (!identity) {
        const client = this.#readClient(stored.client_id);
        return reply
          .code(401)
          .header("cache-control", "no-store")
          .header("content-security-policy", authorizationPageCsp)
          .type("text/html; charset=utf-8")
          .send(
            renderAuthorizationPage({
              clientName: client?.client_name ?? "Remote Agent",
              error: "Account verification expired. Authenticate again.",
              redirectOrigin: new URL(stored.redirect_uri).origin,
              requestToken: body.data.request,
              scopes: splitScopes(stored.scope),
            }),
          );
      }
      const client = this.#readClient(stored.client_id);
      if (!client) {
        return reply.code(400).send(renderErrorPage("The OAuth client is no longer available."));
      }
      const code = `${AUTHORIZATION_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
      const now = new Date();
      const agentId = remoteAgentId(client);
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const consumed = this.#database
          .prepare("DELETE FROM oauth_authorization_requests WHERE request_hash = ?")
          .run(stored.request_hash);
        if (consumed.changes !== 1) throw new Error("Authorization request was already used.");
        this.#database
          .prepare(
            `INSERT INTO oauth_authorization_codes
               (code_hash, user_id, client_id, agent_id, redirect_uri,
                code_challenge, scope, resource, expires_at, consumed_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            hashSecret(code),
            identity.userId,
            stored.client_id,
            agentId,
            stored.redirect_uri,
            stored.code_challenge,
            stored.scope,
            stored.resource,
            new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
            now.toISOString(),
          );
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
      this.#audit(identity.userId, stored.client_id, agentId, "authorization", "approved");
      return redirectAuthorizationResult(reply, stored, { code });
      },
    );

    app.post("/oauth/token", { logLevel: "silent" }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      const form = tokenRequestSchema.safeParse(request.body);
      if (!form.success) {
        return oauthError(reply, 400, "invalid_request", "The token request is invalid.");
      }
      try {
        this.#requestLimiter.consume(
          `token:${form.data.client_id}:${request.ip}`,
          MAX_TOKEN_REQUESTS_PER_WINDOW,
        );
        this.#purgeExpiredState();
        const result =
          form.data.grant_type === "authorization_code"
            ? this.#exchangeAuthorizationCode(form.data)
            : this.#exchangeRefreshToken(form.data);
        return reply.send(result);
      } catch (error) {
        if (error instanceof RemoteOAuthRateLimitError) {
          reply.header("retry-after", String(error.retryAfterSeconds));
          return oauthError(
            reply,
            429,
            "slow_down",
            "Too many Token requests. Try again later.",
          );
        }
        return oauthError(reply, 400, "invalid_grant", safeValidationMessage(error));
      }
    });

    app.post("/oauth/revoke", { logLevel: "silent" }, async (request, reply) => {
      const form = revocationSchema.safeParse(request.body);
      if (form.success) this.#revokeToken(form.data.token, form.data.client_id);
      return reply.code(200).send();
    });
  }

  metadata(): Record<string, unknown> {
    const issuer = this.issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...this.#supportedScopes],
      resource_indicators_supported: true,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) throw new Error("Invalid access token.");
    const now = new Date().toISOString();
    const row = this.#database
      .prepare(
        `SELECT user_id, client_id, agent_id, scope, resource, expires_at, revoked_at
           FROM oauth_access_tokens
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(hashSecret(token), now) as unknown as AccessTokenRow | undefined;
    if (!row) throw new Error("Invalid access token.");
    this.#database
      .prepare("UPDATE oauth_access_tokens SET last_used_at = ? WHERE token_hash = ?")
      .run(now, hashSecret(token));
    return {
      token,
      clientId: row.client_id,
      scopes: splitScopes(row.scope),
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1_000),
      resource: new URL(row.resource),
      extra: { subject: row.user_id, agentId: row.agent_id },
    };
  }

  #validateAuthorization(value: unknown): AuthorizationInput {
    const query = authorizationQuerySchema.parse(value);
    const client = this.#readClient(query.client_id);
    if (!client) throw new Error("Unknown or disabled OAuth client.");
    const redirectUri = validateRedirectUri(query.redirect_uri);
    const registeredRedirects = JSON.parse(client.redirect_uris) as string[];
    if (!registeredRedirects.includes(redirectUri)) {
      throw new Error("The redirect URI is not registered for this client.");
    }
    const scopes = normalizeScopes(
      query.scope ?? this.#defaultScopes.join(" "),
      this.#supportedScopes,
      this.#allowProjectScopes,
    );
    if (
      scopes.some((scope) => SENSITIVE_REMOTE_SCOPES.has(scope)) &&
      !trustedSensitiveRedirect(redirectUri)
    ) {
      throw new Error(
        "Sensitive Agent scopes require a trusted connector redirect origin.",
      );
    }
    const resource = normalizeResource(query.resource ?? this.resource);
    if (resource !== normalizeResource(this.resource)) {
      throw new Error("The requested OAuth resource is not available.");
    }
    return {
      client,
      codeChallenge: query.code_challenge,
      redirectUri,
      resource,
      scopes,
      state: query.state,
    };
  }

  #readClient(clientId: string): OAuthClientRow | undefined {
    return this.#database
      .prepare(
        `SELECT client_id, client_name, redirect_uris, disabled
           FROM oauth_clients WHERE client_id = ? AND disabled = 0`,
      )
      .get(clientId) as unknown as OAuthClientRow | undefined;
  }

  #readAuthorizationRequest(token: string): AuthorizationRequestRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_hash, client_id, redirect_uri, code_challenge, scope,
                resource, state, expires_at
           FROM oauth_authorization_requests
          WHERE request_hash = ? AND expires_at > ?`,
      )
      .get(hashSecret(token), new Date().toISOString()) as unknown as
      | AuthorizationRequestRow
      | undefined;
  }

  #consumeAuthorizationRequest(requestHash: string): void {
    this.#database
      .prepare("DELETE FROM oauth_authorization_requests WHERE request_hash = ?")
      .run(requestHash);
  }

  #exchangeAuthorizationCode(
    form: Extract<TokenRequest, { grant_type: "authorization_code" }>,
  ): TokenResponse {
    const now = new Date();
    const row = this.#database
      .prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash = ?")
      .get(hashSecret(form.code)) as unknown as AuthorizationCodeRow | undefined;
    if (
      !row ||
      row.consumed_at ||
      Date.parse(row.expires_at) <= now.getTime() ||
      row.client_id !== form.client_id ||
      row.redirect_uri !== form.redirect_uri ||
      normalizeResource(row.resource) !== normalizeResource(form.resource ?? row.resource) ||
      !validCodeVerifier(form.code_verifier, row.code_challenge)
    ) {
      throw new Error("The authorization code is invalid or expired.");
    }
    let response: TokenResponse;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.#database
        .prepare(
          `UPDATE oauth_authorization_codes SET consumed_at = ?
            WHERE code_hash = ? AND consumed_at IS NULL`,
        )
        .run(now.toISOString(), row.code_hash);
      if (consumed.changes !== 1) throw new Error("The authorization code was already used.");
      response = this.#issueTokenPair(
        {
          userId: row.user_id,
          clientId: row.client_id,
          agentId: row.agent_id,
          scopes: splitScopes(row.scope),
          resource: row.resource,
        },
        randomUUID(),
        now,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#audit(row.user_id, row.client_id, row.agent_id, "token.issue", "success");
    return response;
  }

  #exchangeRefreshToken(
    form: Extract<TokenRequest, { grant_type: "refresh_token" }>,
  ): TokenResponse {
    const now = new Date();
    const row = this.#database
      .prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?")
      .get(hashSecret(form.refresh_token)) as unknown as RefreshTokenRow | undefined;
    if (!row || row.client_id !== form.client_id) {
      throw new Error("The refresh token is invalid.");
    }
    if (row.used_at || row.revoked_at) {
      this.#revokeFamily(row.family_id, now.toISOString());
      this.#audit(row.user_id, row.client_id, row.agent_id, "token.refresh_reuse", "blocked");
      throw new Error("The refresh token has already been used.");
    }
    if (
      Date.parse(row.expires_at) <= now.getTime() ||
      normalizeResource(row.resource) !== normalizeResource(form.resource ?? row.resource)
    ) {
      throw new Error("The refresh token is expired or has the wrong resource.");
    }
    const requestedScopes = form.scope
      ? normalizeScopes(form.scope, new Set(splitScopes(row.scope)), false)
      : splitScopes(row.scope);
    const familySize = this.#database
      .prepare(
        "SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE family_id = ?",
      )
      .get(row.family_id) as { count: number };
    if (familySize.count >= MAX_REFRESH_TOKENS_PER_FAMILY) {
      this.#revokeFamily(row.family_id, now.toISOString());
      this.#audit(
        row.user_id,
        row.client_id,
        row.agent_id,
        "token.refresh_limit",
        "blocked",
      );
      throw new Error("The refresh token family reached its rotation limit.");
    }
    let response: TokenResponse;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.#database
        .prepare(
          `UPDATE oauth_refresh_tokens SET used_at = ?
            WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now.toISOString(), row.token_hash);
      if (consumed.changes !== 1) throw new Error("The refresh token was already used.");
      response = this.#issueTokenPair(
        {
          userId: row.user_id,
          clientId: row.client_id,
          agentId: row.agent_id,
          scopes: requestedScopes,
          resource: row.resource,
        },
        row.family_id,
        now,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#audit(row.user_id, row.client_id, row.agent_id, "token.refresh", "success");
    return response;
  }

  #issueTokenPair(
    grant: {
      userId: string;
      clientId: string;
      agentId: string;
      scopes: string[];
      resource: string;
    },
    familyId: string,
    now: Date,
  ): TokenResponse {
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.#database
      .prepare(
        `INSERT INTO oauth_access_tokens
           (token_hash, family_id, user_id, client_id, agent_id, scope, resource,
            expires_at, revoked_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        hashSecret(accessToken),
        familyId,
        grant.userId,
        grant.clientId,
        grant.agentId,
        grant.scopes.join(" "),
        grant.resource,
        new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
        now.toISOString(),
      );
    this.#database
      .prepare(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, family_id, user_id, client_id, agent_id, scope,
            resource, expires_at, used_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        hashSecret(refreshToken),
        familyId,
        grant.userId,
        grant.clientId,
        grant.agentId,
        grant.scopes.join(" "),
        grant.resource,
        new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
        now.toISOString(),
      );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1_000),
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  #revokeToken(token: string, clientId: string): void {
    const hash = hashSecret(token);
    const now = new Date().toISOString();
    const access = this.#database
      .prepare(
        `SELECT family_id, user_id, agent_id FROM oauth_access_tokens
          WHERE token_hash = ? AND client_id = ?`,
      )
      .get(hash, clientId) as
      | { family_id: string | null; user_id: string; agent_id: string }
      | undefined;
    const refresh = this.#database
      .prepare(
        `SELECT family_id, user_id, agent_id FROM oauth_refresh_tokens
          WHERE token_hash = ? AND client_id = ?`,
      )
      .get(hash, clientId) as
      | { family_id: string; user_id: string; agent_id: string }
      | undefined;
    const familyId = access?.family_id ?? refresh?.family_id;
    if (familyId) {
      this.#revokeFamily(familyId, now);
    } else if (access) {
      this.#database
        .prepare(
          `UPDATE oauth_access_tokens SET revoked_at = ?
            WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL`,
        )
        .run(now, hash, clientId);
    }
    this.#audit(
      access?.user_id ?? refresh?.user_id ?? null,
      clientId,
      access?.agent_id ?? refresh?.agent_id ?? null,
      "token.revoke",
      access || refresh ? "success" : "unknown",
    );
  }

  #revokeFamily(familyId: string, now: string): void {
    this.#database.exec("SAVEPOINT revoke_oauth_token_family");
    try {
      this.#database
        .prepare(
          "UPDATE oauth_access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        )
        .run(now, familyId);
      this.#database
        .prepare(
          "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        )
        .run(now, familyId);
      this.#database.exec("RELEASE SAVEPOINT revoke_oauth_token_family");
    } catch (error) {
      this.#database.exec("ROLLBACK TO SAVEPOINT revoke_oauth_token_family");
      this.#database.exec("RELEASE SAVEPOINT revoke_oauth_token_family");
      throw error;
    }
  }

  #purgeExpiredState(): void {
    const now = new Date();
    const nowIso = now.toISOString();
    const retentionCutoff = new Date(
      now.getTime() - 7 * 24 * 60 * 60_000,
    ).toISOString();
    const auditCutoff = new Date(
      now.getTime() - OAUTH_AUDIT_RETENTION_MS,
    ).toISOString();
    this.#database.exec("SAVEPOINT purge_expired_oauth_state");
    try {
      this.#database
        .prepare("DELETE FROM oauth_authorization_requests WHERE expires_at <= ?")
        .run(nowIso);
      this.#database
        .prepare("DELETE FROM oauth_authorization_codes WHERE expires_at <= ?")
        .run(nowIso);
      this.#database
        .prepare(
          `DELETE FROM oauth_access_tokens
            WHERE expires_at <= ?
               OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
        )
        .run(retentionCutoff, retentionCutoff);
      this.#database
        .prepare("DELETE FROM oauth_audit WHERE occurred_at <= ?")
        .run(auditCutoff);
      this.#database
        .prepare(
          `DELETE FROM oauth_refresh_tokens
            WHERE expires_at <= ?
               OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
        )
        .run(retentionCutoff, retentionCutoff);
      this.#database.exec("RELEASE SAVEPOINT purge_expired_oauth_state");
    } catch (error) {
      this.#database.exec("ROLLBACK TO SAVEPOINT purge_expired_oauth_state");
      this.#database.exec("RELEASE SAVEPOINT purge_expired_oauth_state");
      throw error;
    }
  }

  #audit(
    userId: string | null,
    clientId: string | null,
    agentId: string | null,
    action: string,
    outcome: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO oauth_audit
           (id, user_id, client_id, agent_id, action, outcome, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), userId, clientId, agentId, action, outcome, new Date().toISOString());
  }
}

class RemoteOAuthRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("OAuth request rate limit exceeded.");
  }
}

class RemoteOAuthRequestLimiter {
  readonly #attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly windowMs: number) {}

  consume(key: string, limit: number): void {
    const now = Date.now();
    const current = this.#attempts.get(key);
    const entry =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + this.windowMs }
        : current;
    if (entry.count >= limit) {
      throw new RemoteOAuthRateLimitError(
        Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
      );
    }
    entry.count += 1;
    this.#attempts.set(key, entry);
    if (this.#attempts.size > 10_000) {
      for (const [storedKey, stored] of this.#attempts) {
        if (stored.resetAt <= now) this.#attempts.delete(storedKey);
      }
    }
  }
}

interface AuthorizationInput {
  client: OAuthClientRow;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state?: string;
}

type TokenRequest = z.infer<typeof tokenRequestSchema>;

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const registrationSchema = z
  .object({
    client_name: z.string().trim().min(1).max(120).default("Remote Agent"),
    redirect_uris: z.array(z.string().min(1).max(2_048)).min(1).max(20),
    token_endpoint_auth_method: z.literal("none").optional().default("none"),
    grant_types: z
      .array(z.enum(["authorization_code", "refresh_token"]))
      .optional(),
    response_types: z.array(z.literal("code")).optional(),
  })
  .passthrough();

const authorizationQuerySchema = z
  .object({
    response_type: z.literal("code"),
    client_id: z.string().min(1).max(500),
    redirect_uri: z.string().min(1).max(2_048),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    code_challenge_method: z.literal("S256"),
    scope: z.string().min(1).max(2_000).optional(),
    resource: z.string().url().max(2_048).optional(),
    state: z.string().max(2_048).optional(),
  })
  .strict();

const authorizationDecisionSchema = z
  .object({
    request: z.string().min(32).max(200),
    decision: z.enum(["allow", "deny"]),
    accountProof: z.string().regex(/^osp1_[A-Za-z0-9_-]{43}$/u).default(""),
  })
  .strict();

const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  z
    .object({
      grant_type: z.literal("authorization_code"),
      code: z.string().min(1).max(200),
      client_id: z.string().min(1).max(500),
      redirect_uri: z.string().min(1).max(2_048),
      code_verifier: z.string().min(43).max(128),
      resource: z.string().url().max(2_048).optional(),
    })
    .strict(),
  z
    .object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.string().min(1).max(200),
      client_id: z.string().min(1).max(500),
      resource: z.string().url().max(2_048).optional(),
      scope: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
]);

const revocationSchema = z
  .object({
    token: z.string().min(1).max(500),
    client_id: z.string().min(1).max(500),
    token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
  })
  .strict();

function formToRecord(body: string | Buffer): Record<string, string> {
  const parameters = new URLSearchParams(body.toString());
  const result: Record<string, string> = {};
  for (const [key, value] of parameters) {
    if (key in result) throw new Error("Duplicate OAuth form field.");
    result[key] = value;
  }
  return result;
}

function validateRedirectUri(value: string): string {
  const url = new URL(value);
  if (url.hash || url.username || url.password) {
    throw new Error("OAuth redirect URIs cannot contain fragments or credentials.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OAuth redirect URIs require HTTPS outside loopback.");
  }
  return url.toString();
}

function securePublicUrl(value: string, label: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} requires HTTPS outside loopback.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} cannot contain credentials, query, or fragment.`);
  }
  return url;
}

function normalizeResource(value: string): string {
  const url = securePublicUrl(value, "OAuth resource");
  return url.toString();
}

function normalizeScopes(
  value: string,
  allowed: Set<string>,
  allowProjectScopes = false,
): string[] {
  const scopes = [...new Set(value.split(/\s+/u).filter(Boolean))];
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        !allowed.has(scope) &&
        !(allowProjectScopes && PROJECT_SCOPE_PATTERN.test(scope)),
    )
  ) {
    throw new Error("The requested OAuth scope is not supported.");
  }
  return scopes;
}

function normalizeDefaultScopes(
  values: readonly string[],
  allowed: Set<string>,
): string[] {
  if (values.length === 0) return [];
  const scopes = normalizeScopes(values.join(" "), allowed, false);
  if (scopes.some((scope) => !DEFAULT_ELIGIBLE_REMOTE_SCOPES.has(scope))) {
    throw new Error("Remote OAuth defaults must contain only read-only Status scopes.");
  }
  return scopes;
}

function trustedSensitiveRedirect(value: string): boolean {
  const url = new URL(value);
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(url.hostname.toLowerCase())
  ) {
    return true;
  }
  const hostname = url.hostname.toLowerCase();
  return ["anthropic.com", "chatgpt.com", "claude.ai", "openai.com"].some(
    (trusted) => hostname === trusted || hostname.endsWith(`.${trusted}`),
  );
}

function splitScopes(value: string): string[] {
  return value.split(/\s+/u).filter(Boolean);
}

function validCodeVerifier(verifier: string, expectedChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expectedChallenge);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function remoteAgentId(client: OAuthClientRow): string {
  const slug = client.client_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48) || "remote-agent";
  return `remote:${slug}:${client.client_id.slice(-8)}`;
}

function redirectAuthorizationResult(
  reply: FastifyReply,
  request: Pick<AuthorizationRequestRow, "redirect_uri" | "state">,
  result: { code: string } | { error: string },
): FastifyReply {
  const target = new URL(request.redirect_uri);
  if ("code" in result) target.searchParams.set("code", result.code);
  else target.searchParams.set("error", result.error);
  if (request.state) target.searchParams.set("state", request.state);
  return reply.header("cache-control", "no-store").redirect(target.toString(), 302);
}

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply.code(status).send({ error, error_description: description });
}

function safeValidationMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "The OAuth request is invalid.";
  if (error instanceof Error && error.message.length <= 300) return error.message;
  return "The OAuth request could not be completed.";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAuthorizationPage(input: {
  clientName: string;
  error?: string;
  redirectOrigin: string;
  requestToken: string;
  scopes: string[];
}): string {
  const scopeItems = input.scopes
    .map((scope) => `<li>${escapeHtml(scopeDescription(scope))}</li>`)
    .join("");
  const error = input.error
    ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to One Status</title><style>
body{margin:0;background:#f5f6f8;color:#17202a;font:15px system-ui,sans-serif}main{width:min(440px,calc(100% - 32px));margin:8vh auto;background:#fff;border:1px solid #d9dee5;border-radius:8px;padding:28px;box-sizing:border-box}h1{font-size:22px;margin:0 0 8px}p{line-height:1.5;color:#53606d}ul{padding-left:20px;line-height:1.7}.field{display:grid;gap:6px;margin:15px 0}.field input{font:inherit;padding:10px 11px;border:1px solid #aeb7c2;border-radius:6px}.actions{display:flex;gap:10px;margin-top:22px}.actions button{font:600 14px system-ui;padding:10px 15px;border:1px solid #aeb7c2;border-radius:6px;background:#fff;cursor:pointer}.actions .primary{background:#16745b;color:#fff;border-color:#16745b}.error{color:#a12622;background:#fff0ef;padding:9px;border-radius:5px}</style></head>
<body><main><h1>Connect ${escapeHtml(input.clientName)}</h1><p>Verified redirect: <strong>${escapeHtml(input.redirectOrigin)}</strong></p><p>This Agent requests access to your One Status account:</p><ul>${scopeItems}</ul>${error}
<form method="post" action="/oauth/authorize" autocomplete="on" data-opaque-authorization><input type="hidden" name="request" value="${escapeHtml(input.requestToken)}"><input type="hidden" name="accountProof" value=""><input type="hidden" name="decision" value="deny">
<label class="field">Email<input id="one-status-email" type="email" required autocomplete="username"></label>
<label class="field">Password<input id="one-status-password" type="password" required autocomplete="current-password"></label>
<p class="error" role="alert" data-opaque-error hidden></p>
<div class="actions"><button type="button" data-decision="deny">Cancel</button><button class="primary" type="button" data-decision="allow">Connect</button></div></form></main><script type="module" src="/v1/auth/opaque-authorize.js"></script></body></html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>One Status OAuth</title></head><body><main><h1>Authorization could not continue</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function scopeDescription(scope: string): string {
  const descriptions: Record<string, string> = {
    "status:read": "Read your permitted profile, context, and confirmed memory",
    "status:profile:read": "Read your permitted profile and preferences",
    "status:context:read": "Read your current project and task context",
    "status:memory:read": "Read your confirmed One Status memory",
    "devices:read": "View your One Status devices and their online state",
    "tools:read": "View connected-service actions available to this Agent",
    "tools:execute": "Run permitted connected-service actions through an online device",
    "vault:read": "Resolve and read credentials permitted for this Agent",
    "vault:write": "Register, update, and delete credentials at your request",
  };
  if (scope.startsWith("project:")) {
    return `Use project-scoped credentials for ${scope.slice("project:".length)}`;
  }
  return descriptions[scope] ?? scope;
}

const authorizationPageCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
