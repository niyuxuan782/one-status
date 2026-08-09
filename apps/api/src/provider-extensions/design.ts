import { z } from "zod";
import {
  addSearchParams,
  basicAuthorization,
  createOAuth2Provider,
  parseOAuthToken,
  parseProviderPayload,
  postOAuthForm,
  providerJsonRequest,
  splitOAuthScopes,
  tokenExpiration,
  type ProviderExtension,
} from "../provider-extension.js";

const resourceId = z.string().min(1).max(1_000);
const pageSize = z.number().int().min(1).max(100).default(50);

export const canvaProvider = createOAuth2Provider({
  definition: {
    id: "canva",
    label: "Canva",
    description: "读取 Canva 设计、页面与文件夹内容。",
    accent: "#00c4cc",
    documentationUrl: "https://www.canva.dev/docs/connect/authentication/",
    requiresPkce: true,
    requiresSecret: true,
    scopes: ["profile:read", "design:meta:read", "design:content:read", "folder:read"],
    actions: [
      readAction("canva.profile.get", "读取 Canva Profile", "读取当前 Canva 用户资料。", ["profile:read"]),
      readAction("canva.designs.list", "读取 Canva Designs", "分页读取当前用户的设计。", ["design:meta:read"]),
      readAction("canva.designs.get", "读取 Canva Design", "读取指定设计元数据。", ["design:meta:read"]),
      readAction("canva.design_pages.list", "读取 Canva Pages", "读取指定设计的页面摘要。", ["design:content:read"]),
      readAction("canva.folder_items.list", "读取 Canva Folder", "分页读取指定文件夹内容。", ["folder:read"]),
    ],
  },
  authorization: { url: "https://www.canva.com/api/oauth/authorize" },
  token: { clientAuthentication: "basic", sendPkce: true, url: "https://api.canva.com/rest/v1/oauth/token" },
  actionArgumentsSchema(action) {
    if (action === "canva.profile.get") return z.object({}).strict();
    if (action === "canva.designs.list") return canvaListArguments;
    if (action === "canva.designs.get") return canvaDesignGetArguments;
    if (action === "canva.design_pages.list") return canvaDesignGetArguments;
    if (action === "canva.folder_items.list") return canvaFolderItemsArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await canvaRequest(fetch, token.access_token, "/users/me");
    const me = parseProviderPayload(canvaMe, response.body).team_user;
    return { accountId: `${me.team_id}:${me.user_id}`, label: `Canva ${me.user_id}` };
  },
  async revoke({ config, credential, fetch }) {
    await postOAuthForm({ fetch, headers: { authorization: basicAuthorization(config) }, url: "https://api.canva.com/rest/v1/oauth/revoke", values: { token: credential.refreshToken ?? credential.accessToken } });
  },
  executeAction: executeCanvaAction,
});

