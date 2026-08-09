import { z } from "zod";
import {
  oauthProviders,
  type OAuthCredential,
  type OAuthProvider,
  type OAuthProviderConfig,
} from "./permission-vault.js";

const REQUEST_TIMEOUT_MS = 15_000;
const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderAction {
  description: string;
  id: string;
  requiredScopes: string[];
  title: string;
}

export interface ProviderDefinition {
  actions: ProviderAction[];
  accent: string;
  requiresSecret: boolean;
  description: string;
  id: OAuthProvider;
  label: string;
  requiresPkce: boolean;
  scopes: string[];
}

export interface OAuthExchangeResult {
  accountId: string;
  credential: OAuthCredential;
  expiresAt: string | null;
  label: string;
  scopes: string[];
}

export interface ToolExecutionResult {
  data: unknown;
  providerRequestId?: string;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }

  get authorizationInvalid(): boolean {
    return (
      this.status === 401 ||
      [
        "account_inactive",
        "invalid_auth",
        "invalid_grant",
        "not_authed",
        "token_expired",
        "token_revoked",
      ].includes(this.code)
    );
  }
}

export const providerCatalog: Record<OAuthProvider, ProviderDefinition> = {
  google: {
    id: "google",
    label: "Google Calendar",
    description: "读取日历和即将开始的日程。",
    accent: "#4285f4",
    requiresPkce: true,
    requiresSecret: true,
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    actions: [
      {
        id: "calendar.events.list",
        title: "读取日历事件",
        description: "读取指定时间范围内的日程。",
        requiredScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
      },
    ],
  },
  github: {
    id: "github",
    label: "GitHub",
    description: "同步私有仓库并发布 Handoff；Agent 操作仍按授权控制。",
    accent: "#24292f",
    requiresPkce: false,
    requiresSecret: true,
    scopes: ["read:user", "user:email", "repo"],
    actions: [
      {
        id: "github.viewer.get",
        title: "读取 GitHub 资料",
        description: "读取已连接 GitHub 账号的公开资料。",
        requiredScopes: ["read:user"],
      },
      {
        id: "github.repositories.list",
        title: "读取仓库列表",
        description: "读取已连接账号可见的仓库。",
        requiredScopes: [],
      },
    ],
  },
  slack: {
    id: "slack",
    label: "Slack",
    description: "读取授权用户可访问的 Workspace 和频道信息。",
    accent: "#36c5f0",
    requiresPkce: true,
    requiresSecret: false,
    scopes: ["channels:read", "groups:read"],
    actions: [
      {
        id: "slack.channels.list",
        title: "读取 Slack 频道",
        description: "读取当前 App 可访问的公开及私有频道。",
        requiredScopes: ["channels:read", "groups:read"],
      },
    ],
  },
};

export function parseOAuthProvider(value: string): OAuthProvider {
  if ((oauthProviders as readonly string[]).includes(value)) {
    return value as OAuthProvider;
  }
  throw new Error(`Unsupported OAuth provider: ${value}`);
}

export function buildAuthorizationUrl(input: {
  codeChallenge: string;
  config: OAuthProviderConfig;
  provider: OAuthProvider;
  redirectUri: string;
  state: string;
}): string {
  const definition = providerCatalog[input.provider];
  if (input.provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    addQuery(url, {
      access_type: "offline",
      client_id: input.config.clientId,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      include_granted_scopes: "true",
      prompt: "consent",
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: definition.scopes.join(" "),
      state: input.state,
    });
    return url.toString();
  }
  if (input.provider === "github") {
    const url = new URL("https://github.com/login/oauth/authorize");
    addQuery(url, {
      client_id: input.config.clientId,
      redirect_uri: input.redirectUri,
      scope: definition.scopes.join(" "),
      state: input.state,
    });
    return url.toString();
  }
  const url = new URL("https://slack.com/oauth/v2/authorize");
  addQuery(url, {
    client_id: input.config.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: input.redirectUri,
    state: input.state,
    user_scope: definition.scopes.join(","),
  });
  url.searchParams.set("scope", "");
  return url.toString();
}

