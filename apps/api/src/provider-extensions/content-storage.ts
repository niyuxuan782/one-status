import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  addSearchParams,
  basicAuthorization,
  createOAuth2Provider,
  parseOAuthToken,
  parseProviderPayload,
  postOAuthForm,
  providerJsonRequest,
  requiredClientSecret,
  splitOAuthScopes,
  tokenExpiration,
  type ProviderExtension,
} from "../provider-extension.js";
import { ProviderRequestError } from "../provider-errors.js";

const resourceId = z.string().min(1).max(1_000);
const shortText = z.string().min(1).max(500);
const pageSize = z.number().int().min(1).max(100).default(50);

const notionTokenSchema = z.object({
  access_token: z.string().min(1).max(32_000),
  bot_id: resourceId.optional(),
  duplicated_template_id: z.string().max(1_000).nullable().optional(),
  owner: z.object({ user: z.object({ id: resourceId }).passthrough().optional() }).passthrough().optional(),
  refresh_token: z.string().min(1).max(32_000).optional(),
  token_type: z.string().max(100).optional(),
  workspace_icon: z.string().max(2_000).nullable().optional(),
  workspace_id: resourceId,
  workspace_name: z.string().max(500).nullable().optional(),
}).passthrough();

export const notionProvider: ProviderExtension = {
  id: "notion",
  definition: {
    id: "notion",
    label: "Notion",
    description: "读取页面与 Blocks，并在确认后创建受控页面。",
    accent: "#191919",
    documentationUrl: "https://developers.notion.com/guides/get-started/authorization",
    requiresPkce: false,
    requiresSecret: true,
    scopes: ["read_content", "insert_content"],
    actions: [
      readAction("notion.search", "搜索 Notion", "搜索已授权页面与数据源。", ["read_content"]),
      readAction("notion.pages.get", "读取 Notion 页面", "读取页面元数据和精简属性。", ["read_content"]),
      readAction("notion.blocks.children.list", "读取 Notion Blocks", "读取页面或 Block 的直接子级。", ["read_content"]),
      writeAction("notion.pages.create", "创建 Notion 页面", "在确认后创建标题与纯文本内容。", ["insert_content"]),
    ],
  },
  actionArgumentsSchema(action) {
    if (action === "notion.search") return notionSearchArguments;
    if (action === "notion.pages.get") return notionPageGetArguments;
    if (action === "notion.blocks.children.list") return notionBlocksListArguments;
    if (action === "notion.pages.create") return notionPageCreateArguments;
    throw unsupported(action);
  },
  buildAuthorizationUrl(input) {
    return addSearchParams(new URL("https://api.notion.com/v1/oauth/authorize"), {
      client_id: input.config.clientId,
      owner: "user",
      redirect_uri: input.redirectUri,
      response_type: "code",
      state: input.state,
    }).toString();
  },
  async exchangeOAuthCode(input) {
    const response = await notionOAuthRequest(input.fetch, input.config, {
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });
    const token = parseProviderPayload(notionTokenSchema, response.body);
    const userId = token.owner?.user?.id ?? token.bot_id ?? token.workspace_id;
    return {
      accountId: `${token.workspace_id}:${userId}`,
      credential: { accessToken: token.access_token, refreshToken: token.refresh_token, tokenType: token.token_type },
      expiresAt: null,
      label: token.workspace_name ?? `Notion ${token.workspace_id}`,
      scopes: ["read_content", "insert_content"],
    };
  },
  async refreshCredential(input) {
    if (!input.credential.refreshToken) throw new ProviderRequestError("The provider did not issue a refresh token.", "missing_refresh_token");
    const response = await notionOAuthRequest(input.fetch, input.config, { grant_type: "refresh_token", refresh_token: input.credential.refreshToken });
    const token = parseProviderPayload(notionTokenSchema, response.body);
    return {
      credential: { accessToken: token.access_token, refreshToken: token.refresh_token ?? input.credential.refreshToken, tokenType: token.token_type ?? input.credential.tokenType },
      expiresAt: null,
      scopes: ["read_content", "insert_content"],
    };
  },
  async revokeCredential(input) {
    await notionOAuthRequest(
      input.fetch,
      input.config,
      { token: input.credential.accessToken },
      "https://api.notion.com/v1/oauth/revoke",
    );
  },
  executeAction: executeNotionAction,
};

