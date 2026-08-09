import { z } from "zod";
import { ONE_STATUS_VERSION } from "@one-status/protocol";
import {
  oauthProviders,
  type OAuthCredential,
  type OAuthProvider,
  type OAuthProviderConfig,
} from "./permission-vault.js";
import { ProviderRequestError } from "./provider-errors.js";
import {
  providerExtensionCatalog,
  requireProviderExtension,
} from "./provider-extensions/index.js";

export { ProviderRequestError } from "./provider-errors.js";

const REQUEST_TIMEOUT_MS = 15_000;
const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;
const GOOGLE_DOC_TEXT_MAX_CHARS = 100_000;
const GOOGLE_DOC_MAX_TABS = 50;
const GOOGLE_DOC_MAX_STRUCTURAL_ELEMENTS = 10_000;
const GMAIL_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Date",
  "Message-ID",
  "Reply-To",
] as const;
const GOOGLE_DRIVE_FILE_FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,size,webViewLink,shared,starred," +
  "trashed,parents,driveId,owners(displayName,emailAddress,me)";

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderAction {
  description: string;
  id: string;
  readOnly: boolean;
  requiredScopes: string[];
  requiresConfirmation: boolean;
  title: string;
}

export interface ProviderDefinition {
  actions: ProviderAction[];
  accent: string;
  authMode?: "oauth2" | "token";
  requiresSecret: boolean;
  description: string;
  documentationUrl?: string;
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

export function providerActionInputSchema(
  provider: OAuthProvider,
  action: string,
): Record<string, unknown> {
  return compactActionInputSchema(
    z.toJSONSchema(providerActionArgumentsSchema(provider, action), {
      io: "input",
    }) as Record<string, unknown>,
  );
}

function compactActionInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(compact);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$schema")
        .filter(
          ([key]) =>
            !(
              record.format === "date-time" &&
              (key === "pattern" || key === "default")
            ),
        )
        .map(([key, entry]) => [key, compact(entry)]),
    );
  };
  return compact(schema) as Record<string, unknown>;
}