export async function exchangeOAuthCode(input: {
  code: string;
  codeVerifier: string;
  config: OAuthProviderConfig;
  fetch?: ProviderFetch;
  provider: OAuthProvider;
  redirectUri: string;
}): Promise<OAuthExchangeResult> {
  if (input.provider === "google") return exchangeGoogle(input);
  if (input.provider === "github") return exchangeGitHub(input);
  return exchangeSlack(input);
}

export async function refreshOAuthCredential(input: {
  config: OAuthProviderConfig;
  credential: OAuthCredential;
  fetch?: ProviderFetch;
  provider: OAuthProvider;
}): Promise<{
  credential: OAuthCredential;
  expiresAt: string | null;
  scopes?: string[];
}> {
  if (!input.credential.refreshToken) {
    throw new Error("The provider did not issue a refresh token.");
  }
  const endpoint =
    input.provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : input.provider === "github"
        ? "https://github.com/login/oauth/access_token"
        : "https://slack.com/api/oauth.v2.access";
  const values: Record<string, string> = {
    client_id: input.config.clientId,
    grant_type: "refresh_token",
    refresh_token: input.credential.refreshToken,
  };
  if (input.provider !== "slack") {
    values.client_secret = requiredClientSecret(input.config);
  }
  const payload = await postForm(input.fetch, endpoint, values);
  if (input.provider === "slack") {
    const slack = parseProviderPayload(
      slackRefreshResponseSchema,
      payload,
      "invalid_token_response",
    );
    if (!slack.ok) throw providerOAuthError("slack", slack.error);
    const userToken = parseProviderPayload(
      slackUserTokenSchema,
      slack.authed_user ?? slack,
      "invalid_token_response",
    );
    if (
      !userToken.access_token ||
      !userToken.refresh_token ||
      !userToken.expires_in
    ) {
      throw new ProviderRequestError(
        "Slack did not return a complete rotated user token.",
        "incomplete_token_rotation",
      );
    }
    return {
      credential: {
        accessToken: userToken.access_token,
        refreshToken: userToken.refresh_token,
        tokenType: userToken.token_type ?? input.credential.tokenType,
      },
      expiresAt: expiresAt(userToken.expires_in),
      scopes: userToken.scope ? splitScopes(userToken.scope, []) : undefined,
    };
  }
  const tokens = parseTokenResponse(payload);
  return {
    credential: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? input.credential.refreshToken,
      tokenType: tokens.token_type ?? input.credential.tokenType,
    },
    expiresAt: expiresAt(tokens.expires_in),
    scopes: tokens.scope ? splitScopes(tokens.scope, []) : undefined,
  };
}

