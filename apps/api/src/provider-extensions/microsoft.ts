import { z } from "zod";
import {
  addSearchParams,
  createOAuth2Provider,
  parseProviderPayload,
  providerJsonRequest,
  type ProviderExtension,
} from "../provider-extension.js";
import { ProviderRequestError } from "../provider-errors.js";

const graphBase = "https://graph.microsoft.com/v1.0";
const resourceId = z.string().min(1).max(1_000);
const pageSize = z.number().int().min(1).max(100).default(50);
const cursor = z.string().min(1).max(4_000).optional();

export const microsoftProvider = createOAuth2Provider({
  definition: {
    id: "microsoft",
    label: "Microsoft 365",
    description: "统一访问 Outlook、Teams、OneDrive 与 SharePoint。",
    accent: "#00a4ef",
    documentationUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    requiresPkce: true,
    requiresSecret: true,
    scopes: [
      "offline_access",
      "openid",
      "profile",
      "email",
      "User.Read",
      "Mail.Read",
      "Mail.Send",
      "Calendars.Read",
      "Chat.ReadBasic",
      "Chat.Read",
      "Files.Read",
      "Sites.Read.All",
    ],
    actions: [
      readAction("outlook.messages.list", "读取 Outlook 邮件", "读取最近邮件的受控字段。", ["Mail.Read"]),
      readAction("outlook.messages.get", "读取 Outlook 邮件详情", "读取单封邮件的受控正文与元数据。", ["Mail.Read"]),
      writeAction("outlook.messages.send", "发送 Outlook 邮件", "在确认后通过 Microsoft Graph 发送邮件。", ["Mail.Send"]),
      readAction("outlook.calendar.events.list", "读取 Outlook 日历", "读取指定时间范围内的 Calendar View。", ["Calendars.Read"]),
      readAction("teams.chats.list", "读取 Teams Chats", "读取当前用户参与的聊天。", ["Chat.ReadBasic"]),
      readAction("teams.chat_messages.list", "读取 Teams 消息", "读取指定聊天的消息。", ["Chat.Read"]),
      readAction("onedrive.children.list", "读取 OneDrive 文件", "读取根目录或指定目录的子项。", ["Files.Read"]),
      readAction("sharepoint.site_files.list", "读取 SharePoint 文件", "解析指定站点并读取默认文档库根目录。", ["Sites.Read.All"]),
    ],
  },
  authorization: {
    url: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    extra: { prompt: "select_account" },
  },
  token: {
    clientAuthentication: "body",
    sendPkce: true,
    url: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  },
  actionArgumentsSchema(action) {
    if (action === "outlook.messages.list") return outlookMessagesListArguments;
    if (action === "outlook.messages.get") return outlookMessageGetArguments;
    if (action === "outlook.messages.send") return outlookMessageSendArguments;
    if (action === "outlook.calendar.events.list") return outlookCalendarListArguments;
    if (action === "teams.chats.list") return teamsChatsListArguments;
    if (action === "teams.chat_messages.list") return teamsMessagesListArguments;
    if (action === "onedrive.children.list") return oneDriveChildrenListArguments;
    if (action === "sharepoint.site_files.list") return sharePointFilesListArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await providerJsonRequest({
      accessToken: token.access_token,
      fetch,
      url: `${graphBase}/me?$select=id,displayName,mail,userPrincipalName`,
    });
    const profile = parseProviderPayload(graphUser, response.body);
    return {
      accountId: profile.id,
      label: profile.mail ?? profile.userPrincipalName ?? profile.displayName,
    };
  },
  executeAction: executeMicrosoftAction,
});

export const microsoftProviders: readonly ProviderExtension[] = [microsoftProvider];

