import { z } from "zod";
import {
  addSearchParams,
  basicAuthorization,
  createOAuth2Provider,
  parseProviderPayload,
  postOAuthForm,
  providerJsonRequest,
  requiredClientSecret,
  type ProviderExtension,
  type ProviderFetch,
  type ToolExecutionResult,
} from "../provider-extension.js";
import { ProviderRequestError } from "../provider-errors.js";

const resourceId = z.string().min(1).max(500);
const shortText = z.string().min(1).max(500);
const longText = z.string().max(20_000);
const isoDateTime = z.iso.datetime({ offset: true });
const pageSize = z.number().int().min(1).max(100).default(50);
const emptyArguments = z.object({}).strict();

export const zoomProvider = createOAuth2Provider({
  definition: {
    id: "zoom",
    label: "Zoom",
    description: "读取会议，并在明确确认后创建 Zoom 会议。",
    accent: "#2d8cff",
    documentationUrl: "https://developers.zoom.us/docs/integrations/oauth/",
    requiresPkce: false,
    requiresSecret: true,
    scopes: [
      "user:read:user",
      "meeting:read:list_meetings",
      "meeting:read:meeting",
      "meeting:write:meeting",
    ],
    actions: [
      readAction("zoom.meetings.list", "读取 Zoom 会议", "读取当前用户的会议列表。", ["meeting:read:list_meetings"]),
      readAction("zoom.meetings.get", "读取 Zoom 会议详情", "读取指定会议的受控详情。", ["meeting:read:meeting"]),
      writeAction("zoom.meetings.create", "创建 Zoom 会议", "在确认后创建预定会议。", ["meeting:write:meeting"]),
    ],
  },
  authorization: { url: "https://zoom.us/oauth/authorize" },
  token: {
    clientAuthentication: "basic",
    url: "https://zoom.us/oauth/token",
  },
  actionArgumentsSchema(action) {
    if (action === "zoom.meetings.list") return zoomMeetingsListArguments;
    if (action === "zoom.meetings.get") return zoomMeetingGetArguments;
    if (action === "zoom.meetings.create") return zoomMeetingCreateArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await providerJsonRequest({
      accessToken: token.access_token,
      fetch,
      url: "https://api.zoom.us/v2/users/me",
    });
    const profile = parseProviderPayload(zoomProfile, response.body);
    return {
      accountId: profile.id,
      label: profile.email ?? profile.display_name ?? `Zoom ${profile.id}`,
    };
  },
  async revoke({ config, credential, fetch }) {
    await postOAuthForm({
      fetch,
      headers: { authorization: basicAuthorization(config) },
      url: "https://zoom.us/oauth/revoke",
      values: { token: credential.accessToken },
    });
  },
  executeAction: executeZoomAction,
});

export const asanaProvider = createOAuth2Provider({
  definition: {
    id: "asana",
    label: "Asana",
    description: "读取 Workspace 与任务，并在确认后创建 Asana 任务。",
    accent: "#f06a6a",
    documentationUrl: "https://developers.asana.com/docs/oauth",
    requiresPkce: false,
    requiresSecret: true,
    scopes: ["default"],
    actions: [
      readAction("asana.workspaces.list", "读取 Asana Workspace", "读取当前用户可访问的 Workspace。", ["default"]),
      readAction("asana.tasks.list", "读取 Asana 任务", "读取指定 Workspace 中分配给当前用户的任务。", ["default"]),
      readAction("asana.tasks.get", "读取 Asana 任务详情", "读取指定任务的受控详情。", ["default"]),
      writeAction("asana.tasks.create", "创建 Asana 任务", "在确认后向 Workspace 或项目创建任务。", ["default"]),
    ],
  },
  authorization: { url: "https://app.asana.com/-/oauth_authorize" },
  token: {
    clientAuthentication: "body",
    url: "https://app.asana.com/-/oauth_token",
  },
  actionArgumentsSchema(action) {
    if (action === "asana.workspaces.list") return boundedListArguments;
    if (action === "asana.tasks.list") return asanaTasksListArguments;
    if (action === "asana.tasks.get") return asanaTaskGetArguments;
    if (action === "asana.tasks.create") return asanaTaskCreateArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await providerJsonRequest({
      accessToken: token.access_token,
      fetch,
      url: "https://app.asana.com/api/1.0/users/me?opt_fields=gid,name,email",
    });
    const profile = parseProviderPayload(asanaProfile, response.body).data;
    return {
      accountId: profile.gid,
      label: profile.email ?? profile.name,
    };
  },
  async revoke({ config, credential, fetch }) {
    await postOAuthForm({
      fetch,
      url: "https://app.asana.com/-/oauth_revoke",
      values: {
        client_id: config.clientId,
        client_secret: requiredClientSecret(config),
        token: credential.refreshToken ?? credential.accessToken,
      },
    });
  },
  executeAction: executeAsanaAction,
});