export async function revokeOAuthCredential(input: {
  config: OAuthProviderConfig;
  credential: OAuthCredential;
  fetch?: ProviderFetch;
  provider: OAuthProvider;
}): Promise<void> {
  const fetch_ = input.fetch ?? globalThis.fetch;
  let response: Response;
  if (input.provider === "google") {
    response = await fetch_("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      body: new URLSearchParams({ token: input.credential.refreshToken ?? input.credential.accessToken }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } else if (input.provider === "github") {
    response = await fetch_(
      `https://api.github.com/applications/${encodeURIComponent(input.config.clientId)}/token`,
      {
        method: "DELETE",
        body: JSON.stringify({ access_token: input.credential.accessToken }),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Basic ${Buffer.from(`${input.config.clientId}:${requiredClientSecret(input.config)}`).toString("base64")}`,
          "content-type": "application/json",
          ...githubHeaders(),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } else {
    response = await fetch_("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.credential.accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
  if (!response.ok) {
    throw new ProviderRequestError(
      `Provider token revocation failed with HTTP ${response.status}.`,
      "revocation_failed",
      response.status,
    );
  }
  if (input.provider === "slack") {
    const body = parseProviderPayload(
      slackMethodResponseSchema,
      await readJson(response),
    );
    if (!body.ok) throw providerOAuthError("slack", body.error);
  }
}

export async function executeProviderAction(input: {
  action: string;
  arguments: unknown;
  credential: OAuthCredential;
  fetch?: ProviderFetch;
  provider: OAuthProvider;
}): Promise<ToolExecutionResult> {
  const token = input.credential.accessToken;
  if (input.provider === "google" && input.action === "calendar.events.list") {
    const arguments_ = googleEventsArgumentsSchema.parse(input.arguments ?? {});
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(arguments_.calendarId)}/events`,
    );
    addQuery(url, {
      maxResults: String(arguments_.maxResults),
      orderBy: "startTime",
      pageToken: arguments_.pageToken,
      singleEvents: "true",
      timeMax: arguments_.timeMax,
      timeMin: arguments_.timeMin,
    });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(googleEventsResponseSchema, response.body);
    return {
      data: {
        calendar: body.summary,
        items: body.items.map((event) => ({
          end: event.end?.dateTime ?? event.end?.date ?? null,
          id: event.id,
          location: event.location ?? null,
          start: event.start?.dateTime ?? event.start?.date ?? null,
          status: event.status ?? null,
          summary: event.summary ?? "(Untitled event)",
        })),
        nextPageToken: body.nextPageToken,
        timeZone: body.timeZone,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "github" && input.action === "github.viewer.get") {
    const response = await providerFetch(
      input.fetch,
      new URL("https://api.github.com/user"),
      token,
      githubHeaders(),
    );
    const viewer = parseProviderPayload(githubUserSchema, response.body);
    return {
      data: {
        avatarUrl: viewer.avatar_url,
        id: String(viewer.id),
        login: viewer.login,
        name: viewer.name ?? null,
        profileUrl: viewer.html_url,
      },
      providerRequestId: response.requestId,
    };
  }
  if (
    input.provider === "github" &&
    input.action === "github.repositories.list"
  ) {
    const arguments_ = githubRepositoriesArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL("https://api.github.com/user/repos");
    addQuery(url, {
      affiliation: "owner,collaborator,organization_member",
      page: String(arguments_.page),
      per_page: String(arguments_.perPage),
      sort: "updated",
    });
    const response = await providerFetch(
      input.fetch,
      url,
      token,
      githubHeaders(),
    );
    const repositories = parseProviderPayload(
      z.array(githubRepositorySchema).max(50),
      response.body,
    );
    return {
      data: {
        items: repositories.map((repository) => ({
          defaultBranch: repository.default_branch,
          fullName: repository.full_name,
          private: repository.private,
          pushedAt: repository.pushed_at,
          url: repository.html_url,
        })),
        page: arguments_.page,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "slack" && input.action === "slack.channels.list") {
    const arguments_ = slackChannelsArgumentsSchema.parse(input.arguments ?? {});
    const url = new URL("https://slack.com/api/conversations.list");
    addQuery(url, {
      cursor: arguments_.cursor,
      exclude_archived: "true",
      limit: String(arguments_.limit),
      types: "public_channel,private_channel",
    });
    const response = await providerFetch(input.fetch, url, token);
    const channels = parseProviderPayload(
      slackChannelsResponseSchema,
      response.body,
    );
    if (!channels.ok) throw providerApiError("slack", channels.error);
    return {
      data: {
        items: (channels.channels ?? []).map((channel) => ({
          id: channel.id,
          isMember: channel.is_member ?? false,
          name: channel.name,
          topic: channel.topic?.value ?? "",
        })),
        nextCursor: channels.response_metadata?.next_cursor || undefined,
      },
      providerRequestId: response.requestId,
    };
  }
  throw new Error(`Unsupported provider action: ${input.action}`);
}

async function exchangeGoogle(
  input: Parameters<typeof exchangeOAuthCode>[0],
): Promise<OAuthExchangeResult> {
  const payload = await postForm(
    input.fetch,
    "https://oauth2.googleapis.com/token",
    {
      client_id: input.config.clientId,
      client_secret: requiredClientSecret(input.config),
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    },
  );
  const tokens = parseTokenResponse(payload);
  const profileResponse = await providerFetch(
    input.fetch,
    new URL("https://openidconnect.googleapis.com/v1/userinfo"),
    tokens.access_token,
  );
  const profile = parseProviderPayload(googleProfileSchema, profileResponse.body);
  return {
    accountId: profile.sub,
    credential: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
    },
    expiresAt: expiresAt(tokens.expires_in),
    label: profile.email ?? profile.name ?? `Google ${profile.sub}`,
    scopes: splitScopes(tokens.scope, providerCatalog.google.scopes),
  };
}

async function exchangeGitHub(
  input: Parameters<typeof exchangeOAuthCode>[0],
): Promise<OAuthExchangeResult> {
  const payload = await postForm(
    input.fetch,
    "https://github.com/login/oauth/access_token",
    {
      client_id: input.config.clientId,
      client_secret: requiredClientSecret(input.config),
      code: input.code,
      redirect_uri: input.redirectUri,
    },
    { accept: "application/json" },
  );
  const tokens = parseTokenResponse(payload);
  const profileResponse = await providerFetch(
    input.fetch,
    new URL("https://api.github.com/user"),
    tokens.access_token,
    githubHeaders(),
  );
  const profile = parseProviderPayload(githubUserSchema, profileResponse.body);
  return {
    accountId: String(profile.id),
    credential: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
    },
    expiresAt: expiresAt(tokens.expires_in),
    label: profile.login,
    scopes: splitScopes(tokens.scope, providerCatalog.github.scopes),
  };
}

async function exchangeSlack(
  input: Parameters<typeof exchangeOAuthCode>[0],
): Promise<OAuthExchangeResult> {
  const payload = await postForm(
    input.fetch,
    "https://slack.com/api/oauth.v2.access",
    {
      client_id: input.config.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    },
  );
  const response = parseProviderPayload(
    slackOAuthResponseSchema,
    payload,
    "invalid_token_response",
  );
  const workspaceId = response.team?.id ?? response.enterprise?.id;
  const userToken = response.authed_user;
  if (
    !response.ok ||
    !workspaceId ||
    !userToken?.id ||
    !userToken.access_token ||
    !userToken.refresh_token ||
    !userToken.expires_in ||
    !userToken.scope
  ) {
    throw providerOAuthError("slack", response.error);
  }
  return {
    accountId: `${workspaceId}:${userToken.id}`,
    credential: {
      accessToken: userToken.access_token,
      refreshToken: userToken.refresh_token,
      tokenType: userToken.token_type,
    },
    expiresAt: expiresAt(userToken.expires_in),
    label:
      response.team?.name ??
      response.enterprise?.name ??
      `Slack ${workspaceId}`,
    scopes: splitScopes(userToken.scope, []),
  };
}

async function postForm(
  fetch_: ProviderFetch | undefined,
  url: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await (fetch_ ?? globalThis.fetch)(url, {
    method: "POST",
    body: new URLSearchParams(values),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = oauthErrorCode(body) ?? "oauth_request_failed";
    throw new ProviderRequestError(
      `OAuth token request failed with HTTP ${response.status}.`,
      code,
      response.status,
    );
  }
  if (body && typeof body === "object" && "error" in body && body.error) {
    throw providerOAuthError("provider", String(body.error));
  }
  return body;
}

async function providerFetch(
  fetch_: ProviderFetch | undefined,
  url: URL,
  accessToken: string,
  additionalHeaders: Record<string, string> = {},
): Promise<{ body: unknown; requestId?: string }> {
  const response = await (fetch_ ?? globalThis.fetch)(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...additionalHeaders,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new ProviderRequestError(
      `Provider API returned HTTP ${response.status}.`,
      providerApiErrorCode(body) ?? "provider_request_failed",
      response.status,
    );
  }
  return {
    body,
    requestId:
      response.headers.get("x-github-request-id") ??
      response.headers.get("x-slack-req-id") ??
      response.headers.get("x-request-id") ??
      undefined,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PROVIDER_RESPONSE_MAX_BYTES
  ) {
    await response.body?.cancel();
    throw providerResponseTooLarge();
  }

  try {
    if (!response.body) {
      return JSON.parse("");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PROVIDER_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw providerResponseTooLarge();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      "Provider returned an unreadable response.",
      "invalid_provider_response",
    );
  }
}

function providerResponseTooLarge(): ProviderRequestError {
  return new ProviderRequestError(
    "Provider response exceeded the allowed size.",
    "provider_response_too_large",
  );
}

function parseTokenResponse(
  payload: unknown,
): z.infer<typeof tokenResponseSchema> {
  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderRequestError(
      "OAuth provider returned an invalid token response.",
      "invalid_token_response",
    );
  }
  return parsed.data;
}

function parseProviderPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  code = "invalid_provider_response",
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderRequestError(
      "OAuth provider returned an invalid response.",
      code,
    );
  }
  return parsed.data;
}

function oauthErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  return safeProviderCode(String(body.error));
}

function providerApiErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  if ("error" in body && typeof body.error === "string") {
    return safeProviderCode(body.error);
  }
  return undefined;
}