const outlookMessagesListArguments = z.object({
  cursor,
  folderId: resourceId.default("inbox"),
  limit: pageSize,
  search: z.string().min(1).max(500).optional(),
}).strict();
const outlookMessageGetArguments = z.object({ messageId: resourceId }).strict();
const outlookMessageSendArguments = z.object({
  body: z.string().min(1).max(100_000),
  cc: z.array(z.email().max(500)).max(50).default([]),
  saveToSentItems: z.boolean().default(true),
  subject: z.string().min(1).max(1_000),
  to: z.array(z.email().max(500)).min(1).max(50),
}).strict();
const outlookCalendarListArguments = z.object({
  cursor,
  endDateTime: z.iso.datetime({ offset: true }),
  limit: pageSize,
  startDateTime: z.iso.datetime({ offset: true }),
  timezone: z.string().min(1).max(100).default("UTC"),
}).strict().refine((value) => Date.parse(value.endDateTime) > Date.parse(value.startDateTime), { message: "endDateTime must be after startDateTime", path: ["endDateTime"] });
const teamsChatsListArguments = z.object({ cursor, limit: pageSize }).strict();
const teamsMessagesListArguments = z.object({ chatId: resourceId, cursor, limit: pageSize }).strict();
const oneDriveChildrenListArguments = z.object({ cursor, folderId: resourceId.optional(), limit: pageSize }).strict();
const sharePointFilesListArguments = z.object({
  cursor,
  hostname: z.string().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.sharepoint\.com$/i),
  limit: pageSize,
  sitePath: z.string().min(1).max(1_000).regex(/^\/(?:sites|teams)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/),
}).strict();

const graphUser = z.object({
  displayName: z.string().max(500),
  id: resourceId,
  mail: z.string().max(500).nullable().optional(),
  userPrincipalName: z.string().max(500).optional(),
}).passthrough();
const graphEmailAddress = z.object({ address: z.string().max(500).optional(), name: z.string().max(500).optional() }).passthrough();
const graphRecipient = z.object({ emailAddress: graphEmailAddress }).passthrough();
const graphBody = z.object({ content: z.string().max(500_000).optional(), contentType: z.string().max(50).optional() }).passthrough();
const graphMessage = z.object({
  bccRecipients: z.array(graphRecipient).max(500).optional(),
  body: graphBody.optional(),
  bodyPreview: z.string().max(5_000).optional(),
  ccRecipients: z.array(graphRecipient).max(500).optional(),
  conversationId: z.string().max(1_000).optional(),
  from: graphRecipient.nullable().optional(),
  hasAttachments: z.boolean().optional(),
  id: resourceId,
  importance: z.string().max(50).optional(),
  isRead: z.boolean().optional(),
  receivedDateTime: z.string().max(100).optional(),
  sender: graphRecipient.nullable().optional(),
  sentDateTime: z.string().max(100).optional(),
  subject: z.string().max(1_000).nullable().optional(),
  toRecipients: z.array(graphRecipient).max(500).optional(),
  webLink: z.url().optional(),
}).passthrough();
const graphDateTimeZone = z.object({ dateTime: z.string().max(100).optional(), timeZone: z.string().max(100).optional() }).passthrough();
const graphEvent = z.object({
  attendees: z.array(z.object({ emailAddress: graphEmailAddress, status: z.object({ response: z.string().max(100).optional(), time: z.string().max(100).optional() }).optional() }).passthrough()).max(1_000).optional(),
  bodyPreview: z.string().max(5_000).optional(),
  end: graphDateTimeZone,
  id: resourceId,
  isAllDay: z.boolean().optional(),
  location: z.object({ displayName: z.string().max(1_000).optional() }).optional(),
  organizer: graphRecipient.optional(),
  start: graphDateTimeZone,
  subject: z.string().max(1_000).nullable().optional(),
  webLink: z.url().optional(),
}).passthrough();
const graphChat = z.object({
  chatType: z.string().max(100).optional(),
  createdDateTime: z.string().max(100).optional(),
  id: resourceId,
  lastUpdatedDateTime: z.string().max(100).optional(),
  topic: z.string().max(1_000).nullable().optional(),
  webUrl: z.url().nullable().optional(),
}).passthrough();
const graphChatMessage = z.object({
  body: graphBody.optional(),
  createdDateTime: z.string().max(100).optional(),
  deletedDateTime: z.string().max(100).nullable().optional(),
  from: z.object({ user: z.object({ displayName: z.string().max(500).optional(), id: resourceId.optional() }).nullable().optional() }).nullable().optional(),
  id: resourceId,
  importance: z.string().max(100).optional(),
  lastModifiedDateTime: z.string().max(100).optional(),
  messageType: z.string().max(100).optional(),
  subject: z.string().max(1_000).nullable().optional(),
  webUrl: z.url().nullable().optional(),
}).passthrough();
const graphDriveItem = z.object({
  createdDateTime: z.string().max(100).optional(),
  file: z.object({ mimeType: z.string().max(500).optional() }).optional(),
  folder: z.object({ childCount: z.number().optional() }).optional(),
  id: resourceId,
  lastModifiedDateTime: z.string().max(100).optional(),
  name: z.string().max(1_000),
  parentReference: z.object({ driveId: z.string().max(1_000).optional(), id: z.string().max(1_000).optional(), path: z.string().max(2_000).optional() }).optional(),
  size: z.number().nonnegative().optional(),
  webUrl: z.url().optional(),
}).passthrough();
const graphSite = z.object({ displayName: z.string().max(1_000).optional(), id: resourceId, name: z.string().max(1_000).optional(), webUrl: z.url().optional() }).passthrough();