export const airtableProvider = createOAuth2Provider({
  definition: {
    id: "airtable",
    label: "Airtable",
    description: "读取 Base、Table 与记录，并在确认后创建 Airtable 记录。",
    accent: "#18bfff",
    documentationUrl: "https://airtable.com/developers/web/api/oauth-reference",
    requiresPkce: true,
    requiresSecret: true,
    scopes: [
      "data.records:read",
      "data.records:write",
      "schema.bases:read",
      "user.email:read",
    ],
    actions: [
      readAction("airtable.bases.list", "读取 Airtable Bases", "读取当前账号可访问的 Bases。", ["schema.bases:read"]),
      readAction("airtable.tables.list", "读取 Airtable Tables", "读取指定 Base 的 Table schema。", ["schema.bases:read"]),
      readAction("airtable.records.list", "读取 Airtable Records", "读取指定 Table 的有限记录。", ["data.records:read"]),
      writeAction("airtable.records.create", "创建 Airtable Record", "在确认后创建一条记录。", ["data.records:write"]),
    ],
  },
  authorization: { url: "https://airtable.com/oauth2/v1/authorize" },
  token: {
    clientAuthentication: "basic",
    sendPkce: true,
    url: "https://airtable.com/oauth2/v1/token",
  },
  actionArgumentsSchema(action) {
    if (action === "airtable.bases.list") return airtableBasesListArguments;
    if (action === "airtable.tables.list") return airtableTablesListArguments;
    if (action === "airtable.records.list") return airtableRecordsListArguments;
    if (action === "airtable.records.create") return airtableRecordCreateArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const response = await providerJsonRequest({
      accessToken: token.access_token,
      fetch,
      url: "https://api.airtable.com/v0/meta/whoami",
    });
    const profile = parseProviderPayload(airtableProfile, response.body);
    return {
      accountId: profile.id,
      label: profile.email ?? `Airtable ${profile.id}`,
      scopes: profile.scopes,
    };
  },
  async revoke({ config, credential, fetch }) {
    await postOAuthForm({
      fetch,
      headers: { authorization: basicAuthorization(config) },
      url: "https://airtable.com/oauth2/v1/revoke",
      values: { token: credential.refreshToken ?? credential.accessToken },
    });
  },
  executeAction: executeAirtableAction,
});