function providerOAuthError(
  provider: "google" | "github" | "slack" | "provider",
  code?: string,
): ProviderRequestError {
  const safeCode = safeProviderCode(code ?? "oauth_request_failed");
  return new ProviderRequestError(
    `${providerLabel(provider)} OAuth request failed.`,
    safeCode,
  );
}

function providerApiError(
  provider: "google" | "github" | "slack",
  code?: string,
): ProviderRequestError {
  const safeCode = safeProviderCode(code ?? "provider_request_failed");
  return new ProviderRequestError(
    `${providerLabel(provider)} API request failed.`,
    safeCode,
  );
}

function providerLabel(
  provider: "google" | "github" | "slack" | "provider",
): string {
  if (provider === "provider") return "Provider";
  return providerCatalog[provider].label;
}

function safeProviderCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, 80) || "provider_request_failed";
}

function requiredClientSecret(config: OAuthProviderConfig): string {
  if (!config.clientSecret) {
    throw new ProviderRequestError(
      "OAuth provider configuration is missing a Client Secret.",
      "missing_client_secret",
    );
  }
  return config.clientSecret;
}

function githubHeaders(): Record<string, string> {
  return {
    "x-github-api-version": "2022-11-28",
    "user-agent": "one-status/0.2.0",
  };
}