export const dropboxProvider = createOAuth2Provider({
  definition: {
    id: "dropbox",
    label: "Dropbox",
    description: "读取 Dropbox 文件元数据，并在确认后上传小型文件。",
    accent: "#0061ff",
    documentationUrl: "https://www.dropbox.com/lp/developers/reference/oauth-guide",
    requiresPkce: false,
    requiresSecret: true,
    scopes: ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write"],
    actions: [
      readAction("dropbox.files.list", "读取 Dropbox 文件", "分页读取指定目录。", ["files.metadata.read"]),
      readAction("dropbox.files.metadata.get", "读取 Dropbox 元数据", "读取指定文件或目录元数据。", ["files.metadata.read"]),
      readAction("dropbox.files.search", "搜索 Dropbox 文件", "在授权范围内搜索文件名。", ["files.metadata.read"]),
      writeAction("dropbox.files.upload", "上传 Dropbox 文件", "在确认后上传不超过 512 KiB 的内容。", ["files.content.write"]),
    ],
  },
  authorization: { extra: { token_access_type: "offline" }, url: "https://www.dropbox.com/oauth2/authorize" },
  token: { clientAuthentication: "basic", url: "https://api.dropboxapi.com/oauth2/token" },
  actionArgumentsSchema(action) {
    if (action === "dropbox.files.list") return dropboxFilesListArguments;
    if (action === "dropbox.files.metadata.get") return dropboxMetadataGetArguments;
    if (action === "dropbox.files.search") return dropboxSearchArguments;
    if (action === "dropbox.files.upload") return dropboxUploadArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await providerJsonRequest({ accessToken: token.access_token, fetch, init: { method: "POST" }, url: "https://api.dropboxapi.com/2/users/get_current_account" });
    const profile = parseProviderPayload(dropboxProfile, response.body);
    return { accountId: profile.account_id, label: profile.email ?? profile.name.display_name };
  },
  async revoke({ credential, fetch }) {
    await providerJsonRequest({ accessToken: credential.accessToken, fetch, init: { method: "POST" }, url: "https://api.dropboxapi.com/2/auth/token/revoke" });
  },
  executeAction: executeDropboxAction,
});

export const boxProvider = createOAuth2Provider({
  definition: {
    id: "box",
    label: "Box",
    description: "读取 Box 文件与搜索结果，并在确认后创建文件夹。",
    accent: "#0061d5",
    documentationUrl: "https://developer.box.com/guides/authentication/oauth2/without-sdk/",
    requiresPkce: false,
    requiresSecret: true,
    scopes: ["root_readwrite"],
    actions: [
      readAction("box.folders.items.list", "读取 Box 文件夹", "使用 marker 分页读取文件夹内容。", ["root_readwrite"]),
      readAction("box.files.get", "读取 Box 文件元数据", "读取指定文件的固定字段。", ["root_readwrite"]),
      readAction("box.search", "搜索 Box", "搜索当前用户可访问的内容。", ["root_readwrite"]),
      writeAction("box.folders.create", "创建 Box 文件夹", "在确认后创建文件夹。", ["root_readwrite"]),
    ],
  },
  authorization: { url: "https://account.box.com/api/oauth2/authorize" },
  token: { clientAuthentication: "body", url: "https://api.box.com/oauth2/token" },
  actionArgumentsSchema(action) {
    if (action === "box.folders.items.list") return boxFolderItemsArguments;
    if (action === "box.files.get") return boxFileGetArguments;
    if (action === "box.search") return boxSearchArguments;
    if (action === "box.folders.create") return boxFolderCreateArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await providerJsonRequest({ accessToken: token.access_token, fetch, url: "https://api.box.com/2.0/users/me?fields=id,name,login,status,enterprise" });
    const profile = parseProviderPayload(boxProfile, response.body);
    return { accountId: profile.id, label: profile.login ?? profile.name };
  },
  async revoke({ config, credential, fetch }) {
    await postOAuthForm({
      fetch,
      url: "https://api.box.com/oauth2/revoke",
      values: { client_id: config.clientId, client_secret: requiredClientSecret(config), token: credential.refreshToken ?? credential.accessToken },
    });
  },
  executeAction: executeBoxAction,
});