export const linearProvider = createOAuth2Provider({
  definition: {
    id: "linear",
    label: "Linear",
    description: "读取 Team 与 Issue，并在确认后创建 Linear Issue。",
    accent: "#5e6ad2",
    documentationUrl: "https://linear.app/developers/oauth-2-0-authentication",
    requiresPkce: false,
    requiresSecret: true,
    scopes: ["read", "write"],
    actions: [
      readAction("linear.teams.list", "读取 Linear Teams", "读取当前 Workspace 的 Teams。", ["read"]),
      readAction("linear.issues.list", "读取 Linear Issues", "读取最近更新的 Issues。", ["read"]),
      readAction("linear.issues.get", "读取 Linear Issue", "读取指定 Issue 的受控详情。", ["read"]),
      writeAction("linear.issues.create", "创建 Linear Issue", "在确认后创建 Issue。", ["write"]),
    ],
  },
  authorization: {
    url: "https://linear.app/oauth/authorize",
    scopeSeparator: ",",
    extra: { access: "offline", prompt: "consent" },
  },
  token: {
    clientAuthentication: "body",
    url: "https://api.linear.app/oauth/token",
  },
  actionArgumentsSchema(action) {
    if (action === "linear.teams.list") return linearListArguments;
    if (action === "linear.issues.list") return linearIssuesListArguments;
    if (action === "linear.issues.get") return linearIssueGetArguments;
    if (action === "linear.issues.create") return linearIssueCreateArguments;
    throw unsupported(action);
  },
  async profile({ fetch, token }) {
    const data = await linearGraphql(
      fetch,
      token.access_token,
      "query OneStatusViewer { viewer { id name email } }",
      {},
    );
    const viewer = parseProviderPayload(linearViewerResponse, data).viewer;
    return { accountId: viewer.id, label: viewer.email ?? viewer.name };
  },
  async revoke({ credential, fetch }) {
    await postOAuthForm({
      fetch,
      url: "https://api.linear.app/oauth/revoke",
      values: { token: credential.refreshToken ?? credential.accessToken },
    });
  },
  executeAction: executeLinearAction,
});

export const workManagementProviders: readonly ProviderExtension[] = [
  zoomProvider,
  asanaProvider,
  airtableProvider,
  linearProvider,
];

const zoomProfile = z.object({
  display_name: z.string().max(500).optional(),
  email: z.string().max(500).optional(),
  id: resourceId,
}).passthrough();
const zoomMeetingsListArguments = z.object({
  nextPageToken: z.string().max(2_000).optional(),
  pageSize,
  type: z.enum(["scheduled", "live", "upcoming", "upcoming_meetings", "previous_meetings"]).default("scheduled"),
}).strict();
const zoomMeetingGetArguments = z.object({ meetingId: resourceId }).strict();
const zoomMeetingCreateArguments = z.object({
  agenda: z.string().max(2_000).optional(),
  durationMinutes: z.number().int().min(1).max(1_440).default(30),
  startTime: isoDateTime,
  timezone: z.string().min(1).max(100).optional(),
  topic: shortText,
}).strict();
const zoomMeeting = z.object({
  agenda: z.string().max(10_000).optional(),
  created_at: z.string().max(100).optional(),
  duration: z.number().optional(),
  id: z.union([z.string(), z.number()]),
  join_url: z.url().optional(),
  start_time: z.string().max(100).optional(),
  status: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  topic: z.string().max(500).optional(),
  type: z.number().optional(),
  uuid: z.string().max(500).optional(),
}).passthrough();
const zoomMeetingsResponse = z.object({
  meetings: z.array(zoomMeeting).max(1_000).default([]),
  next_page_token: z.string().max(2_000).optional(),
  page_count: z.number().optional(),
  page_size: z.number().optional(),
  total_records: z.number().optional(),
}).passthrough();