function expiresAt(expiresIn?: number): string | null {
  return expiresIn
    ? new Date(Date.now() + expiresIn * 1_000).toISOString()
    : null;
}

function splitScopes(value: string | undefined, fallback: string[]): string[] {
  return value
    ? value.split(/[ ,]+/).map((scope) => scope.trim()).filter(Boolean)
    : fallback;
}

function addQuery(url: URL, values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
  }
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_000),
    refresh_token: z.string().min(1).max(32_000).optional(),
    token_type: z.string().max(120).optional(),
    expires_in: z.number().int().positive().max(315_360_000).optional(),
    scope: z.string().max(20_000).optional(),
  })
  .passthrough();

const googleProfileSchema = z
  .object({
    sub: z.string().min(1).max(500),
    email: z.string().max(500).optional(),
    name: z.string().max(500).optional(),
  })
  .passthrough();

const githubUserSchema = z
  .object({
    avatar_url: z.string().max(2_000),
    html_url: z.string().max(2_000),
    id: z.number(),
    login: z.string().min(1).max(500),
    name: z.string().max(500).nullable().optional(),
  })
  .passthrough();

const githubRepositorySchema = z
  .object({
    default_branch: z.string().max(500),
    full_name: z.string().max(500),
    html_url: z.string().max(2_000),
    private: z.boolean(),
    pushed_at: z.string().nullable(),
  })
  .passthrough();