async function executeMicrosoftAction(input: Parameters<ProviderExtension["executeAction"]>[0]) {
  if (input.action === "outlook.messages.list") {
    const args = outlookMessagesListArguments.parse(input.arguments ?? {});
    const initialUrl = addSearchParams(new URL(`${graphBase}/me/mailFolders/${encodeURIComponent(args.folderId)}/messages`), {
      "$orderby": args.search ? undefined : "receivedDateTime desc",
      "$search": args.search ? `\"${escapeGraphSearch(args.search)}\"` : undefined,
      "$select": "id,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,bodyPreview,conversationId,webLink",
      "$top": String(args.limit),
    });
    const url = restoreGraphCursor(initialUrl, args.cursor);
    return graphList(input, url, graphMessage, normalizeMessage);
  }
  if (input.action === "outlook.messages.get") {
    const args = outlookMessageGetArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`${graphBase}/me/messages/${encodeURIComponent(args.messageId)}`), { "$select": "id,subject,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,body,bodyPreview,conversationId,webLink" });
    const response = await graphRequest(input, url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
    return { data: normalizeMessage(parseProviderPayload(graphMessage, response.body), true), providerRequestId: response.requestId };
  }
  if (input.action === "outlook.messages.send") {
    const args = outlookMessageSendArguments.parse(input.arguments);
    const response = await graphRequest(input, `${graphBase}/me/sendMail`, {
      body: JSON.stringify({ message: { body: { content: args.body, contentType: "Text" }, ccRecipients: args.cc.map(recipient), subject: args.subject, toRecipients: args.to.map(recipient) }, saveToSentItems: args.saveToSentItems }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { data: { accepted: true }, providerRequestId: response.requestId };
  }
  if (input.action === "outlook.calendar.events.list") {
    const args = outlookCalendarListArguments.parse(input.arguments);
    const initialUrl = addSearchParams(new URL(`${graphBase}/me/calendarView`), {
      "$orderby": "start/dateTime",
      "$select": "id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,webLink",
      "$top": String(args.limit),
      endDateTime: args.endDateTime,
      startDateTime: args.startDateTime,
    });
    const url = restoreGraphCursor(initialUrl, args.cursor);
    return graphList(input, url, graphEvent, normalizeEvent, { headers: { Prefer: `outlook.timezone="${safeHeaderValue(args.timezone)}"` } });
  }
  if (input.action === "teams.chats.list") {
    const args = teamsChatsListArguments.parse(input.arguments ?? {});
    const initialUrl = addSearchParams(new URL(`${graphBase}/me/chats`), { "$top": String(args.limit), "$select": "id,topic,chatType,createdDateTime,lastUpdatedDateTime,webUrl" });
    const url = restoreGraphCursor(initialUrl, args.cursor);
    return graphList(input, url, graphChat, (chat) => ({ chatType: chat.chatType ?? null, createdAt: chat.createdDateTime ?? null, id: chat.id, lastUpdatedAt: chat.lastUpdatedDateTime ?? null, topic: chat.topic ?? null, webUrl: chat.webUrl ?? null }));
  }
  if (input.action === "teams.chat_messages.list") {
    const args = teamsMessagesListArguments.parse(input.arguments);
    const initialUrl = addSearchParams(new URL(`${graphBase}/chats/${encodeURIComponent(args.chatId)}/messages`), { "$top": String(args.limit) });
    const url = restoreGraphCursor(initialUrl, args.cursor);
    return graphList(input, url, graphChatMessage, normalizeChatMessage);
  }
  if (input.action === "onedrive.children.list") {
    const args = oneDriveChildrenListArguments.parse(input.arguments ?? {});
    const path = args.folderId ? `/me/drive/items/${encodeURIComponent(args.folderId)}/children` : "/me/drive/root/children";
    const initialUrl = addSearchParams(new URL(`${graphBase}${path}`), { "$select": "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference", "$top": String(args.limit) });
    const url = restoreGraphCursor(initialUrl, args.cursor);
    return graphList(input, url, graphDriveItem, normalizeDriveItem);
  }
  if (input.action === "sharepoint.site_files.list") {
    const args = sharePointFilesListArguments.parse(input.arguments);
    const siteResponse = await graphRequest(input, `${graphBase}/sites/${encodeURIComponent(args.hostname)}:${encodeGraphPath(args.sitePath)}?$select=id,name,displayName,webUrl`);
    const site = parseProviderPayload(graphSite, siteResponse.body);
    const initialUrl = addSearchParams(new URL(`${graphBase}/sites/${encodeURIComponent(site.id)}/drive/root/children`), { "$select": "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference", "$top": String(args.limit) });
    const url = restoreGraphCursor(initialUrl, args.cursor);
    const files = await graphList(input, url, graphDriveItem, normalizeDriveItem);
    return { ...files, data: { ...(files.data as object), site: { displayName: site.displayName ?? null, id: site.id, name: site.name ?? null, webUrl: site.webUrl ?? null } } };
  }
  throw unsupported(input.action);
}

async function graphList<T>(input: Parameters<ProviderExtension["executeAction"]>[0], url: URL, itemSchema: z.ZodType<T>, normalize: (item: T) => unknown, init?: RequestInit) {
  const response = await graphRequest(input, url, init);
  const body = parseProviderPayload(z.object({ "@odata.nextLink": z.url().optional(), value: z.array(itemSchema).max(1_000) }).passthrough(), response.body);
  return { data: { items: body.value.map(normalize), nextCursor: graphCursor(body["@odata.nextLink"], url.pathname) }, providerRequestId: response.requestId };
}

function graphRequest(input: Parameters<ProviderExtension["executeAction"]>[0], url: string | URL, init?: RequestInit) {
  return providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, init, url });
}