async function executeZoomAction(input: Parameters<ProviderExtension["executeAction"]>[0]): Promise<ToolExecutionResult> {
  if (input.action === "zoom.meetings.list") {
    const args = zoomMeetingsListArguments.parse(input.arguments ?? {});
    const url = addSearchParams(new URL("https://api.zoom.us/v2/users/me/meetings"), {
      next_page_token: args.nextPageToken,
      page_size: String(args.pageSize),
      type: args.type,
    });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(zoomMeetingsResponse, response.body);
    return { data: { items: body.meetings.map(normalizeZoomMeeting), nextPageToken: body.next_page_token ?? null, totalRecords: body.total_records ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "zoom.meetings.get") {
    const args = zoomMeetingGetArguments.parse(input.arguments);
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url: `https://api.zoom.us/v2/meetings/${encodeURIComponent(args.meetingId)}` });
    return { data: normalizeZoomMeeting(parseProviderPayload(zoomMeeting, response.body)), providerRequestId: response.requestId };
  }
  if (input.action === "zoom.meetings.create") {
    const args = zoomMeetingCreateArguments.parse(input.arguments);
    const response = await jsonRequest(input.fetch, input.credential.accessToken, "https://api.zoom.us/v2/users/me/meetings", "POST", {
      agenda: args.agenda,
      duration: args.durationMinutes,
      start_time: args.startTime,
      timezone: args.timezone,
      topic: args.topic,
      type: 2,
    });
    return { data: normalizeZoomMeeting(parseProviderPayload(zoomMeeting, response.body)), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function normalizeZoomMeeting(meeting: z.infer<typeof zoomMeeting>) {
  return {
    agenda: meeting.agenda ?? null,
    createdAt: meeting.created_at ?? null,
    durationMinutes: meeting.duration ?? null,
    id: String(meeting.id),
    joinUrl: meeting.join_url ?? null,
    startTime: meeting.start_time ?? null,
    status: meeting.status ?? null,
    timezone: meeting.timezone ?? null,
    topic: meeting.topic ?? "(Untitled meeting)",
    type: meeting.type ?? null,
    uuid: meeting.uuid ?? null,
  };
}

const boundedListArguments = z.object({ limit: pageSize, offset: z.string().max(2_000).optional() }).strict();
const asanaProfile = z.object({ data: z.object({ email: z.string().max(500).optional(), gid: resourceId, name: shortText }) }).passthrough();
const asanaTasksListArguments = z.object({
  completedSince: z.string().max(100).default("now"),
  limit: pageSize,
  offset: z.string().max(2_000).optional(),
  workspaceId: resourceId,
}).strict();
const asanaTaskGetArguments = z.object({ taskId: resourceId }).strict();
const asanaTaskCreateArguments = z.object({
  dueOn: z.iso.date().optional(),
  name: shortText,
  notes: longText.optional(),
  projectIds: z.array(resourceId).max(20).default([]),
  workspaceId: resourceId,
}).strict();
const asanaWorkspace = z.object({ gid: resourceId, name: shortText, resource_type: z.string().max(100).optional() }).passthrough();
const asanaTask = z.object({
  assignee: z.object({ gid: resourceId, name: shortText }).nullable().optional(),
  completed: z.boolean().optional(),
  completed_at: z.string().nullable().optional(),
  due_on: z.string().nullable().optional(),
  gid: resourceId,
  name: z.string().max(1_000),
  notes: z.string().max(20_000).optional(),
  permalink_url: z.url().optional(),
  projects: z.array(z.object({ gid: resourceId, name: shortText })).max(100).optional(),
}).passthrough();
const asanaListResponse = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item).max(1_000), next_page: z.object({ offset: z.string().max(2_000).optional() }).nullable().optional() }).passthrough();
const asanaItemResponse = <T extends z.ZodType>(item: T) => z.object({ data: item }).passthrough();