export const contentStorageProviders: readonly ProviderExtension[] = [
  notionProvider,
  dropboxProvider,
  boxProvider,
];

const notionSearchArguments = z.object({ cursor: z.string().max(2_000).optional(), limit: z.number().int().min(1).max(50).default(50), query: z.string().max(200).default(""), type: z.enum(["page", "data_source"]).optional() }).strict();
const notionPageGetArguments = z.object({ pageId: resourceId }).strict();
const notionBlocksListArguments = z.object({ blockId: resourceId, cursor: z.string().max(2_000).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
const notionPageCreateArguments = z.object({ content: z.string().max(10_000).default(""), parentPageId: resourceId, title: z.string().min(1).max(200) }).strict();
const notionRichText = z.object({ plain_text: z.string().max(10_000).optional() }).passthrough();
const notionPage = z.object({
  archived: z.boolean().optional(),
  created_time: z.string().max(100).optional(),
  id: resourceId,
  in_trash: z.boolean().optional(),
  last_edited_time: z.string().max(100).optional(),
  object: z.string().max(100),
  parent: z.record(z.string(), z.unknown()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  url: z.url().optional(),
}).passthrough();
const notionBlock = z.object({
  archived: z.boolean().optional(),
  created_time: z.string().max(100).optional(),
  has_children: z.boolean().optional(),
  id: resourceId,
  in_trash: z.boolean().optional(),
  last_edited_time: z.string().max(100).optional(),
  object: z.string().max(100),
  type: z.string().max(100).optional(),
}).passthrough();
const notionList = <T extends z.ZodType>(item: T) => z.object({ has_more: z.boolean(), next_cursor: z.string().max(2_000).nullable().optional(), results: z.array(item).max(1_000) }).passthrough();

async function notionOAuthRequest(fetch: Parameters<typeof providerJsonRequest>[0]["fetch"], config: { clientId: string; clientSecret?: string }, body: Record<string, string>, url = "https://api.notion.com/v1/oauth/token") {
  return providerJsonRequest({
    fetch,
    init: { body: JSON.stringify(body), headers: { accept: "application/json", authorization: basicAuthorization(config), "content-type": "application/json" }, method: "POST" },
    url,
  });
}

async function executeNotionAction(input: Parameters<ProviderExtension["executeAction"]>[0]) {
  if (input.action === "notion.search") {
    const args = notionSearchArguments.parse(input.arguments ?? {});
    const response = await notionRequest(input, "https://api.notion.com/v1/search", { body: JSON.stringify({ filter: args.type ? { property: "object", value: args.type } : undefined, page_size: args.limit, query: args.query || undefined, start_cursor: args.cursor }), method: "POST" });
    const body = parseProviderPayload(notionList(notionPage), response.body);
    return { data: { items: body.results.map(normalizeNotionPage), nextCursor: body.next_cursor ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "notion.pages.get") {
    const args = notionPageGetArguments.parse(input.arguments);
    const response = await notionRequest(input, `https://api.notion.com/v1/pages/${encodeURIComponent(args.pageId)}`);
    return { data: normalizeNotionPage(parseProviderPayload(notionPage, response.body)), providerRequestId: response.requestId };
  }
  if (input.action === "notion.blocks.children.list") {
    const args = notionBlocksListArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`https://api.notion.com/v1/blocks/${encodeURIComponent(args.blockId)}/children`), { page_size: String(args.limit), start_cursor: args.cursor });
    const response = await notionRequest(input, url);
    const body = parseProviderPayload(notionList(notionBlock), response.body);
    return { data: { items: body.results.map((block) => ({ createdAt: block.created_time ?? null, hasChildren: block.has_children ?? false, id: block.id, lastEditedAt: block.last_edited_time ?? null, type: block.type ?? null })), nextCursor: body.next_cursor ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "notion.pages.create") {
    const args = notionPageCreateArguments.parse(input.arguments);
    const children = args.content ? chunkText(args.content, 2_000).map((content) => ({ object: "block", paragraph: { rich_text: [{ text: { content }, type: "text" }] }, type: "paragraph" })) : [];
    const response = await notionRequest(input, "https://api.notion.com/v1/pages", { body: JSON.stringify({ children, parent: { page_id: args.parentPageId }, properties: { title: { title: [{ text: { content: args.title }, type: "text" }] } } }), method: "POST" });
    return { data: normalizeNotionPage(parseProviderPayload(notionPage, response.body)), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function notionRequest(input: Parameters<ProviderExtension["executeAction"]>[0], url: string | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("notion-version", "2026-03-11");
  return providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, init: { ...init, headers }, url });
}

function normalizeNotionPage(page: z.infer<typeof notionPage>) {
  return {
    archived: page.archived ?? false,
    createdAt: page.created_time ?? null,
    id: page.id,
    inTrash: page.in_trash ?? false,
    lastEditedAt: page.last_edited_time ?? null,
    parent: page.parent ?? null,
    properties: normalizeNotionProperties(page.properties),
    title: notionPageTitle(page.properties),
    url: page.url ?? null,
  };
}

function normalizeNotionProperties(properties: Record<string, unknown> | undefined) {
  if (!properties) return {};
  return Object.fromEntries(Object.entries(properties).slice(0, 50).map(([key, value]) => [key, compactNotionProperty(value)]));
}

function compactNotionProperty(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  const candidate = type ? record[type] : undefined;
  if (Array.isArray(candidate)) {
    return { type, text: candidate.map((entry) => notionRichText.safeParse(entry).data?.plain_text ?? "").join("").slice(0, 4_000) };
  }
  if (["string", "number", "boolean"].includes(typeof candidate) || candidate === null) return { type, value: candidate };
  return { type };
}

function notionPageTitle(properties: Record<string, unknown> | undefined): string | null {
  for (const value of Object.values(properties ?? {})) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "title" || !Array.isArray(record.title)) continue;
    return record.title.map((entry) => notionRichText.safeParse(entry).data?.plain_text ?? "").join("").slice(0, 1_000) || null;
  }
  return null;
}

const dropboxProfile = z.object({ account_id: resourceId, email: z.string().max(500).optional(), name: z.object({ display_name: shortText }) }).passthrough();
const dropboxFilesListArguments = z.object({ cursor: z.string().max(4_000).optional(), includeDeleted: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(100), path: z.string().max(2_000).default("") }).strict();
const dropboxMetadataGetArguments = z.object({ path: z.string().min(1).max(2_000) }).strict();
const dropboxSearchArguments = z.object({ cursor: z.string().max(4_000).optional(), limit: z.number().int().min(1).max(100).default(100), path: z.string().max(2_000).default(""), query: z.string().min(1).max(1_000) }).strict();
const dropboxUploadArguments = z.object({ contentBase64: z.string().min(1).max(710_000), mode: z.enum(["add", "overwrite"]).default("add"), path: z.string().min(1).max(2_000) }).strict();
const dropboxMetadata = z.object({
  ".tag": z.string().max(100),
  content_hash: z.string().max(500).optional(),
  id: resourceId.optional(),
  is_downloadable: z.boolean().optional(),
  name: shortText,
  path_display: z.string().max(2_000).nullable().optional(),
  rev: z.string().max(500).optional(),
  server_modified: z.string().max(100).optional(),
  size: z.number().nonnegative().optional(),
}).passthrough();
const dropboxListResponse = z.object({ cursor: z.string().max(4_000), entries: z.array(dropboxMetadata).max(2_000), has_more: z.boolean() }).passthrough();
const dropboxSearchResponse = z.object({ cursor: z.string().max(4_000).optional(), has_more: z.boolean(), matches: z.array(z.object({ metadata: z.object({ metadata: dropboxMetadata }).passthrough() }).passthrough()).max(10_000) }).passthrough();

async function executeDropboxAction(input: Parameters<ProviderExtension["executeAction"]>[0]) {
  if (input.action === "dropbox.files.list") {
    const args = dropboxFilesListArguments.parse(input.arguments ?? {});
    const endpoint = args.cursor ? "/2/files/list_folder/continue" : "/2/files/list_folder";
    const body = args.cursor ? { cursor: args.cursor } : { include_deleted: args.includeDeleted, limit: args.limit, path: args.path, recursive: false };
    const response = await dropboxRpc(input, endpoint, body);
    const list = parseProviderPayload(dropboxListResponse, response.body);
    return { data: { hasMore: list.has_more, items: list.entries.slice(0, 100).map(normalizeDropboxMetadata), nextCursor: list.has_more ? list.cursor : null }, providerRequestId: response.requestId };
  }
  if (input.action === "dropbox.files.metadata.get") {
    const args = dropboxMetadataGetArguments.parse(input.arguments);
    const response = await dropboxRpc(input, "/2/files/get_metadata", { include_deleted: false, path: args.path });
    return { data: normalizeDropboxMetadata(parseProviderPayload(dropboxMetadata, response.body)), providerRequestId: response.requestId };
  }
  if (input.action === "dropbox.files.search") {
    const args = dropboxSearchArguments.parse(input.arguments);
    const endpoint = args.cursor ? "/2/files/search/continue_v2" : "/2/files/search_v2";
    const body = args.cursor ? { cursor: args.cursor } : { match_field_options: { include_highlights: false }, options: { file_extensions: [], max_results: args.limit, path: args.path }, query: args.query };
    const response = await dropboxRpc(input, endpoint, body);
    const search = parseProviderPayload(dropboxSearchResponse, response.body);
    return { data: { hasMore: search.has_more, items: search.matches.slice(0, 100).map((match) => normalizeDropboxMetadata(match.metadata.metadata)), nextCursor: search.has_more ? search.cursor ?? null : null }, providerRequestId: response.requestId };
  }
  if (input.action === "dropbox.files.upload") {
    const args = dropboxUploadArguments.parse(input.arguments);
    const content = decodeBase64(args.contentBase64, 512 * 1024);
    const response = await providerJsonRequest({
      accessToken: input.credential.accessToken,
      fetch: input.fetch,
      init: { body: content, headers: { "content-type": "application/octet-stream", "dropbox-api-arg": JSON.stringify({ autorename: false, mode: args.mode, mute: false, path: args.path, strict_conflict: true }) }, method: "POST" },
      url: "https://content.dropboxapi.com/2/files/upload",
    });
    return { data: normalizeDropboxMetadata(parseProviderPayload(dropboxMetadata, response.body)), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function dropboxRpc(input: Parameters<ProviderExtension["executeAction"]>[0], path: string, body: unknown) {
  return providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, init: { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }, url: `https://api.dropboxapi.com${path}` });
}

function normalizeDropboxMetadata(entry: z.infer<typeof dropboxMetadata>) {
  return { contentHash: entry.content_hash ?? null, downloadable: entry.is_downloadable ?? false, id: entry.id ?? null, kind: entry[".tag"], modifiedAt: entry.server_modified ?? null, name: entry.name, path: entry.path_display ?? null, revision: entry.rev ?? null, size: entry.size ?? null };
}

const boxProfile = z.object({ enterprise: z.object({ id: resourceId, name: shortText }).nullable().optional(), id: resourceId, login: z.string().max(500).optional(), name: shortText, status: z.string().max(100).optional() }).passthrough();
const boxFolderItemsArguments = z.object({ folderId: resourceId.default("0"), limit: pageSize, marker: z.string().max(2_000).optional() }).strict();
const boxFileGetArguments = z.object({ fileId: resourceId }).strict();
const boxSearchArguments = z.object({ limit: pageSize, offset: z.number().int().min(0).max(10_000).default(0), query: z.string().min(1).max(500) }).strict();
const boxFolderCreateArguments = z.object({ name: z.string().min(1).max(255).refine(validBoxFolderName, "folder name is invalid"), parentId: resourceId.default("0") }).strict();
const boxOwner = z.object({ id: resourceId, login: z.string().max(500).optional(), name: z.string().max(500).optional() }).passthrough();
const boxItem = z.object({
  id: resourceId,
  modified_at: z.string().max(100).nullable().optional(),
  name: z.string().max(1_000),
  owned_by: boxOwner.optional(),
  parent: z.object({ id: resourceId, name: z.string().max(1_000).optional() }).nullable().optional(),
  permissions: z.record(z.string(), z.boolean()).optional(),
  sha1: z.string().max(500).nullable().optional(),
  size: z.number().nonnegative().optional(),
  type: z.string().max(100),
}).passthrough();
const boxItemsResponse = z.object({ entries: z.array(boxItem).max(1_000), next_marker: z.string().max(2_000).nullable().optional(), total_count: z.number().optional() }).passthrough();

async function executeBoxAction(input: Parameters<ProviderExtension["executeAction"]>[0]) {
  const fields = "id,type,name,size,sha1,modified_at,parent,owned_by,permissions";
  if (input.action === "box.folders.items.list") {
    const args = boxFolderItemsArguments.parse(input.arguments ?? {});
    const url = addSearchParams(new URL(`https://api.box.com/2.0/folders/${encodeURIComponent(args.folderId)}/items`), { fields, limit: String(args.limit), marker: args.marker, usemarker: "true" });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(boxItemsResponse, response.body);
    return { data: { items: body.entries.map(normalizeBoxItem), nextMarker: body.next_marker ?? null, totalCount: body.total_count ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "box.files.get") {
    const args = boxFileGetArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`https://api.box.com/2.0/files/${encodeURIComponent(args.fileId)}`), { fields });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    return { data: normalizeBoxItem(parseProviderPayload(boxItem, response.body)), providerRequestId: response.requestId };
  }
  if (input.action === "box.search") {
    const args = boxSearchArguments.parse(input.arguments);
    const url = addSearchParams(new URL("https://api.box.com/2.0/search"), { fields, limit: String(args.limit), offset: String(args.offset), query: args.query, scope: "user_content" });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(boxItemsResponse, response.body);
    return { data: { items: body.entries.map(normalizeBoxItem), nextOffset: body.entries.length === args.limit ? args.offset + args.limit : null, totalCount: body.total_count ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "box.folders.create") {
    const args = boxFolderCreateArguments.parse(input.arguments);
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, init: { body: JSON.stringify({ name: args.name, parent: { id: args.parentId } }), headers: { "content-type": "application/json" }, method: "POST" }, url: "https://api.box.com/2.0/folders" });
    return { data: normalizeBoxItem(parseProviderPayload(boxItem, response.body)), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function normalizeBoxItem(item: z.infer<typeof boxItem>) {
  return { id: item.id, modifiedAt: item.modified_at ?? null, name: item.name, owner: item.owned_by ? { id: item.owned_by.id, login: item.owned_by.login ?? null, name: item.owned_by.name ?? null } : null, parent: item.parent ? { id: item.parent.id, name: item.parent.name ?? null } : null, permissions: item.permissions ?? null, sha1: item.sha1 ?? null, size: item.size ?? null, type: item.type };
}

function validBoxFolderName(value: string): boolean {
  return value !== "." && value !== ".." && !/[\u0000-\u001f\\/]/.test(value) && !value.endsWith(" ");
}

function decodeBase64(value: string, maximumBytes: number): ArrayBuffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new ProviderRequestError("File content is not valid base64.", "invalid_file_content");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maximumBytes) throw new ProviderRequestError("File content exceeds the upload limit.", "file_content_too_large");
  return Uint8Array.from(bytes).buffer;
}

function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) chunks.push(value.slice(offset, offset + size));
  return chunks;
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
