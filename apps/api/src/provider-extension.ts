import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  OAuthCredential,
  OAuthProvider,
  OAuthProviderConfig,
} from "./permission-vault.js";
import { ProviderRequestError } from "./provider-errors.js";

export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
export const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;

export type ExtensionProviderId = Exclude<
  OAuthProvider,
  "google" | "github" | "slack"
>;

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderActionDefinition {
  description: string;
  id: string;
  readOnly: boolean;
  requiredScopes: string[];
  requiresConfirmation: boolean;
  title: string;
}

export interface ProviderCatalogDefinition {
  actions: ProviderActionDefinition[];
  accent: string;
  authMode?: "oauth2" | "token";
  description: string;
  documentationUrl?: string;
  id: OAuthProvider;
  label: string;
  requiresPkce: boolean;
  requiresSecret: boolean;
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

export interface ProviderExtension {
  actionArgumentsSchema(action: string): z.ZodType;
  buildAuthorizationUrl(input: {
    codeChallenge: string;
    config: OAuthProviderConfig;
    redirectUri: string;
    state: string;
  }): string;
  definition: ProviderCatalogDefinition;
  exchangeOAuthCode(input: {
    code: string;
    codeVerifier: string;
    config: OAuthProviderConfig;
    fetch?: ProviderFetch;
    redirectUri: string;
  }): Promise<OAuthExchangeResult>;
  executeAction(input: {
    action: string;
    arguments: unknown;
    config?: OAuthProviderConfig;
    credential: OAuthCredential;
    fetch?: ProviderFetch;
  }): Promise<ToolExecutionResult>;
  id: ExtensionProviderId;
  refreshCredential(input: {
    config: OAuthProviderConfig;
    credential: OAuthCredential;
    fetch?: ProviderFetch;
  }): Promise<{
    credential: OAuthCredential;
    expiresAt: string | null;
    scopes?: string[];
  }>;
  revokeCredential(input: {
    config: OAuthProviderConfig;
    credential: OAuthCredential;
    fetch?: ProviderFetch;
  }): Promise<void>;
  tokenConnection?: {
    label: string;
    verify(input: {
      accessToken: string;
      config: OAuthProviderConfig;
      fetch?: ProviderFetch;
    }): Promise<{ accountId: string; label: string; scopes: string[] }>;
  };
}

export interface OAuth2ProviderModuleOptions {
  actionArgumentsSchema(action: string): z.ZodType;
  authorization: {
    extra?: Record<string, string>;
    scopeParameter?: string;
    scopeSeparator?: " " | ",";
    url: string;
  };
  definition: ProviderCatalogDefinition & { id: ExtensionProviderId };
  executeAction(input: {
    action: string;
    arguments: unknown;
    config?: OAuthProviderConfig;
    credential: OAuthCredential;
    fetch?: ProviderFetch;
  }): Promise<ToolExecutionResult>;
  profile(input: {
    fetch?: ProviderFetch;
    token: OAuthTokenPayload;
  }): Promise<{
    accountId: string;
    label: string;
    scopes?: string[];
  }>;
  revoke?(input: {
    config: OAuthProviderConfig;
    credential: OAuthCredential;
    fetch?: ProviderFetch;
  }): Promise<void>;
  token: {
    clientAuthentication: "basic" | "body";
    extra?: Record<string, string>;
    refreshUrl?: string;
    sendPkce?: boolean;
    url: string;
  };
}

export function createOAuth2Provider(
  options: OAuth2ProviderModuleOptions,
): ProviderExtension {
  const tokenRequest = async (input: {
    code?: string;
    codeVerifier?: string;
    config: OAuthProviderConfig;
    fetch?: ProviderFetch;
    grantType: "authorization_code" | "refresh_token";
    redirectUri?: string;
    refreshToken?: string;
  }) => {
    const basic = options.token.clientAuthentication === "basic";
    return parseOAuthToken(
      await postOAuthForm({
        fetch: input.fetch,
        headers: basic
          ? { authorization: basicAuthorization(input.config) }
          : undefined,
        url:
          input.grantType === "refresh_token"
            ? (options.token.refreshUrl ?? options.token.url)
            : options.token.url,
        values: {
          ...options.token.extra,
          client_id: basic ? undefined : input.config.clientId,
          client_secret: basic
            ? undefined
            : requiredClientSecret(input.config),
          code: input.code,
          code_verifier: options.token.sendPkce
            ? input.codeVerifier
            : undefined,
          grant_type: input.grantType,
          redirect_uri: input.redirectUri,
          refresh_token: input.refreshToken,
        },
      }),
    );
  };

  return {
    actionArgumentsSchema: options.actionArgumentsSchema,
    buildAuthorizationUrl(input) {
      const url = addSearchParams(new URL(options.authorization.url), {
        ...options.authorization.extra,
        client_id: input.config.clientId,
        code_challenge: options.definition.requiresPkce
          ? input.codeChallenge
          : undefined,
        code_challenge_method: options.definition.requiresPkce
          ? "S256"
          : undefined,
        redirect_uri: input.redirectUri,
        response_type: "code",
        state: input.state,
      });
      url.searchParams.set(
        options.authorization.scopeParameter ?? "scope",
        options.definition.scopes.join(
          options.authorization.scopeSeparator ?? " ",
        ),
      );
      return url.toString();
    },
    definition: options.definition,
    async exchangeOAuthCode(input) {
      const token = await tokenRequest({
        code: input.code,
        codeVerifier: input.codeVerifier,
        config: input.config,
        fetch: input.fetch,
        grantType: "authorization_code",
        redirectUri: input.redirectUri,
      });
      const profile = await options.profile({ fetch: input.fetch, token });
      return {
        accountId: profile.accountId,
        credential: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          tokenType: token.token_type,
        },
        expiresAt: tokenExpiration(token.expires_in),
        label: profile.label,
        scopes:
          profile.scopes ??
          splitOAuthScopes(token.scope, options.definition.scopes),
      };
    },
    executeAction: options.executeAction,
    id: options.definition.id,
    async refreshCredential(input) {
      if (!input.credential.refreshToken) {
        throw new ProviderRequestError(
          "The provider did not issue a refresh token.",
          "missing_refresh_token",
        );
      }
      const token = await tokenRequest({
        config: input.config,
        fetch: input.fetch,
        grantType: "refresh_token",
        refreshToken: input.credential.refreshToken,
      });
      return {
        credential: {
          accessToken: token.access_token,
          refreshToken:
            token.refresh_token ?? input.credential.refreshToken,
          tokenType: token.token_type ?? input.credential.tokenType,
        },
        expiresAt: tokenExpiration(token.expires_in),
        scopes: token.scope
          ? splitOAuthScopes(token.scope, [])
          : undefined,
      };
    },
    async revokeCredential(input) {
      await options.revoke?.(input);
    },
  };
}