async function executeAsanaAction(input: Parameters<ProviderExtension["executeAction"]>[0]): Promise<ToolExecutionResult> {
  if (input.action === "asana.workspaces.list") {
    const args = boundedListArguments.parse(input.arguments ?? {});
    const url = addSearchParams(new URL("https://app.asana.com/api/1.0/workspaces"), { limit: String(args.limit), offset: args.offset });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(asanaListResponse(asanaWorkspace), response.body);
    return { data: { items: body.data.map((entry) => ({ id: entry.gid, name: entry.name })), nextOffset: body.next_page?.offset ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "asana.tasks.list") {
    const args = asanaTasksListArguments.parse(input.arguments);
    const url = addSearchParams(new URL("https://app.asana.com/api/1.0/tasks"), {
      assignee: "me", completed_since: args.completedSince, limit: String(args.limit), offset: args.offset,
      opt_fields: "gid,name,completed,completed_at,due_on,permalink_url,assignee.gid,assignee.name,projects.gid,projects.name",
      workspace: args.workspaceId,
    });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(asanaListResponse(asanaTask), response.body);
    return { data: { items: body.data.map(normalizeAsanaTask), nextOffset: body.next_page?.offset ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "asana.tasks.get") {
    const args = asanaTaskGetArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`https://app.asana.com/api/1.0/tasks/${encodeURIComponent(args.taskId)}`), { opt_fields: "gid,name,notes,completed,completed_at,due_on,permalink_url,assignee.gid,assignee.name,projects.gid,projects.name" });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(asanaItemResponse(asanaTask), response.body);
    return { data: normalizeAsanaTask(body.data), providerRequestId: response.requestId };
  }
  if (input.action === "asana.tasks.create") {
    const args = asanaTaskCreateArguments.parse(input.arguments);
    const response = await jsonRequest(input.fetch, input.credential.accessToken, "https://app.asana.com/api/1.0/tasks", "POST", { data: { due_on: args.dueOn, name: args.name, notes: args.notes, projects: args.projectIds, workspace: args.workspaceId } });
    const body = parseProviderPayload(asanaItemResponse(asanaTask), response.body);
    return { data: normalizeAsanaTask(body.data), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

function normalizeAsanaTask(task: z.infer<typeof asanaTask>) {
  return {
    assignee: task.assignee ? { id: task.assignee.gid, name: task.assignee.name } : null,
    completed: task.completed ?? false,
    completedAt: task.completed_at ?? null,
    dueOn: task.due_on ?? null,
    id: task.gid,
    name: task.name,
    notes: task.notes ?? null,
    permalinkUrl: task.permalink_url ?? null,
    projects: (task.projects ?? []).map((project) => ({ id: project.gid, name: project.name })),
  };
}

const airtableProfile = z.object({ email: z.string().max(500).optional(), id: resourceId, scopes: z.array(z.string().max(500)).max(200).optional() }).passthrough();
const airtableBasesListArguments = z.object({ offset: z.string().max(2_000).optional() }).strict();
const airtableTablesListArguments = z.object({ baseId: resourceId }).strict();
const airtableRecordsListArguments = z.object({ baseId: resourceId, fields: z.array(shortText).max(50).default([]), maxRecords: z.number().int().min(1).max(100).default(50), offset: z.string().max(2_000).optional(), tableId: resourceId, view: z.string().max(500).optional() }).strict();
const airtableRecordCreateArguments = z.object({ baseId: resourceId, fields: z.record(z.string().min(1).max(500), z.json()), tableId: resourceId, typecast: z.boolean().default(false) }).strict();
const airtableBase = z.object({ id: resourceId, name: shortText, permissionLevel: z.string().max(100).optional() }).passthrough();
const airtableTable = z.object({ description: z.string().max(10_000).optional(), fields: z.array(z.object({ description: z.string().max(10_000).optional(), id: resourceId, name: shortText, type: z.string().max(100) }).passthrough()).max(1_000), id: resourceId, name: shortText, primaryFieldId: resourceId }).passthrough();
const airtableRecord = z.object({ createdTime: z.string().max(100), fields: z.record(z.string(), z.json()), id: resourceId }).passthrough();
const airtableBasesResponse = z.object({ bases: z.array(airtableBase).max(1_000), offset: z.string().max(2_000).optional() }).passthrough();
const airtableTablesResponse = z.object({ tables: z.array(airtableTable).max(1_000) }).passthrough();
const airtableRecordsResponse = z.object({ offset: z.string().max(2_000).optional(), records: z.array(airtableRecord).max(1_000) }).passthrough();

async function executeAirtableAction(input: Parameters<ProviderExtension["executeAction"]>[0]): Promise<ToolExecutionResult> {
  if (input.action === "airtable.bases.list") {
    const args = airtableBasesListArguments.parse(input.arguments ?? {});
    const url = addSearchParams(new URL("https://api.airtable.com/v0/meta/bases"), { offset: args.offset });
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(airtableBasesResponse, response.body);
    return { data: { items: body.bases.map((base) => ({ id: base.id, name: base.name, permissionLevel: base.permissionLevel ?? null })), nextOffset: body.offset ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "airtable.tables.list") {
    const args = airtableTablesListArguments.parse(input.arguments);
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url: `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(args.baseId)}/tables` });
    const body = parseProviderPayload(airtableTablesResponse, response.body);
    return { data: { items: body.tables.map((table) => ({ description: table.description ?? null, fields: table.fields.map((field) => ({ description: field.description ?? null, id: field.id, name: field.name, type: field.type })), id: table.id, name: table.name, primaryFieldId: table.primaryFieldId })) }, providerRequestId: response.requestId };
  }
  if (input.action === "airtable.records.list") {
    const args = airtableRecordsListArguments.parse(input.arguments);
    const url = addSearchParams(new URL(`https://api.airtable.com/v0/${encodeURIComponent(args.baseId)}/${encodeURIComponent(args.tableId)}`), { maxRecords: String(args.maxRecords), offset: args.offset, pageSize: String(Math.min(args.maxRecords, 100)), view: args.view });
    args.fields.forEach((field) => url.searchParams.append("fields[]", field));
    const response = await providerJsonRequest({ accessToken: input.credential.accessToken, fetch: input.fetch, url });
    const body = parseProviderPayload(airtableRecordsResponse, response.body);
    return { data: { items: body.records, nextOffset: body.offset ?? null }, providerRequestId: response.requestId };
  }
  if (input.action === "airtable.records.create") {
    const args = airtableRecordCreateArguments.parse(input.arguments);
    const response = await jsonRequest(input.fetch, input.credential.accessToken, `https://api.airtable.com/v0/${encodeURIComponent(args.baseId)}/${encodeURIComponent(args.tableId)}`, "POST", { fields: args.fields, typecast: args.typecast });
    return { data: parseProviderPayload(airtableRecord, response.body), providerRequestId: response.requestId };
  }
  throw unsupported(input.action);
}

const linearListArguments = z.object({
  after: z.string().min(1).max(2_000).optional(),
  first: z.number().int().min(1).max(100).default(50),
}).strict();
const linearIssuesListArguments = z.object({
  after: z.string().min(1).max(2_000).optional(),
  first: z.number().int().min(1).max(100).default(50),
  teamId: resourceId.optional(),
}).strict();
const linearIssueGetArguments = z.object({ issueId: resourceId }).strict();
const linearIssueCreateArguments = z.object({ description: longText.optional(), priority: z.number().int().min(0).max(4).optional(), teamId: resourceId, title: shortText }).strict();
const linearUser = z.object({ email: z.string().max(500).optional(), id: resourceId, name: shortText });
const linearViewerResponse = z.object({ viewer: linearUser });
const linearTeam = z.object({ id: resourceId, key: z.string().max(100), name: shortText });
const linearIssue = z.object({
  assignee: linearUser.nullable().optional(),
  createdAt: z.string().max(100).optional(),
  description: z.string().max(20_000).nullable().optional(),
  id: resourceId,
  identifier: z.string().max(100),
  priority: z.number().optional(),
  state: z.object({ id: resourceId, name: shortText, type: z.string().max(100).optional() }).nullable().optional(),
  team: linearTeam.optional(),
  title: z.string().max(1_000),
  updatedAt: z.string().max(100).optional(),
  url: z.url().optional(),
});
const pageInfo = z.object({ endCursor: z.string().max(2_000).nullable().optional(), hasNextPage: z.boolean() });

async function executeLinearAction(input: Parameters<ProviderExtension["executeAction"]>[0]): Promise<ToolExecutionResult> {
  if (input.action === "linear.teams.list") {
    const args = linearListArguments.parse(input.arguments ?? {});
    const data = await linearGraphql(input.fetch, input.credential.accessToken, "query OneStatusTeams($after: String, $first: Int!) { teams(after: $after, first: $first) { nodes { id key name } pageInfo { endCursor hasNextPage } } }", { after: args.after, first: args.first });
    const body = parseProviderPayload(z.object({ teams: z.object({ nodes: z.array(linearTeam).max(100), pageInfo }) }), data);
    return { data: { items: body.teams.nodes, pageInfo: body.teams.pageInfo } };
  }
  if (input.action === "linear.issues.list") {
    const args = linearIssuesListArguments.parse(input.arguments ?? {});
    const data = await linearGraphql(input.fetch, input.credential.accessToken, "query OneStatusIssues($after: String, $filter: IssueFilter, $first: Int!) { issues(after: $after, filter: $filter, first: $first, orderBy: updatedAt) { nodes { id identifier title description priority url createdAt updatedAt team { id key name } state { id name type } assignee { id name email } } pageInfo { endCursor hasNextPage } } }", { after: args.after, filter: args.teamId ? { team: { id: { eq: args.teamId } } } : undefined, first: args.first });
    const body = parseProviderPayload(z.object({ issues: z.object({ nodes: z.array(linearIssue).max(100), pageInfo }) }), data);
    return { data: { items: body.issues.nodes.map(normalizeLinearIssue), pageInfo: body.issues.pageInfo } };
  }
  if (input.action === "linear.issues.get") {
    const args = linearIssueGetArguments.parse(input.arguments);
    const data = await linearGraphql(input.fetch, input.credential.accessToken, "query OneStatusIssue($id: String!) { issue(id: $id) { id identifier title description priority url createdAt updatedAt team { id key name } state { id name type } assignee { id name email } } }", { id: args.issueId });
    const body = parseProviderPayload(z.object({ issue: linearIssue.nullable() }), data);
    if (!body.issue) throw new ProviderRequestError("Linear issue was not found.", "not_found", 404);
    return { data: normalizeLinearIssue(body.issue) };
  }
  if (input.action === "linear.issues.create") {
    const args = linearIssueCreateArguments.parse(input.arguments);
    const data = await linearGraphql(input.fetch, input.credential.accessToken, "mutation OneStatusIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title description priority url createdAt updatedAt team { id key name } state { id name type } assignee { id name email } } } }", { input: { description: args.description, priority: args.priority, teamId: args.teamId, title: args.title } });
    const body = parseProviderPayload(z.object({ issueCreate: z.object({ issue: linearIssue.nullable(), success: z.boolean() }) }), data);
    if (!body.issueCreate.success || !body.issueCreate.issue) throw new ProviderRequestError("Linear did not create the issue.", "provider_write_failed");
    return { data: normalizeLinearIssue(body.issueCreate.issue) };
  }
  throw unsupported(input.action);
}

function normalizeLinearIssue(issue: z.infer<typeof linearIssue>) {
  return {
    assignee: issue.assignee ?? null,
    createdAt: issue.createdAt ?? null,
    description: issue.description ?? null,
    id: issue.id,
    identifier: issue.identifier,
    priority: issue.priority ?? null,
    state: issue.state ?? null,
    team: issue.team ?? null,
    title: issue.title,
    updatedAt: issue.updatedAt ?? null,
    url: issue.url ?? null,
  };
}

async function linearGraphql(fetch: ProviderFetch | undefined, accessToken: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await jsonRequest(fetch, accessToken, "https://api.linear.app/graphql", "POST", { query, variables });
  const envelope = parseProviderPayload(z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string().max(2_000) }).passthrough()).max(20).optional() }).passthrough(), response.body);
  if (envelope.errors?.length || envelope.data === undefined) {
    throw new ProviderRequestError("Linear GraphQL request failed.", "graphql_request_failed");
  }
  return envelope.data;
}

async function jsonRequest(fetch: ProviderFetch | undefined, accessToken: string, url: string, method: "POST", body: unknown) {
  return providerJsonRequest({
    accessToken,
    fetch,
    init: { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method },
    url,
  });
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