export const figmaProvider: ProviderExtension = {
  id: "figma",
  definition: {
    id: "figma",
    label: "Figma",
    description: "读取项目、文件节点与评论，并在确认后创建评论。",
    accent: "#a259ff",
    documentationUrl: "https://developers.figma.com/docs/rest-api/oauth-apps/",
    requiresPkce: true,
    requiresSecret: true,
    scopes: ["current_user:read", "projects:read", "file_metadata:read", "file_content:read", "file_comments:read", "file_comments:write"],
    actions: [
      readAction("figma.project_files.list", "读取 Figma Project Files", "读取项目中的文件摘要。", ["projects:read"]),
      readAction("figma.file_metadata.get", "读取 Figma File Metadata", "读取指定文件的元数据。", ["file_metadata:read"]),
      readAction("figma.file_nodes.get", "读取 Figma Nodes", "按必填 node IDs 读取有限节点摘要。", ["file_content:read"]),
      readAction("figma.comments.list", "读取 Figma Comments", "读取指定文件的评论。", ["file_comments:read"]),
      writeAction("figma.comments.create", "创建 Figma Comment", "在确认后向指定文件创建评论。", ["file_comments:write"]),
    ],
  },
  actionArgumentsSchema(action) {
    if (action === "figma.project_files.list") return figmaProjectFilesArguments;
    if (action === "figma.file_metadata.get") return figmaFileGetArguments;
    if (action === "figma.file_nodes.get") return figmaNodesGetArguments;
    if (action === "figma.comments.list") return figmaFileGetArguments;
    if (action === "figma.comments.create") return figmaCommentCreateArguments;
    throw unsupported(action);
  },
  buildAuthorizationUrl(input) {
    return addSearchParams(new URL("https://www.figma.com/oauth"), {
      client_id: input.config.clientId,
      code_challenge: input.codeChallenge,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: figmaProvider.definition.scopes.join(" "),
      state: input.state,
    }).toString();
  },
  async exchangeOAuthCode(input) {
    const token = parseOAuthToken(await postOAuthForm({
      fetch: input.fetch,
      headers: { authorization: basicAuthorization(input.config) },
      url: "https://api.figma.com/v1/oauth/token",
      values: { code: input.code, code_verifier: input.codeVerifier, grant_type: "authorization_code", redirect_uri: input.redirectUri },
    }));
    const response = await figmaRequest(input.fetch, token.access_token, "/me");
    const profile = parseProviderPayload(figmaProfile, response.body);
    return {
      accountId: profile.id,
      credential: { accessToken: token.access_token, refreshToken: token.refresh_token, tokenType: token.token_type },
      expiresAt: tokenExpiration(token.expires_in),
      label: profile.email ?? profile.handle,
      scopes: splitOAuthScopes(token.scope, figmaProvider.definition.scopes),
    };
  },
  async refreshCredential(input) {
    if (!input.credential.refreshToken) throw new Error("The provider did not issue a refresh token.");
    const token = parseOAuthToken(await postOAuthForm({
      fetch: input.fetch,
      headers: { authorization: basicAuthorization(input.config) },
      url: "https://api.figma.com/v1/oauth/refresh",
      values: { refresh_token: input.credential.refreshToken },
    }));
    return {
      credential: { accessToken: token.access_token, refreshToken: token.refresh_token ?? input.credential.refreshToken, tokenType: token.token_type ?? input.credential.tokenType },
      expiresAt: tokenExpiration(token.expires_in),
      scopes: token.scope ? splitOAuthScopes(token.scope, []) : undefined,
    };
  },
  async revokeCredential() {},
  executeAction: executeFigmaAction,
};

export const designProviders: readonly ProviderExtension[] = [canvaProvider, figmaProvider];

const canvaMe = z.object({ team_user: z.object({ team_id: resourceId, user_id: resourceId }) }).passthrough();
const canvaProfileResponse = z.object({ profile: z.object({ display_name: z.string().max(500).optional() }).passthrough() }).passthrough();
const canvaListArguments = z.object({ continuation: z.string().max(4_000).optional(), limit: pageSize }).strict();
const canvaDesignGetArguments = z.object({ designId: resourceId }).strict();
const canvaFolderItemsArguments = z.object({ continuation: z.string().max(4_000).optional(), folderId: resourceId, limit: pageSize }).strict();
const canvaDesign = z.object({
  created_at: z.number().optional(),
  id: resourceId,
  page_count: z.number().optional(),
  thumbnail: z.object({ height: z.number().optional(), url: z.url().optional(), width: z.number().optional() }).optional(),
  title: z.string().max(1_000).optional(),
  updated_at: z.number().optional(),
  urls: z.object({ edit_url: z.url().optional(), view_url: z.url().optional() }).optional(),
}).passthrough();
const canvaPage = z.object({ id: resourceId, index: z.number().optional(), thumbnail: z.object({ height: z.number().optional(), url: z.url().optional(), width: z.number().optional() }).optional() }).passthrough();
const canvaFolderItem = z.object({ design: canvaDesign.optional(), folder: z.object({ id: resourceId, name: z.string().max(1_000).optional() }).optional(), type: z.string().max(100) }).passthrough();
const canvaListResponse = <T extends z.ZodType>(item: T) => z.object({ continuation: z.string().max(4_000).optional(), items: z.array(item).max(1_000) }).passthrough();