const oauthTokenSchema = z
  .object({
    access_token: z.string().min(1).max(32_000),
    expires_in: z.coerce.number().int().positive().max(315_360_000).optional(),
    refresh_token: z.string().min(1).max(32_000).optional(),
    scope: z.string().max(20_000).optional(),
    token_type: z.string().max(120).optional(),
  })
  .passthrough();

export type OAuthTokenPayload = z.infer<typeof oauthTokenSchema>;

export function parseOAuthToken(payload: unknown): OAuthTokenPayload {
  const parsed = oauthTokenSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderRequestError(
      "OAuth provider returned an invalid token response.",
      "invalid_token_response",
    );
  }
  return parsed.data;
}

export async function postOAuthForm(input: {
  fetch?: ProviderFetch;
  headers?: HeadersInit;
  url: string;
  values: Record<string, string | undefined>;
}): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(input.values)) {
    if (value !== undefined && value !== "") body.set(key, value);
  }
  const headers = new Headers(input.headers);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/x-www-form-urlencoded");
  return providerJsonRequest({
    fetch: input.fetch,
    init: {
      body,
      headers,
      method: "POST",
    },
    url: input.url,
  }).then((result) => result.body);
}

export async function providerJsonRequest(input: {
  accessToken?: string;
  fetch?: ProviderFetch;
  init?: RequestInit;
  url: string | URL;
}): Promise<{ body: unknown; requestId?: string }> {
  const headers = new Headers(input.init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (input.accessToken) {
    headers.set("authorization", `Bearer ${input.accessToken}`);
  }
  const response = await (input.fetch ?? globalThis.fetch)(input.url, {
    ...input.init,
    headers,
    signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
  });
  const body = await readBoundedJson(response);
  if (!response.ok) {
    throw new ProviderRequestError(
      `Provider API returned HTTP ${response.status}.`,
      providerErrorCode(body),
      response.status,
    );
  }
  return {
    body,
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("x-box-request-id") ??
      response.headers.get("x-dropbox-request-id") ??
      response.headers.get("figma-request-id") ??
      undefined,
  };
}

export async function revokeBearerToken(input: {
  accessToken: string;
  fetch?: ProviderFetch;
  headers?: HeadersInit;
  method?: "DELETE" | "POST";
  url: string;
  values?: Record<string, string>;
}): Promise<void> {
  const headers = new Headers(input.headers);
  headers.set("authorization", `Bearer ${input.accessToken}`);
  let body: URLSearchParams | undefined;
  if (input.values) {
    body = new URLSearchParams(input.values);
    headers.set("content-type", "application/x-www-form-urlencoded");
  }
  await providerJsonRequest({
    fetch: input.fetch,
    init: { body, headers, method: input.method ?? "POST" },
    url: input.url,
  });
}

export function basicAuthorization(config: OAuthProviderConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${requiredClientSecret(config)}`).toString("base64")}`;
}

export function requiredClientSecret(config: OAuthProviderConfig): string {
  if (!config.clientSecret) {
    throw new ProviderRequestError(
      "OAuth provider configuration is missing a Client Secret.",
      "missing_client_secret",
    );
  }
  return config.clientSecret;
}

export function tokenExpiration(expiresIn?: number): string | null {
  return expiresIn
    ? new Date(Date.now() + expiresIn * 1_000).toISOString()
    : null;
}

export function splitOAuthScopes(
  value: string | undefined,
  fallback: string[],
): string[] {
  return value
    ? value
        .split(/[ ,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
    : fallback;
}

export function addSearchParams(
  url: URL,
  values: Record<string, string | undefined>,
): URL {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

export function parseProviderPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderRequestError(
      "OAuth provider returned an invalid response.",
      "invalid_provider_response",
    );
  }
  return parsed.data;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PROVIDER_RESPONSE_MAX_BYTES
  ) {
    await response.body?.cancel();
    throw providerResponseTooLarge();
  }
  if (response.status === 204 || !response.body) return null;

  try {
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
    if (size === 0) return null;
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

function providerErrorCode(body: unknown): string {
  let raw = "provider_request_failed";
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") raw = error;
    else if (error && typeof error === "object" && "code" in error) {
      raw = String((error as { code: unknown }).code);
    }
  }
  const normalized = raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, 80) || "provider_request_failed";
}