const slackUserTokenSchema = z
  .object({
    access_token: z.string().min(1).max(32_000).optional(),
    expires_in: z.number().int().positive().max(315_360_000).optional(),
    id: z.string().min(1).max(500).optional(),
    refresh_token: z.string().min(1).max(32_000).optional(),
    scope: z.string().max(20_000).optional(),
    token_type: z.string().max(120).optional(),
  })
  .passthrough();

const slackOAuthResponseSchema = z
  .object({
    authed_user: slackUserTokenSchema.optional(),
    enterprise: z
      .object({
        id: z.string().max(500),
        name: z.string().max(500).optional(),
      })
      .nullable()
      .optional(),
    error: z.string().max(500).optional(),
    ok: z.boolean(),
    team: z
      .object({
        id: z.string().max(500),
        name: z.string().max(500).optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const slackRefreshResponseSchema = z
  .object({
    authed_user: slackUserTokenSchema.optional(),
    access_token: z.string().min(1).max(32_000).optional(),
    error: z.string().max(500).optional(),
    expires_in: z.number().int().positive().max(315_360_000).optional(),
    ok: z.boolean(),
    refresh_token: z.string().min(1).max(32_000).optional(),
    scope: z.string().max(20_000).optional(),
    token_type: z.string().max(120).optional(),
  })
  .passthrough();

const slackMethodResponseSchema = z
  .object({
    error: z.string().max(500).optional(),
    ok: z.boolean(),
  })
  .passthrough();

const googleEventsArgumentsSchema = z
  .object({
    calendarId: z.string().min(1).max(1_000).default("primary"),
    maxResults: z.number().int().min(1).max(50).default(20),
    pageToken: z.string().max(4_000).optional(),
    timeMin: z.iso.datetime({ offset: true }).default(() =>
      new Date().toISOString(),
    ),
    timeMax: z.iso.datetime({ offset: true }).default(() =>
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    ),
  })
  .strict()
  .refine((value) => Date.parse(value.timeMax) > Date.parse(value.timeMin), {
    message: "timeMax must be later than timeMin.",
    path: ["timeMax"],
  });

const googleEventsResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            end: z
              .object({ date: z.string().optional(), dateTime: z.string().optional() })
              .optional(),
            id: z.string().max(1_000),
            location: z.string().max(10_000).optional(),
            start: z
              .object({ date: z.string().optional(), dateTime: z.string().optional() })
              .optional(),
            status: z.string().max(120).optional(),
            summary: z.string().max(10_000).optional(),
          })
          .passthrough(),
      )
      .max(100)
      .default([]),
    nextPageToken: z.string().max(4_000).optional(),
    summary: z.string().max(10_000).optional(),
    timeZone: z.string().max(500).optional(),
  })
  .passthrough();

const githubRepositoriesArgumentsSchema = z
  .object({
    page: z.number().int().min(1).max(10_000).default(1),
    perPage: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const slackChannelsArgumentsSchema = z
  .object({
    cursor: z.string().max(4_000).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();

const slackChannelsResponseSchema = z
  .object({
    channels: z
      .array(
        z
          .object({
          id: z.string().max(500),
            is_member: z.boolean().optional(),
          name: z.string().max(500),
          topic: z.object({ value: z.string().max(10_000) }).optional(),
          })
          .passthrough(),
      )
      .max(200)
      .optional(),
    error: z.string().max(500).optional(),
    ok: z.boolean(),
    response_metadata: z
      .object({ next_cursor: z.string().max(4_000).optional() })
      .optional(),
  })
  .passthrough();