function graphCursor(nextLink: string | undefined, expectedPath: string): string | null {
  if (!nextLink) return null;
  const url = new URL(nextLink);
  if (url.origin !== "https://graph.microsoft.com" || url.pathname !== expectedPath) return null;
  const query = [...url.searchParams.entries()];
  if (
    query.length === 0 ||
    query.length > 20 ||
    query.some(
      ([key, value]) =>
        !graphCursorQueryKeys.has(key) || value.length > 4_000,
    )
  ) {
    return null;
  }
  const encoded = Buffer.from(
    JSON.stringify({ path: url.pathname, query }),
    "utf8",
  ).toString("base64url");
  return encoded.length <= 4_000 ? encoded : null;
}

const graphCursorQueryKeys = new Set([
  "$filter",
  "$orderby",
  "$search",
  "$select",
  "$skip",
  "$skiptoken",
  "$top",
  "endDateTime",
  "startDateTime",
]);

function restoreGraphCursor(initialUrl: URL, cursorValue?: string): URL {
  if (!cursorValue) return initialUrl;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursorValue, "base64url").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid cursor");
    }
    const { path, query } = decoded as { path?: unknown; query?: unknown };
    if (path !== initialUrl.pathname || !Array.isArray(query) || query.length > 20) {
      throw new Error("invalid cursor");
    }
    const restored = new URL(
      initialUrl.pathname,
      "https://graph.microsoft.com",
    );
    for (const entry of query) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string" ||
        !graphCursorQueryKeys.has(entry[0]) ||
        entry[1].length > 4_000
      ) {
        throw new Error("invalid cursor");
      }
      restored.searchParams.append(entry[0], entry[1]);
    }
    return restored;
  } catch {
    throw new ProviderRequestError(
      "Microsoft Graph cursor is invalid.",
      "invalid_pagination_cursor",
    );
  }
}

