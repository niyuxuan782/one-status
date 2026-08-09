import { z } from "zod";
import { ONE_STATUS_VERSION } from "@one-status/protocol";
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
  readOnly: boolean;
  requiredScopes: string[];
  requiresConfirmation: boolean;
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
  throw new Error(`Unsupported provider action: ${action}`);
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