async function executeCanvaAction(input: Parameters<ProviderExtension["executeAction"]>[0]) {
  if (input.action === "canva.profile.get") {
    const response = await canvaRequest(input.fetch, input.credential.accessToken, "/users/me/profile");
    const profile = parseProviderPayload(canvaProfileResponse, response.body).profile;
    return { data: { displayName: profile.display_name ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "canva.designs.list") {
    const args = canvaListArguments.parse(input.arguments ?? {});
    const url = addSearchParams(new URL("https://api.canva.com/rest/v1/designs"), { continuation: args.continuation, limit: String(args.limit), ownership: "owned" });
    const response = await canvaRequest(input.fetch, input.credential.accessToken, url);
    const body = parseProviderPayload(canvaListResponse(canvaDesign), response.body);
    return { data: { items: body.items.map(normalizeCanvaDesign), nextContinuation: body.continuation ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "canva.designs.get") {
    const args = canvaDesignGetArguments.parse(input.arguments);
    const response = await canvaRequest(input.fetch, input.credential.accessToken, `/designs/${encodeURIComponent(args.designId)}`);
    const design = parseProviderPayload(z.object({ design: canvaDesign }).passthrough(), response.body).design;
    return { data: normalizeCanvaDesign(design), providerRequestId: response.requestId };
  }
  if (input.action === "canva.design_pages.list") {
    const args = canvaDesignGetArguments.parse(input.arguments);
    const response = await canvaRequest(input.fetch, input.credential.accessToken, `/designs/${encodeURIComponent(args.designId)}/pages`);
    const body = parseProviderPayload(canvaListResponse(canvaPage), response.body);
    return { data: { items: body.items.map((page) => ({ id: page.id, index: page.index ?? null, thumbnail: page.thumbnail ?? null })) }, providerRequestId: response.requestId };
  }
  if (input.action === "canva.folder_items.list") {
    const args = canvaFolderItemsArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`https://api.canva.com/rest/v1/folders/${encodeURIComponent(args.folderId)}/items`), { continuation: args.continuation, item_types: "design,folder", limit: String(args.limit) });
    const response = await canvaRequest(input.fetch, input.credential.accessToken, url);
    const body = parseProviderPayload(canvaListResponse(canvaFolderItem), response.body);
    return { data: { items: body.items.map((item) => ({ design: item.design ? normalizeCanvaDesign(item.design) : null, folder: item.folder ?? null, type: item.type })), nextContinuation: body.continuation ?? null }, providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function canvaRequest(fetch: Parameters<typeof providerJsonRequest>[0]["fetch"], token: string, path: string | URL) {
  const url = path instanceof URL ? path : `https://api.canva.com/rest/v1${path}`;
  return providerJsonRequest({ accessToken: token, fetch, url });
}

function normalizeCanvaDesign(design: z.infer<typeof canvaDesign>) {
  return { createdAt: unixTime(design.created_at), editUrl: design.urls?.edit_url ?? null, id: design.id, pageCount: design.page_count ?? null, thumbnail: design.thumbnail ?? null, title: design.title ?? "(Untitled design)", updatedAt: unixTime(design.updated_at), viewUrl: design.urls?.view_url ?? null };
}

function unixTime(value?: number): string | null {
  return value === undefined ? null : new Date(value * 1_000).toISOString();
}

const figmaProfile = z.object({ email: z.string().max(500).optional(), handle: z.string().max(500), id: resourceId }).passthrough();
const figmaProjectFilesArguments = z.object({ projectId: resourceId }).strict();
const figmaFileGetArguments = z.object({ fileKey: resourceId }).strict();
const figmaNodesGetArguments = z.object({ depth: z.number().int().min(1).max(4).default(2), fileKey: resourceId, nodeIds: z.array(resourceId).min(1).max(50) }).strict();
const figmaCommentCreateArguments = z.object({ fileKey: resourceId, message: z.string().min(1).max(5_000) }).strict();
const figmaProjectFile = z.object({ key: resourceId, last_modified: z.string().max(100).optional(), name: z.string().max(1_000), thumbnail_url: z.url().optional() }).passthrough();
const figmaFileMetadata = z.object({ creator: z.object({ handle: z.string().max(500).optional(), id: resourceId.optional() }).optional(), editor_type: z.string().max(100).optional(), key: resourceId.optional(), last_touched_at: z.string().max(100).optional(), name: z.string().max(1_000), thumbnail_url: z.url().optional(), version: z.string().max(500).optional() }).passthrough();
const figmaNode = z.object({ document: z.object({ id: resourceId, name: z.string().max(1_000).optional(), type: z.string().max(100), visible: z.boolean().optional() }).passthrough().optional() }).passthrough();
const figmaComment = z.object({
  created_at: z.string().max(100).optional(),
  file_key: resourceId.optional(),
  id: z.union([z.string(), z.number()]),
  message: z.string().max(20_000),
  parent_id: z.union([z.string(), z.number()]).nullable().optional(),
  resolved_at: z.string().max(100).nullable().optional(),
  user: z.object({ handle: z.string().max(500).optional(), id: resourceId.optional() }).optional(),
}).passthrough();

async function executeFigmaAction(input: Parameters<ProviderExtension["executeAction"]>[0]) {
  if (input.action === "figma.project_files.list") {
    const args = figmaProjectFilesArguments.parse(input.arguments);
    const response = await figmaRequest(input.fetch, input.credential.accessToken, `/projects/${encodeURIComponent(args.projectId)}/files`);
    const body = parseProviderPayload(z.object({ files: z.array(figmaProjectFile).max(1_000), name: z.string().max(1_000).optional() }).passthrough(), response.body);
    return { data: { items: body.files.map((file) => ({ fileKey: file.key, lastModifiedAt: file.last_modified ?? null, name: file.name, thumbnailUrl: file.thumbnail_url ?? null })), projectName: body.name ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "figma.file_metadata.get") {
    const args = figmaFileGetArguments.parse(input.arguments);
    const response = await figmaRequest(input.fetch, input.credential.accessToken, `/files/${encodeURIComponent(args.fileKey)}/meta`);
    const body = parseProviderPayload(figmaFileMetadata, response.body);
    return { data: { creator: body.creator ?? null, editorType: body.editor_type ?? null, fileKey: body.key ?? args.fileKey, lastTouchedAt: body.last_touched_at ?? null, name: body.name, thumbnailUrl: body.thumbnail_url ?? null, version: body.version ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "figma.file_nodes.get") {
    const args = figmaNodesGetArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`https://api.figma.com/v1/files/${encodeURIComponent(args.fileKey)}/nodes`), { depth: String(args.depth), ids: args.nodeIds.join(",") });
    const response = await figmaRequest(input.fetch, input.credential.accessToken, url);
    const body = parseProviderPayload(z.object({ name: z.string().max(1_000).optional(), nodes: z.record(z.string(), figmaNode.nullable()) }).passthrough(), response.body);
    return { data: { fileName: body.name ?? null, nodes: Object.fromEntries(Object.entries(body.nodes).slice(0, 50).map(([id, node]) => [id, node?.document ? { id: node.document.id, name: node.document.name ?? null, type: node.document.type, visible: node.document.visible ?? true } : null])) }, providerRequestId: response.requestId };
  }
  if (input.action === "figma.comments.list") {
    const args = figmaFileGetArguments.parse(input.arguments);
    const response = await figmaRequest(input.fetch, input.credential.accessToken, `/files/${encodeURIComponent(args.fileKey)}/comments`);
    const body = parseProviderPayload(z.object({ comments: z.array(figmaComment).max(2_000) }).passthrough(), response.body);
    return { data: { items: body.comments.slice(0, 500).map(normalizeFigmaComment) }, providerRequestId: response.requestId };
  }
  if (input.action === "figma.comments.create") {
    const args = figmaCommentCreateArguments.parse(input.arguments);
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, init: { body: JSON.stringify({ message: args.message }), headers: { "content-type": "application/json" }, method: "POST" }, url: `https://api.figma.com/v1/files/${encodeURIComponent(args.fileKey)}/comments` });
    return { data: normalizeFigmaComment(parseProviderPayload(figmaComment, response.body)), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function figmaRequest(fetch: Parameters<typeof providerJsonRequest>[0]["fetch"], token: string, path: string | URL) {
  const url = path instanceof URL ? path : `https://api.figma.com/v1${path}`;
  return providerJsonRequest({ accessToken: token, fetch, url });
}

function normalizeFigmaComment(comment: z.infer<typeof figmaComment>) {
  return { author: comment.user ? { handle: comment.user.handle ?? null, id: comment.user.id ?? null } : null, createdAt: comment.created_at ?? null, fileKey: comment.file_key ?? null, id: String(comment.id), message: comment.message.slice(0, 20_000), parentId: comment.parent_id === undefined || comment.parent_id === null ? null : String(comment.parent_id), resolvedAt: comment.resolved_at ?? null };
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