function normalizeMessage(message: z.infer<typeof graphMessage>, includeBody = false) {
  return {
    bcc: (message.bccRecipients ?? []).map(normalizeRecipient),
    body: includeBody ? boundedText(message.body?.content, 100_000) : null,
    bodyPreview: boundedText(message.bodyPreview, 5_000),
    cc: (message.ccRecipients ?? []).map(normalizeRecipient),
    conversationId: message.conversationId ?? null,
    from: message.from ? normalizeRecipient(message.from) : null,
    hasAttachments: message.hasAttachments ?? false,
    id: message.id,
    importance: message.importance ?? null,
    isRead: message.isRead ?? false,
    receivedAt: message.receivedDateTime ?? null,
    sentAt: message.sentDateTime ?? null,
    subject: message.subject ?? "(No subject)",
    to: (message.toRecipients ?? []).map(normalizeRecipient),
    webLink: message.webLink ?? null,
  };
}

function normalizeRecipient(value: z.infer<typeof graphRecipient>) {
  return { address: value.emailAddress.address ?? null, name: value.emailAddress.name ?? null };
}

function recipient(address: string) {
  return { emailAddress: { address } };
}

function normalizeEvent(event: z.infer<typeof graphEvent>) {
  return {
    allDay: event.isAllDay ?? false,
    attendees: (event.attendees ?? []).map((attendee) => ({ email: attendee.emailAddress.address ?? null, name: attendee.emailAddress.name ?? null, response: attendee.status?.response ?? null })),
    bodyPreview: boundedText(event.bodyPreview, 5_000),
    end: event.end,
    id: event.id,
    location: event.location?.displayName ?? null,
    organizer: event.organizer ? normalizeRecipient(event.organizer) : null,
    start: event.start,
    subject: event.subject ?? "(Untitled event)",
    webLink: event.webLink ?? null,
  };
}

function normalizeChatMessage(message: z.infer<typeof graphChatMessage>) {
  return {
    author: message.from?.user ? { id: message.from.user.id ?? null, name: message.from.user.displayName ?? null } : null,
    body: boundedText(stripHtml(message.body?.content), 20_000),
    createdAt: message.createdDateTime ?? null,
    deletedAt: message.deletedDateTime ?? null,
    id: message.id,
    importance: message.importance ?? null,
    messageType: message.messageType ?? null,
    subject: message.subject ?? null,
    updatedAt: message.lastModifiedDateTime ?? null,
    webUrl: message.webUrl ?? null,
  };
}

function normalizeDriveItem(item: z.infer<typeof graphDriveItem>) {
  return {
    childCount: item.folder?.childCount ?? null,
    createdAt: item.createdDateTime ?? null,
    driveId: item.parentReference?.driveId ?? null,
    file: Boolean(item.file),
    folder: Boolean(item.folder),
    id: item.id,
    mimeType: item.file?.mimeType ?? null,
    modifiedAt: item.lastModifiedDateTime ?? null,
    name: item.name,
    parentId: item.parentReference?.id ?? null,
    size: item.size ?? null,
    webUrl: item.webUrl ?? null,
  };
}

function encodeGraphPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function escapeGraphSearch(value: string): string {
  return value.replace(/["\\]/g, " ").trim();
}

function safeHeaderValue(value: string): string {
  if (/[^A-Za-z0-9_+./ -]/.test(value)) return "UTC";
  return value;
}

function stripHtml(value?: string): string | undefined {
  return value?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function boundedText(value: string | undefined, maximum: number): string | null {
  return value === undefined ? null : value.slice(0, maximum);
}

function readAction(id: string, title: string, description: string, requiredScopes: string[]) {
  return { description, id, readOnly: true, requiredScopes, requiresConfirmation: false, title };
}

function writeAction(id: string, title: string, description: string, requiredScopes: string[]) {
  return { description, id, readOnly: false, requiredScopes, requiresConfirmation: true, title };
}

function unsupported(action: string): Error {
  return new Error(`Unsupported provider action: ${action}`);
}