export const providerCatalog = validateProviderCatalog({
  google: {
    id: "google",
    label: "Google Workspace",
    description: "读取 Calendar、Gmail、Drive 和 Docs，并在用户确认后发送邮件。",
    accent: "#4285f4",
    requiresPkce: true,
    requiresSecret: true,
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
    actions: [
      {
        id: "calendar.events.list",
        title: "读取日历事件",
        description: "读取指定时间范围内的日程。",
        readOnly: true,
        requiredScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        requiresConfirmation: false,
      },
      {
        id: "calendar.calendars.list",
        title: "读取日历列表",
        description: "读取当前账号可访问的日历。",
        readOnly: true,
        requiredScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        requiresConfirmation: false,
      },
      {
        id: "calendar.events.get",
        title: "读取单个日历事件",
        description: "按日历和事件 ID 读取日程详情。",
        readOnly: true,
        requiredScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        requiresConfirmation: false,
      },
      {
        id: "calendar.freebusy.query",
        title: "查询忙闲状态",
        description: "查询一个或多个日历在指定时间范围内的忙闲状态。",
        readOnly: true,
        requiredScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
        requiresConfirmation: false,
      },
      {
        id: "gmail.messages.list",
        title: "读取 Gmail 邮件列表",
        description: "按查询条件读取邮件 ID、会话 ID 和分页信息。",
        readOnly: true,
        requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        requiresConfirmation: false,
      },
      {
        id: "gmail.messages.get",
        title: "读取 Gmail 邮件元数据",
        description: "读取单封邮件的发件人、收件人、主题、标签和摘要。",
        readOnly: true,
        requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        requiresConfirmation: false,
      },
      {
        id: "gmail.messages.send",
        title: "发送 Gmail 邮件",
        description: "以当前 Google 账号发送纯文本邮件。",
        readOnly: false,
        requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
        requiresConfirmation: true,
      },
      {
        id: "drive.files.list",
        title: "读取 Google Drive 文件列表",
        description: "按固定字段和查询条件读取 Drive 文件元数据。",
        readOnly: true,
        requiredScopes: [
          "https://www.googleapis.com/auth/drive.metadata.readonly",
        ],
        requiresConfirmation: false,
      },
      {
        id: "drive.files.get",
        title: "读取 Google Drive 文件元数据",
        description: "按文件 ID 读取 Drive 文件的受控元数据。",
        readOnly: true,
        requiredScopes: [
          "https://www.googleapis.com/auth/drive.metadata.readonly",
        ],
        requiresConfirmation: false,
      },
      {
        id: "docs.documents.get",
        title: "读取 Google Docs 文档",
        description: "按文档 ID 读取标题、Tab 和经过长度限制的纯文本正文。",
        readOnly: true,
        requiredScopes: ["https://www.googleapis.com/auth/documents.readonly"],
        requiresConfirmation: false,
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
    scopes: ["read:user", "repo"],
    actions: [
      {
        id: "github.viewer.get",
        title: "读取 GitHub 资料",
        description: "读取已连接 GitHub 账号的公开资料。",
        readOnly: true,
        requiredScopes: ["read:user"],
        requiresConfirmation: false,
      },
      {
        id: "github.repositories.list",
        title: "读取仓库列表",
        description: "读取已连接账号可见的仓库。",
        readOnly: true,
        requiredScopes: [],
        requiresConfirmation: false,
      },
      {
        id: "github.issues.list",
        title: "读取 Issue",
        description: "读取指定仓库的 Issue 列表。",
        readOnly: true,
        requiredScopes: [],
        requiresConfirmation: false,
      },
      {
        id: "github.issues.create",
        title: "创建 Issue",
        description: "在指定仓库创建 Issue。",
        readOnly: false,
        requiredScopes: ["repo"],
        requiresConfirmation: true,
      },
      {
        id: "github.pull_requests.list",
        title: "读取 Pull Request",
        description: "读取指定仓库的 Pull Request 列表。",
        readOnly: true,
        requiredScopes: [],
        requiresConfirmation: false,
      },
      {
        id: "github.contents.get",
        title: "读取仓库内容",
        description: "读取指定仓库中的文件或目录。",
        readOnly: true,
        requiredScopes: [],
        requiresConfirmation: false,
      },
    ],
  },
  slack: {
    id: "slack",
    label: "Slack",
    description: "读取 Workspace 与消息，并在用户确认后发送 Slack 消息。",
    accent: "#36c5f0",
    requiresPkce: true,
    requiresSecret: false,
    scopes: [
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "search:read",
      "chat:write",
    ],
    actions: [
      {
        id: "slack.channels.list",
        title: "读取 Slack 频道",
        description: "读取当前 App 可访问的公开及私有频道。",
        readOnly: true,
        requiredScopes: ["channels:read", "groups:read"],
        requiresConfirmation: false,
      },
      {
        id: "slack.conversations.history",
        title: "读取频道消息",
        description: "读取指定 Slack 频道的消息历史。",
        readOnly: true,
        requiredScopes: ["channels:history", "groups:history"],
        requiresConfirmation: false,
      },
      {
        id: "slack.search.messages",
        title: "搜索 Slack 消息",
        description: "在当前用户可访问的 Slack 消息中搜索。",
        readOnly: true,
        requiredScopes: ["search:read"],
        requiresConfirmation: false,
      },
      {
        id: "slack.messages.post",
        title: "发送 Slack 消息",
        description: "向指定 Slack 频道或会话发送消息。",
        readOnly: false,
        requiredScopes: ["chat:write"],
        requiresConfirmation: true,
      },
    ],
  },
  ...providerExtensionCatalog,
});

function validateProviderCatalog(
  catalog: Record<string, ProviderDefinition>,
): Record<OAuthProvider, ProviderDefinition> {
  const expected = new Set<string>(oauthProviders);
  for (const provider of oauthProviders) {
    if (!catalog[provider]) {
      throw new Error(`Provider catalog is missing ${provider}.`);
    }
  }
  for (const provider of Object.keys(catalog)) {
    if (!expected.has(provider)) {
      throw new Error(`Provider catalog contains unknown provider ${provider}.`);
    }
  }
  return Object.freeze(catalog) as Record<OAuthProvider, ProviderDefinition>;
}

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
  if (input.provider === "slack") {
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
  return requireProviderExtension(input.provider).buildAuthorizationUrl(input);
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
  if (input.provider === "slack") return exchangeSlack(input);
  return requireProviderExtension(input.provider).exchangeOAuthCode(input);
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
  if (!isCoreProvider(input.provider)) {
    return requireProviderExtension(input.provider).refreshCredential(input);
  }
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
  if (!isCoreProvider(input.provider)) {
    return requireProviderExtension(input.provider).revokeCredential(input);
  }
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
  config?: OAuthProviderConfig;
  credential: OAuthCredential;
  fetch?: ProviderFetch;
  provider: OAuthProvider;
}): Promise<ToolExecutionResult> {
  if (!isCoreProvider(input.provider)) {
    return requireProviderExtension(input.provider).executeAction(input);
  }
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
  if (
    input.provider === "google" &&
    input.action === "calendar.calendars.list"
  ) {
    const arguments_ = googleCalendarsArgumentsSchema.parse(input.arguments ?? {});
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );
    addQuery(url, {
      maxResults: String(arguments_.maxResults),
      pageToken: arguments_.pageToken,
      showDeleted: String(arguments_.showDeleted),
      showHidden: String(arguments_.showHidden),
    });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(
      googleCalendarsResponseSchema,
      response.body,
    );
    return {
      data: {
        items: body.items.map((calendar) => ({
          accessRole: calendar.accessRole,
          backgroundColor: calendar.backgroundColor ?? null,
          description: calendar.description ?? null,
          id: calendar.id,
          primary: calendar.primary ?? false,
          selected: calendar.selected ?? false,
          summary: calendar.summary,
          timeZone: calendar.timeZone ?? null,
        })),
        nextPageToken: body.nextPageToken,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "calendar.events.get") {
    const arguments_ = googleEventGetArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/" +
        `${encodeURIComponent(arguments_.calendarId)}/events/` +
        encodeURIComponent(arguments_.eventId),
    );
    addQuery(url, { timeZone: arguments_.timeZone });
    const response = await providerFetch(input.fetch, url, token);
    const event = parseProviderPayload(googleEventSchema, response.body);
    return {
      data: normalizeGoogleEvent(event),
      providerRequestId: response.requestId,
    };
  }
  if (
    input.provider === "google" &&
    input.action === "calendar.freebusy.query"
  ) {
    const arguments_ = googleFreeBusyArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const response = await providerFetch(
      input.fetch,
      new URL("https://www.googleapis.com/calendar/v3/freeBusy"),
      token,
      {
        body: JSON.stringify({
          calendarExpansionMax: arguments_.calendarExpansionMax,
          groupExpansionMax: arguments_.groupExpansionMax,
          items: arguments_.calendarIds.map((id) => ({ id })),
          timeMax: arguments_.timeMax,
          timeMin: arguments_.timeMin,
          timeZone: arguments_.timeZone,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const body = parseProviderPayload(googleFreeBusyResponseSchema, response.body);
    return {
      data: {
        calendars: Object.entries(body.calendars).map(([id, calendar]) => ({
          busy: calendar.busy,
          errors: calendar.errors ?? [],
          id,
        })),
        groups: Object.entries(body.groups ?? {}).map(([id, group]) => ({
          calendars: group.calendars ?? [],
          errors: group.errors ?? [],
          id,
        })),
        timeMax: body.timeMax,
        timeMin: body.timeMin,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "gmail.messages.list") {
    const arguments_ = gmailMessagesListArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    );
    addQuery(url, {
      fields: "messages(id,threadId),nextPageToken,resultSizeEstimate",
      includeSpamTrash: String(arguments_.includeSpamTrash),
      maxResults: String(arguments_.maxResults),
      pageToken: arguments_.pageToken,
      q: arguments_.query,
    });
    for (const labelId of arguments_.labelIds ?? []) {
      url.searchParams.append("labelIds", labelId);
    }
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(gmailMessagesListResponseSchema, response.body);
    return {
      data: gmailMessagesListOutputSchema.parse({
        items: body.messages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })),
        nextPageToken: body.nextPageToken ?? null,
        resultSizeEstimate: body.resultSizeEstimate ?? 0,
      }),
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "gmail.messages.get") {
    const arguments_ = gmailMessageGetArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
        encodeURIComponent(arguments_.messageId),
    );
    addQuery(url, {
      fields:
        "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(headers)",
      format: "metadata",
    });
    for (const header of GMAIL_METADATA_HEADERS) {
      url.searchParams.append("metadataHeaders", header);
    }
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(gmailMessageResponseSchema, response.body);
    return {
      data: normalizeGmailMessage(body),
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "gmail.messages.send") {
    const arguments_ = gmailMessageSendArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    addQuery(url, { fields: "id,threadId,labelIds" });
    const response = await providerFetch(input.fetch, url, token, {
      body: JSON.stringify({ raw: buildGmailRawMessage(arguments_) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = parseProviderPayload(gmailMessageResponseSchema, response.body);
    return {
      data: gmailMessageSendOutputSchema.parse({
        id: body.id,
        labelIds: body.labelIds ?? [],
        threadId: body.threadId,
      }),
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "drive.files.list") {
    const arguments_ = driveFilesListArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    addQuery(url, {
      fields: `nextPageToken,files(${GOOGLE_DRIVE_FILE_FIELDS})`,
      includeItemsFromAllDrives: "true",
      orderBy: arguments_.orderBy,
      pageSize: String(arguments_.pageSize),
      pageToken: arguments_.pageToken,
      q: arguments_.query,
      spaces: "drive",
      supportsAllDrives: "true",
    });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(driveFilesListResponseSchema, response.body);
    return {
      data: driveFilesListOutputSchema.parse({
        items: body.files.map(normalizeDriveFile),
        nextPageToken: body.nextPageToken ?? null,
      }),
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "drive.files.get") {
    const arguments_ = driveFileGetArgumentsSchema.parse(input.arguments ?? {});
    const url = new URL(
      "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(arguments_.fileId),
    );
    addQuery(url, {
      fields: GOOGLE_DRIVE_FILE_FIELDS,
      supportsAllDrives: "true",
    });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(driveFileSchema, response.body);
    return {
      data: normalizeDriveFile(body),
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "google" && input.action === "docs.documents.get") {
    const arguments_ = googleDocsGetArgumentsSchema.parse(input.arguments ?? {});
    const url = new URL(
      "https://docs.googleapis.com/v1/documents/" +
        encodeURIComponent(arguments_.documentId),
    );
    addQuery(url, { includeTabsContent: "true" });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(googleDocsDocumentSchema, response.body);
    return {
      data: normalizeGoogleDocument(body),
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "github" && input.action === "github.viewer.get") {
    const response = await providerFetch(
      input.fetch,
      new URL("https://api.github.com/user"),
      token,
      { headers: githubHeaders() },
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
      { headers: githubHeaders() },
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
  if (input.provider === "github" && input.action === "github.issues.list") {
    const arguments_ = githubIssuesListArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = githubRepositoryUrl(
      arguments_.owner,
      arguments_.repo,
      "issues",
    );
    addQuery(url, {
      assignee: arguments_.assignee,
      creator: arguments_.creator,
      direction: arguments_.direction,
      labels: arguments_.labels?.join(","),
      mentioned: arguments_.mentioned,
      page: String(arguments_.page),
      per_page: String(arguments_.perPage),
      since: arguments_.since,
      sort: arguments_.sort,
      state: arguments_.state,
    });
    const response = await providerFetch(input.fetch, url, token, {
      headers: githubHeaders(),
    });
    const issues = parseProviderPayload(
      z.array(githubIssueSchema).max(50),
      response.body,
    );
    return {
      data: {
        items: issues.map(normalizeGitHubIssue),
        page: arguments_.page,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "github" && input.action === "github.issues.create") {
    const arguments_ = githubIssueCreateArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const response = await providerFetch(
      input.fetch,
      githubRepositoryUrl(arguments_.owner, arguments_.repo, "issues"),
      token,
      {
        body: JSON.stringify({
          assignees: arguments_.assignees,
          body: arguments_.body,
          labels: arguments_.labels,
          milestone: arguments_.milestone,
          title: arguments_.title,
        }),
        headers: { ...githubHeaders(), "content-type": "application/json" },
        method: "POST",
      },
    );
    const issue = parseProviderPayload(githubIssueSchema, response.body);
    return {
      data: normalizeGitHubIssue(issue),
      providerRequestId: response.requestId,
    };
  }
  if (
    input.provider === "github" &&
    input.action === "github.pull_requests.list"
  ) {
    const arguments_ = githubPullRequestsListArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = githubRepositoryUrl(arguments_.owner, arguments_.repo, "pulls");
    addQuery(url, {
      base: arguments_.base,
      direction: arguments_.direction,
      head: arguments_.head,
      page: String(arguments_.page),
      per_page: String(arguments_.perPage),
      sort: arguments_.sort,
      state: arguments_.state,
    });
    const response = await providerFetch(input.fetch, url, token, {
      headers: githubHeaders(),
    });
    const pulls = parseProviderPayload(
      z.array(githubPullRequestSchema).max(50),
      response.body,
    );
    return {
      data: {
        items: pulls.map((pull) => ({
          author: pull.user?.login ?? null,
          base: pull.base.ref,
          body: pull.body ?? null,
          createdAt: pull.created_at,
          draft: pull.draft ?? false,
          head: pull.head.ref,
          number: pull.number,
          state: pull.state,
          title: pull.title,
          updatedAt: pull.updated_at,
          url: pull.html_url,
        })),
        page: arguments_.page,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "github" && input.action === "github.contents.get") {
    const arguments_ = githubContentsGetArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const contentPath = encodeRepositoryPath(arguments_.path);
    const url = githubRepositoryUrl(
      arguments_.owner,
      arguments_.repo,
      contentPath ? `contents/${contentPath}` : "contents",
    );
    addQuery(url, { ref: arguments_.ref });
    const response = await providerFetch(input.fetch, url, token, {
      headers: githubHeaders(),
    });
    const body = parseProviderPayload(
      githubContentsResponseSchema,
      response.body,
    );
    return {
      data: Array.isArray(body)
        ? {
            items: body.map(normalizeGitHubContent),
            path: arguments_.path,
            type: "directory",
          }
        : normalizeGitHubContent(body),
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
  if (
    input.provider === "slack" &&
    input.action === "slack.conversations.history"
  ) {
    const arguments_ = slackConversationHistoryArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL("https://slack.com/api/conversations.history");
    addQuery(url, {
      channel: arguments_.channel,
      cursor: arguments_.cursor,
      inclusive: String(arguments_.inclusive),
      latest: arguments_.latest,
      limit: String(arguments_.limit),
      oldest: arguments_.oldest,
    });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(slackHistoryResponseSchema, response.body);
    if (!body.ok) throw providerApiError("slack", body.error);
    return {
      data: {
        hasMore: body.has_more ?? false,
        items: (body.messages ?? []).map(normalizeSlackMessage),
        nextCursor: body.response_metadata?.next_cursor || undefined,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "slack" && input.action === "slack.search.messages") {
    const arguments_ = slackSearchMessagesArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const url = new URL("https://slack.com/api/search.messages");
    addQuery(url, {
      count: String(arguments_.count),
      highlight: "false",
      page: String(arguments_.page),
      query: arguments_.query,
      sort: arguments_.sort,
      sort_dir: arguments_.sortDirection,
    });
    const response = await providerFetch(input.fetch, url, token);
    const body = parseProviderPayload(slackSearchResponseSchema, response.body);
    if (!body.ok) throw providerApiError("slack", body.error);
    return {
      data: {
        items: (body.messages?.matches ?? []).map((match) => ({
          channelId: match.channel_id ?? null,
          channelName: match.channel_name ?? null,
          permalink: match.permalink ?? null,
          text: match.text,
          timestamp: match.ts,
          username: match.username ?? match.user_name ?? null,
        })),
        page: body.messages?.pagination?.page ?? arguments_.page,
        pageCount: body.messages?.pagination?.page_count ?? null,
        total: body.messages?.total ?? 0,
      },
      providerRequestId: response.requestId,
    };
  }
  if (input.provider === "slack" && input.action === "slack.messages.post") {
    const arguments_ = slackPostMessageArgumentsSchema.parse(
      input.arguments ?? {},
    );
    const response = await providerFetch(
      input.fetch,
      new URL("https://slack.com/api/chat.postMessage"),
      token,
      {
        body: JSON.stringify({
          channel: arguments_.channel,
          mrkdwn: arguments_.mrkdwn,
          reply_broadcast: arguments_.replyBroadcast,
          text: arguments_.text,
          thread_ts: arguments_.threadTs,
          unfurl_links: arguments_.unfurlLinks,
          unfurl_media: arguments_.unfurlMedia,
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "POST",
      },
    );
    const body = parseProviderPayload(
      slackPostMessageResponseSchema,
      response.body,
    );
    if (!body.ok || !body.channel || !body.ts) {
      throw providerApiError("slack", body.error);
    }
    return {
      data: {
        channel: body.channel,
        message: body.message ? normalizeSlackMessage(body.message) : null,
        timestamp: body.ts,
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
    { headers: githubHeaders() },
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
  init: RequestInit = {},
): Promise<{ body: unknown; requestId?: string }> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${accessToken}`);
  const response = await (fetch_ ?? globalThis.fetch)(url, {
    ...init,
    headers,
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
    "user-agent": `one-status/${ONE_STATUS_VERSION}`,
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

const googleDateTimeSchema = z
  .object({
    date: z.string().max(100).optional(),
    dateTime: z.string().max(100).optional(),
    timeZone: z.string().max(500).optional(),
  })
  .passthrough();

const googleEventSchema = z
  .object({
    attendees: z
      .array(
        z
          .object({
            displayName: z.string().max(500).optional(),
            email: z.string().max(500).optional(),
            organizer: z.boolean().optional(),
            responseStatus: z.string().max(120).optional(),
            self: z.boolean().optional(),
          })
          .passthrough(),
      )
      .max(200)
      .optional(),
    created: z.string().max(100).optional(),
    description: z.string().max(100_000).optional(),
    end: googleDateTimeSchema.optional(),
    htmlLink: z.string().max(4_000).optional(),
    id: z.string().max(1_000),
    location: z.string().max(10_000).optional(),
    organizer: z
      .object({
        displayName: z.string().max(500).optional(),
        email: z.string().max(500).optional(),
        self: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    recurringEventId: z.string().max(1_000).optional(),
    start: googleDateTimeSchema.optional(),
    status: z.string().max(120).optional(),
    summary: z.string().max(10_000).optional(),
    updated: z.string().max(100).optional(),
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
    items: z.array(googleEventSchema).max(100).default([]),
    nextPageToken: z.string().max(4_000).optional(),
    summary: z.string().max(10_000).optional(),
    timeZone: z.string().max(500).optional(),
  })
  .passthrough();

const googleCalendarsArgumentsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(100).default(100),
    pageToken: z.string().max(4_000).optional(),
    showDeleted: z.boolean().default(false),
    showHidden: z.boolean().default(false),
  })
  .strict();

const googleCalendarsResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            accessRole: z.string().max(120),
            backgroundColor: z.string().max(120).optional(),
            description: z.string().max(10_000).optional(),
            id: z.string().min(1).max(1_000),
            primary: z.boolean().optional(),
            selected: z.boolean().optional(),
            summary: z.string().max(10_000),
            timeZone: z.string().max(500).optional(),
          })
          .passthrough(),
      )
      .max(250)
      .default([]),
    nextPageToken: z.string().max(4_000).optional(),
  })
  .passthrough();

const googleEventGetArgumentsSchema = z
  .object({
    calendarId: z.string().min(1).max(1_000).default("primary"),
    eventId: z.string().min(1).max(1_000),
    timeZone: z.string().max(500).optional(),
  })
  .strict();

const googleFreeBusyArgumentsSchema = z
  .object({
    calendarExpansionMax: z.number().int().min(1).max(50).default(50),
    calendarIds: z.array(z.string().min(1).max(1_000)).min(1).max(50),
    groupExpansionMax: z.number().int().min(1).max(100).default(100),
    timeMax: z.iso.datetime({ offset: true }).default(() =>
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    ),
    timeMin: z.iso.datetime({ offset: true }).default(() =>
      new Date().toISOString(),
    ),
    timeZone: z.string().max(500).optional(),
  })
  .strict()
  .refine((value) => Date.parse(value.timeMax) > Date.parse(value.timeMin), {
    message: "timeMax must be later than timeMin.",
    path: ["timeMax"],
  });

const googleFreeBusyErrorSchema = z
  .object({
    domain: z.string().max(500).optional(),
    reason: z.string().max(500).optional(),
  })
  .passthrough();

const googleFreeBusyResponseSchema = z
  .object({
    calendars: z.record(
      z.string(),
      z
        .object({
          busy: z
            .array(
              z.object({
                end: z.string().max(100),
                start: z.string().max(100),
              }),
            )
            .max(1_000)
            .default([]),
          errors: z.array(googleFreeBusyErrorSchema).max(100).optional(),
        })
        .passthrough(),
    ),
    groups: z
      .record(
        z.string(),
        z
          .object({
            calendars: z.array(z.string().max(1_000)).max(100).optional(),
            errors: z.array(googleFreeBusyErrorSchema).max(100).optional(),
          })
          .passthrough(),
      )
      .optional(),
    timeMax: z.string().max(100),
    timeMin: z.string().max(100),
  })
  .passthrough();

const googleResourceIdSchema = z
  .string()
  .min(1)
  .max(1_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const googleTabIdSchema = z
  .string()
  .min(1)
  .max(1_000)
  .regex(/^[A-Za-z0-9._:-]+$/);
const gmailLabelIdSchema = z.string().min(1).max(500);

const gmailMessagesListArgumentsSchema = z
  .object({
    includeSpamTrash: z.boolean().default(false),
    labelIds: z.array(gmailLabelIdSchema).max(20).optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
    pageToken: z.string().max(4_000).optional(),
    query: z.string().min(1).max(5_000).optional(),
  })
  .strict();

const gmailMessageReferenceSchema = z
  .object({
    id: googleResourceIdSchema,
    threadId: googleResourceIdSchema,
  })
  .passthrough();

const gmailMessagesListResponseSchema = z
  .object({
    messages: z.array(gmailMessageReferenceSchema).max(50).default([]),
    nextPageToken: z.string().max(4_000).optional(),
    resultSizeEstimate: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const gmailMessageReferenceOutputSchema = z
  .object({
    id: googleResourceIdSchema,
    threadId: googleResourceIdSchema,
  })
  .strict();

const gmailMessagesListOutputSchema = z
  .object({
    items: z.array(gmailMessageReferenceOutputSchema).max(50),
    nextPageToken: z.string().max(4_000).nullable(),
    resultSizeEstimate: z.number().int().nonnegative(),
  })
  .strict();

const gmailMessageGetArgumentsSchema = z
  .object({ messageId: googleResourceIdSchema })
  .strict();

const gmailHeaderSchema = z
  .object({
    name: z.string().min(1).max(500),
    value: z.string().max(10_000),
  })
  .passthrough();

const gmailMessageResponseSchema = z
  .object({
    id: googleResourceIdSchema,
    internalDate: z.string().max(100).optional(),
    labelIds: z.array(gmailLabelIdSchema).max(100).default([]),
    payload: z
      .object({ headers: z.array(gmailHeaderSchema).max(100).default([]) })
      .passthrough()
      .optional(),
    sizeEstimate: z.number().int().nonnegative().optional(),
    snippet: z.string().max(10_000).optional(),
    threadId: googleResourceIdSchema,
  })
  .passthrough();

const gmailMessageHeadersOutputSchema = z
  .object({
    bcc: z.string().max(2_000).nullable(),
    cc: z.string().max(2_000).nullable(),
    date: z.string().max(2_000).nullable(),
    from: z.string().max(2_000).nullable(),
    messageId: z.string().max(2_000).nullable(),
    replyTo: z.string().max(2_000).nullable(),
    subject: z.string().max(2_000).nullable(),
    to: z.string().max(2_000).nullable(),
  })
  .strict();

const gmailMessageOutputSchema = z
  .object({
    headers: gmailMessageHeadersOutputSchema,
    id: googleResourceIdSchema,
    internalDate: z.string().max(100).nullable(),
    labelIds: z.array(gmailLabelIdSchema).max(100),
    sizeEstimate: z.number().int().nonnegative().nullable(),
    snippet: z.string().max(4_000),
    threadId: googleResourceIdSchema,
  })
  .strict();

const gmailMessageSendArgumentsSchema = z
  .object({
    bcc: z.array(z.email().max(254)).max(20).optional(),
    cc: z.array(z.email().max(254)).max(20).optional(),
    subject: z.string().min(1).max(998),
    textBody: z.string().min(1).max(100_000),
    to: z.array(z.email().max(254)).min(1).max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) <=
      40,
    { message: "A message can contain at most 40 recipients." },
  );

const gmailMessageSendOutputSchema = z
  .object({
    id: googleResourceIdSchema,
    labelIds: z.array(gmailLabelIdSchema).max(100),
    threadId: googleResourceIdSchema,
  })
  .strict();

const driveFilesListArgumentsSchema = z
  .object({
    orderBy: z
      .enum([
        "createdTime",
        "createdTime desc",
        "modifiedTime",
        "modifiedTime desc",
        "name",
        "name desc",
        "recency",
        "recency desc",
        "starred",
      ])
      .default("modifiedTime desc"),
    pageSize: z.number().int().min(1).max(100).default(50),
    pageToken: z.string().max(4_000).optional(),
    query: z.string().min(1).max(5_000).optional(),
  })
  .strict();

const driveFileGetArgumentsSchema = z
  .object({ fileId: googleResourceIdSchema })
  .strict();

const driveOwnerSchema = z
  .object({
    displayName: z.string().max(500).optional(),
    emailAddress: z.string().max(500).optional(),
    me: z.boolean().optional(),
  })
  .passthrough();

const driveFileSchema = z
  .object({
    createdTime: z.string().max(100).optional(),
    driveId: googleResourceIdSchema.optional(),
    id: googleResourceIdSchema,
    mimeType: z.string().min(1).max(500),
    modifiedTime: z.string().max(100).optional(),
    name: z.string().max(5_000),
    owners: z.array(driveOwnerSchema).max(100).default([]),
    parents: z.array(googleResourceIdSchema).max(100).default([]),
    shared: z.boolean().optional(),
    size: z.string().max(30).regex(/^\d+$/).optional(),
    starred: z.boolean().optional(),
    trashed: z.boolean().optional(),
    webViewLink: z.string().max(4_000).optional(),
  })
  .passthrough();

const driveFilesListResponseSchema = z
  .object({
    files: z.array(driveFileSchema).max(100).default([]),
    nextPageToken: z.string().max(4_000).optional(),
  })
  .passthrough();

const driveOwnerOutputSchema = z
  .object({
    displayName: z.string().max(500).nullable(),
    emailAddress: z.string().max(500).nullable(),
    me: z.boolean(),
  })
  .strict();

const driveFileOutputSchema = z
  .object({
    createdAt: z.string().max(100).nullable(),
    driveId: googleResourceIdSchema.nullable(),
    id: googleResourceIdSchema,
    mimeType: z.string().min(1).max(500),
    modifiedAt: z.string().max(100).nullable(),
    name: z.string().max(5_000),
    owners: z.array(driveOwnerOutputSchema).max(100),
    parentIds: z.array(googleResourceIdSchema).max(100),
    shared: z.boolean(),
    sizeBytes: z.string().max(30).regex(/^\d+$/).nullable(),
    starred: z.boolean(),
    trashed: z.boolean(),
    webViewUrl: z.string().max(4_000).nullable(),
  })
  .strict();

const driveFilesListOutputSchema = z
  .object({
    items: z.array(driveFileOutputSchema).max(100),
    nextPageToken: z.string().max(4_000).nullable(),
  })
  .strict();

const googleDocsGetArgumentsSchema = z
  .object({ documentId: googleResourceIdSchema })
  .strict();

const googleDocsContentContainerSchema = z
  .object({ content: z.array(z.unknown()).max(5_000).default([]) })
  .passthrough();

const googleDocsStructuralElementSchema = z
  .object({
    paragraph: z
      .object({
        elements: z
          .array(
            z
              .object({
                textRun: z
                  .object({ content: z.string().max(200_000) })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          )
          .max(5_000)
          .default([]),
      })
      .passthrough()
      .optional(),
    table: z
      .object({
        tableRows: z
          .array(
            z
              .object({
                tableCells: z
                  .array(googleDocsContentContainerSchema)
                  .max(500)
                  .default([]),
              })
              .passthrough(),
          )
          .max(500)
          .default([]),
      })
      .passthrough()
      .optional(),
    tableOfContents: googleDocsContentContainerSchema.optional(),
  })
  .passthrough();

const googleDocsTabSchema = z
  .object({
    childTabs: z.array(z.unknown()).max(100).default([]),
    documentTab: z
      .object({ body: googleDocsContentContainerSchema.optional() })
      .passthrough()
      .optional(),
    tabProperties: z
      .object({
        parentTabId: googleTabIdSchema.optional(),
        tabId: googleTabIdSchema,
        title: z.string().max(5_000),
      })
      .passthrough(),
  })
  .passthrough();

const googleDocsDocumentSchema = z
  .object({
    body: googleDocsContentContainerSchema.optional(),
    documentId: googleResourceIdSchema,
    revisionId: z.string().max(1_000).optional(),
    tabs: z.array(z.unknown()).max(100).default([]),
    title: z.string().max(5_000),
  })
  .passthrough();

const googleDocsTabOutputSchema = z
  .object({
    id: googleTabIdSchema.nullable(),
    parentId: googleTabIdSchema.nullable(),
    text: z.string().max(GOOGLE_DOC_TEXT_MAX_CHARS),
    title: z.string().max(5_000),
    truncated: z.boolean(),
  })
  .strict();

const googleDocsDocumentOutputSchema = z
  .object({
    documentId: googleResourceIdSchema,
    revisionId: z.string().max(1_000).nullable(),
    tabs: z.array(googleDocsTabOutputSchema).max(GOOGLE_DOC_MAX_TABS),
    title: z.string().max(5_000),
    truncated: z.boolean(),
  })
  .strict();

const githubRepositoriesArgumentsSchema = z
  .object({
    page: z.number().int().min(1).max(10_000).default(1),
    perPage: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const githubOwnerSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
const githubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
const githubLoginSchema = z.string().min(1).max(100);

const githubIssuesListArgumentsSchema = z
  .object({
    assignee: githubLoginSchema.optional(),
    creator: githubLoginSchema.optional(),
    direction: z.enum(["asc", "desc"]).default("desc"),
    labels: z.array(z.string().min(1).max(500)).max(100).optional(),
    mentioned: githubLoginSchema.optional(),
    owner: githubOwnerSchema,
    page: z.number().int().min(1).max(10_000).default(1),
    perPage: z.number().int().min(1).max(50).default(20),
    repo: githubRepositoryNameSchema,
    since: z.iso.datetime({ offset: true }).optional(),
    sort: z.enum(["created", "updated", "comments"]).default("updated"),
    state: z.enum(["open", "closed", "all"]).default("open"),
  })
  .strict();

const githubIssueCreateArgumentsSchema = z
  .object({
    assignees: z.array(githubLoginSchema).max(10).optional(),
    body: z.string().max(100_000).optional(),
    labels: z.array(z.string().min(1).max(500)).max(100).optional(),
    milestone: z.number().int().positive().optional(),
    owner: githubOwnerSchema,
    repo: githubRepositoryNameSchema,
    title: z.string().min(1).max(1_000),
  })
  .strict();

const githubIssueSchema = z
  .object({
    assignees: z
      .array(z.object({ login: githubLoginSchema }).passthrough())
      .max(100)
      .default([]),
    body: z.string().max(100_000).nullable().optional(),
    closed_at: z.string().max(100).nullable().optional(),
    comments: z.number().int().nonnegative().optional(),
    created_at: z.string().max(100),
    html_url: z.string().max(4_000),
    labels: z
      .array(
        z.union([
          z.string().max(500),
          z
            .object({
              color: z.string().max(120).optional(),
              name: z.string().max(500).optional(),
            })
            .passthrough(),
        ]),
      )
      .max(100)
      .default([]),
    locked: z.boolean().optional(),
    milestone: z
      .object({ number: z.number().int(), title: z.string().max(1_000) })
      .passthrough()
      .nullable()
      .optional(),
    number: z.number().int().positive(),
    pull_request: z.object({}).passthrough().optional(),
    state: z.enum(["open", "closed"]),
    title: z.string().max(1_000),
    updated_at: z.string().max(100),
    user: z.object({ login: githubLoginSchema }).passthrough().nullable().optional(),
  })
  .passthrough();

const githubPullRequestsListArgumentsSchema = z
  .object({
    base: z.string().min(1).max(500).optional(),
    direction: z.enum(["asc", "desc"]).default("desc"),
    head: z.string().min(1).max(500).optional(),
    owner: githubOwnerSchema,
    page: z.number().int().min(1).max(10_000).default(1),
    perPage: z.number().int().min(1).max(50).default(20),
    repo: githubRepositoryNameSchema,
    sort: z
      .enum(["created", "updated", "popularity", "long-running"])
      .default("updated"),
    state: z.enum(["open", "closed", "all"]).default("open"),
  })
  .strict();

const githubPullRequestSchema = z
  .object({
    base: z.object({ ref: z.string().max(500) }).passthrough(),
    body: z.string().max(100_000).nullable().optional(),
    created_at: z.string().max(100),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string().max(500) }).passthrough(),
    html_url: z.string().max(4_000),
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    title: z.string().max(1_000),
    updated_at: z.string().max(100),
    user: z.object({ login: githubLoginSchema }).passthrough().nullable().optional(),
  })
  .passthrough();

const githubContentsGetArgumentsSchema = z
  .object({
    owner: githubOwnerSchema,
    path: z
      .string()
      .max(4_000)
      .default("")
      .refine(
        (path) => !path.split("/").some((part) => part === "." || part === ".."),
        "Repository path cannot contain dot segments.",
      ),
    ref: z.string().min(1).max(500).optional(),
    repo: githubRepositoryNameSchema,
  })
  .strict();

const githubContentSchema = z
  .object({
    content: z.string().max(800_000).optional(),
    download_url: z.string().max(4_000).nullable().optional(),
    encoding: z.string().max(120).optional(),
    html_url: z.string().max(4_000).nullable().optional(),
    name: z.string().max(1_000),
    path: z.string().max(4_000),
    sha: z.string().max(500),
    size: z.number().int().nonnegative().optional(),
    type: z.enum(["file", "dir", "symlink", "submodule"]),
  })
  .passthrough();

const githubContentsResponseSchema = z.union([
  githubContentSchema,
  z.array(githubContentSchema).max(1_000),
]);

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

const slackTimestampSchema = z.string().min(1).max(100);
const slackMessageSchema = z
  .object({
    bot_id: z.string().max(500).optional(),
    edited: z
      .object({ ts: slackTimestampSchema.optional(), user: z.string().max(500).optional() })
      .passthrough()
      .optional(),
    subtype: z.string().max(500).optional(),
    text: z.string().max(50_000).default(""),
    thread_ts: slackTimestampSchema.optional(),
    ts: slackTimestampSchema,
    user: z.string().max(500).optional(),
  })
  .passthrough();

const slackConversationHistoryArgumentsSchema = z
  .object({
    channel: z.string().min(1).max(500),
    cursor: z.string().max(4_000).optional(),
    inclusive: z.boolean().default(false),
    latest: slackTimestampSchema.optional(),
    limit: z.number().int().min(1).max(100).default(100),
    oldest: slackTimestampSchema.optional(),
  })
  .strict();

const slackHistoryResponseSchema = z
  .object({
    error: z.string().max(500).optional(),
    has_more: z.boolean().optional(),
    messages: z.array(slackMessageSchema).max(100).optional(),
    ok: z.boolean(),
    response_metadata: z
      .object({ next_cursor: z.string().max(4_000).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const slackSearchMessagesArgumentsSchema = z
  .object({
    count: z.number().int().min(1).max(100).default(100),
    page: z.number().int().min(1).max(100).default(1),
    query: z.string().min(1).max(5_000),
    sort: z.enum(["score", "timestamp"]).default("score"),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

const slackSearchMatchSchema = z
  .object({
    channel_id: z.string().max(500).optional(),
    channel_name: z.string().max(500).optional(),
    permalink: z.string().max(4_000).optional(),
    text: z.string().max(50_000).default(""),
    ts: slackTimestampSchema,
    user_name: z.string().max(500).optional(),
    username: z.string().max(500).optional(),
  })
  .passthrough();

const slackSearchResponseSchema = z
  .object({
    error: z.string().max(500).optional(),
    messages: z
      .object({
        matches: z.array(slackSearchMatchSchema).max(100).optional(),
        pagination: z
          .object({
            page: z.number().int().positive().optional(),
            page_count: z.number().int().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
        total: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    ok: z.boolean(),
  })
  .passthrough();

const slackPostMessageArgumentsSchema = z
  .object({
    channel: z.string().min(1).max(500),
    mrkdwn: z.boolean().default(true),
    replyBroadcast: z.boolean().default(false),
    text: z.string().min(1).max(40_000),
    threadTs: slackTimestampSchema.optional(),
    unfurlLinks: z.boolean().default(false),
    unfurlMedia: z.boolean().default(false),
  })
  .strict();

const slackPostMessageResponseSchema = z
  .object({
    channel: z.string().max(500).optional(),
    error: z.string().max(500).optional(),
    message: slackMessageSchema.optional(),
    ok: z.boolean(),
    ts: slackTimestampSchema.optional(),
  })
  .passthrough();

const emptyActionArgumentsSchema = z.object({}).strict();

function providerActionArgumentsSchema(
  provider: OAuthProvider,
  action: string,
): z.ZodType {
  if (provider === "google") {
    if (action === "calendar.events.list") return googleEventsArgumentsSchema;
    if (action === "calendar.calendars.list") {
      return googleCalendarsArgumentsSchema;
    }
    if (action === "calendar.events.get") return googleEventGetArgumentsSchema;
    if (action === "calendar.freebusy.query") {
      return googleFreeBusyArgumentsSchema;
    }
    if (action === "gmail.messages.list") {
      return gmailMessagesListArgumentsSchema;
    }
    if (action === "gmail.messages.get") return gmailMessageGetArgumentsSchema;
    if (action === "gmail.messages.send") {
      return gmailMessageSendArgumentsSchema;
    }
    if (action === "drive.files.list") return driveFilesListArgumentsSchema;
    if (action === "drive.files.get") return driveFileGetArgumentsSchema;
    if (action === "docs.documents.get") return googleDocsGetArgumentsSchema;
  }
  if (provider === "github") {
    if (action === "github.viewer.get") return emptyActionArgumentsSchema;
    if (action === "github.repositories.list") {
      return githubRepositoriesArgumentsSchema;
    }
    if (action === "github.issues.list") return githubIssuesListArgumentsSchema;
    if (action === "github.issues.create") {
      return githubIssueCreateArgumentsSchema;
    }
    if (action === "github.pull_requests.list") {
      return githubPullRequestsListArgumentsSchema;
    }
    if (action === "github.contents.get") return githubContentsGetArgumentsSchema;
  }
  if (provider === "slack") {
    if (action === "slack.channels.list") return slackChannelsArgumentsSchema;
    if (action === "slack.conversations.history") {
      return slackConversationHistoryArgumentsSchema;
    }
    if (action === "slack.search.messages") {
      return slackSearchMessagesArgumentsSchema;
    }
    if (action === "slack.messages.post") return slackPostMessageArgumentsSchema;
  }
  if (!isCoreProvider(provider)) {
    return requireProviderExtension(provider).actionArgumentsSchema(action);
  }
  throw new Error(`Unsupported provider action: ${action}`);
}

function isCoreProvider(
  provider: OAuthProvider,
): provider is "google" | "github" | "slack" {
  return provider === "google" || provider === "github" || provider === "slack";
}

function normalizeGoogleEvent(event: z.infer<typeof googleEventSchema>) {
  return {
    attendees: (event.attendees ?? []).map((attendee) => ({
      displayName: attendee.displayName ?? null,
      email: attendee.email ?? null,
      organizer: attendee.organizer ?? false,
      responseStatus: attendee.responseStatus ?? null,
      self: attendee.self ?? false,
    })),
    createdAt: event.created ?? null,
    description: event.description ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    htmlUrl: event.htmlLink ?? null,
    id: event.id,
    location: event.location ?? null,
    organizer: event.organizer
      ? {
          displayName: event.organizer.displayName ?? null,
          email: event.organizer.email ?? null,
          self: event.organizer.self ?? false,
        }
      : null,
    recurringEventId: event.recurringEventId ?? null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    status: event.status ?? null,
    summary: event.summary ?? "(Untitled event)",
    updatedAt: event.updated ?? null,
  };
}

function normalizeGmailMessage(
  message: z.infer<typeof gmailMessageResponseSchema>,
): z.infer<typeof gmailMessageOutputSchema> {
  const headers = message.payload?.headers ?? [];
  const header = (name: (typeof GMAIL_METADATA_HEADERS)[number]) => {
    const value = headers.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    )?.value;
    return value === undefined ? null : value.slice(0, 2_000);
  };
  return gmailMessageOutputSchema.parse({
    headers: {
      bcc: header("Bcc"),
      cc: header("Cc"),
      date: header("Date"),
      from: header("From"),
      messageId: header("Message-ID"),
      replyTo: header("Reply-To"),
      subject: header("Subject"),
      to: header("To"),
    },
    id: message.id,
    internalDate: message.internalDate ?? null,
    labelIds: message.labelIds,
    sizeEstimate: message.sizeEstimate ?? null,
    snippet: (message.snippet ?? "").slice(0, 4_000),
    threadId: message.threadId,
  });
}

function buildGmailRawMessage(
  input: z.infer<typeof gmailMessageSendArgumentsSchema>,
): string {
  const headers = [
    formatEmailAddressHeader("To", input.to),
    ...(input.cc?.length
      ? [formatEmailAddressHeader("Cc", input.cc)]
      : []),
    ...(input.bcc?.length
      ? [formatEmailAddressHeader("Bcc", input.bcc)]
      : []),
    `Subject: ${encodeMimeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const normalizedBody = input.textBody
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\r\n");
  const encodedBody = Buffer.from(normalizedBody, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n");
  return Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${encodedBody ?? ""}`,
    "utf8",
  ).toString("base64url");
}

function formatEmailAddressHeader(name: string, addresses: string[]): string {
  return `${name}: ${addresses.join(",\r\n ")}`;
}

function encodeMimeHeader(value: string): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk && Buffer.byteLength(chunk + character, "utf8") > 45) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map(
      (part) =>
        `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`,
    )
    .join("\r\n ");
}

function normalizeDriveFile(
  file: z.infer<typeof driveFileSchema>,
): z.infer<typeof driveFileOutputSchema> {
  return driveFileOutputSchema.parse({
    createdAt: file.createdTime ?? null,
    driveId: file.driveId ?? null,
    id: file.id,
    mimeType: file.mimeType,
    modifiedAt: file.modifiedTime ?? null,
    name: file.name,
    owners: file.owners.map((owner) => ({
      displayName: owner.displayName ?? null,
      emailAddress: owner.emailAddress ?? null,
      me: owner.me ?? false,
    })),
    parentIds: file.parents,
    shared: file.shared ?? false,
    sizeBytes: file.size ?? null,
    starred: file.starred ?? false,
    trashed: file.trashed ?? false,
    webViewUrl: file.webViewLink ?? null,
  });
}

interface GoogleDocTabSource {
  content: unknown[];
  id: string | null;
  parentId: string | null;
  title: string;
}

function normalizeGoogleDocument(
  document: z.infer<typeof googleDocsDocumentSchema>,
): z.infer<typeof googleDocsDocumentOutputSchema> {
  const collected = collectGoogleDocTabSources(document);
  let remaining = GOOGLE_DOC_TEXT_MAX_CHARS;
  let truncated = collected.truncated;
  const tabs = collected.sources.map((source) => {
    const extracted = extractGoogleDocsText(source.content, remaining);
    remaining -= extracted.text.length;
    truncated ||= extracted.truncated;
    return {
      id: source.id,
      parentId: source.parentId,
      text: extracted.text,
      title: source.title,
      truncated: extracted.truncated,
    };
  });
  return googleDocsDocumentOutputSchema.parse({
    documentId: document.documentId,
    revisionId: document.revisionId ?? null,
    tabs,
    title: document.title,
    truncated,
  });
}

function collectGoogleDocTabSources(
  document: z.infer<typeof googleDocsDocumentSchema>,
): { sources: GoogleDocTabSource[]; truncated: boolean } {
  if (document.tabs.length === 0) {
    return {
      sources: [
        {
          content: document.body?.content ?? [],
          id: null,
          parentId: null,
          title: document.title,
        },
      ],
      truncated: false,
    };
  }

  const sources: GoogleDocTabSource[] = [];
  const stack = [...document.tabs].reverse();
  while (stack.length > 0 && sources.length < GOOGLE_DOC_MAX_TABS) {
    const tab = parseProviderPayload(googleDocsTabSchema, stack.pop());
    sources.push({
      content: tab.documentTab?.body?.content ?? [],
      id: tab.tabProperties.tabId,
      parentId: tab.tabProperties.parentTabId ?? null,
      title: tab.tabProperties.title,
    });
    for (let index = tab.childTabs.length - 1; index >= 0; index -= 1) {
      stack.push(tab.childTabs[index]);
    }
  }
  return { sources, truncated: stack.length > 0 };
}

function extractGoogleDocsText(
  content: unknown[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const stack = [...content].reverse();
  let processed = 0;
  let text = "";
  let truncated = false;

  while (
    stack.length > 0 &&
    processed < GOOGLE_DOC_MAX_STRUCTURAL_ELEMENTS &&
    text.length < maxChars
  ) {
    const element = parseProviderPayload(
      googleDocsStructuralElementSchema,
      stack.pop(),
    );
    processed += 1;
    const paragraphText = (element.paragraph?.elements ?? [])
      .map((entry) => entry.textRun?.content ?? "")
      .join("");
    const remaining = maxChars - text.length;
    text += paragraphText.slice(0, remaining);
    if (paragraphText.length > remaining) truncated = true;

    const nested: unknown[] = [];
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells) nested.push(...cell.content);
    }
    nested.push(...(element.tableOfContents?.content ?? []));
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      stack.push(nested[index]);
    }
  }
  if (stack.length > 0) truncated = true;
  return { text, truncated };
}

function normalizeGitHubIssue(issue: z.infer<typeof githubIssueSchema>) {
  return {
    assignees: issue.assignees.map((assignee) => assignee.login),
    author: issue.user?.login ?? null,
    body: issue.body ?? null,
    closedAt: issue.closed_at ?? null,
    comments: issue.comments ?? 0,
    createdAt: issue.created_at,
    labels: issue.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label)),
    locked: issue.locked ?? false,
    milestone: issue.milestone
      ? { number: issue.milestone.number, title: issue.milestone.title }
      : null,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    type: issue.pull_request ? "pull_request" : "issue",
    updatedAt: issue.updated_at,
    url: issue.html_url,
  };
}

function normalizeGitHubContent(content: z.infer<typeof githubContentSchema>) {
  return {
    ...(content.content === undefined ? {} : { content: content.content }),
    downloadUrl: content.download_url ?? null,
    encoding: content.encoding ?? null,
    htmlUrl: content.html_url ?? null,
    name: content.name,
    path: content.path,
    sha: content.sha,
    size: content.size ?? null,
    type: content.type,
  };
}

function normalizeSlackMessage(message: z.infer<typeof slackMessageSchema>) {
  return {
    botId: message.bot_id ?? null,
    editedAt: message.edited?.ts ?? null,
    subtype: message.subtype ?? null,
    text: message.text,
    threadTimestamp: message.thread_ts ?? null,
    timestamp: message.ts,
    userId: message.user ?? null,
  };
}

function githubRepositoryUrl(owner: string, repo: string, suffix: string): URL {
  return new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(repo)}/${suffix}`,
  );
}

function encodeRepositoryPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}
