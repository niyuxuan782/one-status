import { computeCapabilityPackDigest } from "./document.js";
import { githubWorkflowCapabilityPack } from "./fixtures/github-workflow.js";
import {
  capabilityPackManifestSchema,
  type CapabilityPackManifest,
} from "./manifest.js";

const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
const GMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DRIVE_READ_SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly";
const DOCS_READ_SCOPE =
  "https://www.googleapis.com/auth/documents.readonly";
const defaultAdapters = [
  "chatgpt-plugin",
  "remote-mcp",
  "local-mcp",
  "claude-skill",
  "codex-plugin",
  "cursor-rules",
  "one-status-sdk",
  "markdown",
] as const;

export const googleWorkspaceCapabilityPack = capabilityPackManifestSchema.parse({
  format: "one-status.capability-pack",
  schemaVersion: 1,
  name: "google-workspace",
  version: "1.0.0",
  displayName: "Google Workspace",
  description:
    "Use Calendar, Gmail, Drive, and Docs through the One Status Permission Gateway.",
  instructions: [
    {
      id: "calendar-assistant",
      description: "Read calendars, events, details, and busy windows.",
      source: "instructions/calendar-assistant.md",
      tools: [
        "calendar.calendars.list",
        "calendar.events.list",
        "calendar.events.get",
        "calendar.freebusy.query",
      ],
      memoryScopes: ["user.preferences", "project.context"],
    },
    {
      id: "mail-assistant",
      description: "Read Gmail metadata and send mail only after confirmation.",
      source: "instructions/mail-assistant.md",
      tools: [
        "gmail.messages.list",
        "gmail.messages.get",
        "gmail.messages.send",
      ],
      memoryScopes: ["user.preferences", "project.context"],
    },
    {
      id: "workspace-files",
      description: "Find Drive files and read Google Docs content.",
      source: "instructions/workspace-files.md",
      tools: ["drive.files.list", "drive.files.get", "docs.documents.get"],
      memoryScopes: ["project.context"],
    },
  ],
  tools: [
    readTool("calendar.calendars.list", "List accessible calendars.", [GOOGLE_CALENDAR_SCOPE]),
    readTool("calendar.events.list", "List events in a time range.", [GOOGLE_CALENDAR_SCOPE]),
    readTool("calendar.events.get", "Read one calendar event.", [GOOGLE_CALENDAR_SCOPE]),
    readTool("calendar.freebusy.query", "Read busy windows for calendars.", [GOOGLE_CALENDAR_SCOPE]),
    readTool("gmail.messages.list", "List Gmail message references.", [GMAIL_READ_SCOPE]),
    readTool("gmail.messages.get", "Read Gmail message metadata.", [GMAIL_READ_SCOPE]),
    writeTool("gmail.messages.send", "Send a plain-text Gmail message after confirmation.", [GMAIL_SEND_SCOPE]),
    readTool("drive.files.list", "List Google Drive file metadata.", [DRIVE_READ_SCOPE]),
    readTool("drive.files.get", "Read Google Drive file metadata.", [DRIVE_READ_SCOPE]),
    readTool("docs.documents.get", "Read bounded Google Docs text.", [DOCS_READ_SCOPE]),
  ],
  memory: { scopes: ["user.preferences", "project.context"] },
  authorization: {
    provider: "google",
    requiredScopes: [
      GOOGLE_CALENDAR_SCOPE,
      GMAIL_READ_SCOPE,
      GMAIL_SEND_SCOPE,
      DRIVE_READ_SCOPE,
      DOCS_READ_SCOPE,
    ],
  },
  adapters: defaultAdapters,
  ui: {
    settings: [],
    actions: [
      {
        id: "send-email",
        label: "Send email",
        tool: "gmail.messages.send",
      },
    ],
  },
});

export const slackWorkspaceCapabilityPack = capabilityPackManifestSchema.parse({
  format: "one-status.capability-pack",
  schemaVersion: 1,
  name: "slack-workspace",
  version: "1.0.0",
  displayName: "Slack Workspace",
  description:
    "Read channels and messages through One Status, with confirmed message sending.",
  instructions: [
    {
      id: "workspace-messages",
      description: "Read channels, message history, and search results.",
      source: "instructions/workspace-messages.md",
      tools: [
        "slack.channels.list",
        "slack.conversations.history",
        "slack.search.messages",
      ],
      memoryScopes: ["user.preferences", "project.context"],
    },
    {
      id: "send-message",
      description: "Send a Slack message only after explicit confirmation.",
      source: "instructions/send-message.md",
      tools: ["slack.messages.post"],
      memoryScopes: ["project.context"],
    },
  ],
  tools: [
    readTool("slack.channels.list", "List accessible Slack channels.", ["channels:read", "groups:read"]),
    readTool("slack.conversations.history", "Read channel message history.", ["channels:history", "groups:history"]),
    readTool("slack.search.messages", "Search accessible Slack messages.", ["search:read"]),
    writeTool("slack.messages.post", "Send a Slack message after confirmation.", ["chat:write"]),
  ],
  memory: { scopes: ["user.preferences", "project.context"] },
  authorization: {
    provider: "slack",
    requiredScopes: [
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "search:read",
      "chat:write",
    ],
  },
  adapters: defaultAdapters,
  ui: {
    settings: [],
    actions: [
      {
        id: "send-message",
        label: "Send message",
        tool: "slack.messages.post",
      },
    ],
  },
});

const extendedCapabilityPackSpecs = [
  {
    name: "microsoft-365",
    displayName: "Microsoft 365",
    description: "Use Outlook, Teams, OneDrive, and SharePoint through One Status.",
    provider: "microsoft",
    scopes: ["offline_access", "openid", "profile", "email", "User.Read", "Mail.Read", "Mail.Send", "Calendars.Read", "Chat.ReadBasic", "Chat.Read", "Files.Read", "Sites.Read.All"],
    actions: [
      readTool("outlook.messages.list", "List Outlook messages.", ["Mail.Read"]),
      readTool("outlook.messages.get", "Read one Outlook message.", ["Mail.Read"]),
      writeTool("outlook.messages.send", "Send Outlook mail after confirmation.", ["Mail.Send"]),
      readTool("outlook.calendar.events.list", "List Outlook calendar events.", ["Calendars.Read"]),
      readTool("teams.chats.list", "List Microsoft Teams chats.", ["Chat.ReadBasic"]),
      readTool("teams.chat_messages.list", "List messages from one Teams chat.", ["Chat.Read"]),
      readTool("onedrive.children.list", "List OneDrive folder children.", ["Files.Read"]),
      readTool("sharepoint.site_files.list", "List SharePoint site files.", ["Sites.Read.All"]),
    ],
  },
  {
    name: "notion-workspace",
    displayName: "Notion Workspace",
    description: "Search and read Notion content, with confirmed page creation.",
    provider: "notion",
    scopes: ["read_content", "insert_content"],
    actions: [
      readTool("notion.search", "Search authorized Notion content.", ["read_content"]),
      readTool("notion.pages.get", "Read Notion page metadata.", ["read_content"]),
      readTool("notion.blocks.children.list", "List child blocks.", ["read_content"]),
      writeTool("notion.pages.create", "Create a bounded Notion page after confirmation.", ["insert_content"]),
    ],
  },
  {
    name: "dropbox-files",
    displayName: "Dropbox Files",
    description: "List, inspect, and search Dropbox files, with confirmed small uploads.",
    provider: "dropbox",
    scopes: ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write"],
    actions: [
      readTool("dropbox.files.list", "List Dropbox folder entries.", ["files.metadata.read"]),
      readTool("dropbox.files.metadata.get", "Read Dropbox metadata.", ["files.metadata.read"]),
      readTool("dropbox.files.search", "Search Dropbox files.", ["files.metadata.read"]),
      writeTool("dropbox.files.upload", "Upload a bounded file after confirmation.", ["files.content.write"]),
    ],
  },
  {
    name: "zoom-meetings",
    displayName: "Zoom Meetings",
    description: "Read Zoom meetings and create scheduled meetings after confirmation.",
    provider: "zoom",
    scopes: ["user:read:user", "meeting:read:list_meetings", "meeting:read:meeting", "meeting:write:meeting"],
    actions: [
      readTool("zoom.meetings.list", "List Zoom meetings.", ["meeting:read:list_meetings"]),
      readTool("zoom.meetings.get", "Read one Zoom meeting.", ["meeting:read:meeting"]),
      writeTool("zoom.meetings.create", "Create a Zoom meeting after confirmation.", ["meeting:write:meeting"]),
    ],
  },
  {
    name: "canva-design",
    displayName: "Canva Design",
    description: "Read Canva profiles, designs, pages, and folder items.",
    provider: "canva",
    scopes: ["profile:read", "design:meta:read", "design:content:read", "folder:read"],
    actions: [
      readTool("canva.profile.get", "Read the current Canva profile.", ["profile:read"]),
      readTool("canva.designs.list", "List Canva designs.", ["design:meta:read"]),
      readTool("canva.designs.get", "Read Canva design metadata.", ["design:meta:read"]),
      readTool("canva.design_pages.list", "List Canva design pages.", ["design:content:read"]),
      readTool("canva.folder_items.list", "List Canva folder items.", ["folder:read"]),
    ],
  },
  {
    name: "asana-work-management",
    displayName: "Asana Work Management",
    description: "Read Asana workspaces and tasks, with confirmed task creation.",
    provider: "asana",
    scopes: ["default"],
    actions: [
      readTool("asana.workspaces.list", "List Asana workspaces.", ["default"]),
      readTool("asana.tasks.list", "List assigned Asana tasks.", ["default"]),
      readTool("asana.tasks.get", "Read one Asana task.", ["default"]),
      writeTool("asana.tasks.create", "Create an Asana task after confirmation.", ["default"]),
    ],
  },
  {
    name: "trello-boards",
    displayName: "Trello Boards",
    description: "Read Trello boards, lists, and cards, with confirmed card creation.",
    provider: "trello",
    scopes: ["read", "write"],
    actions: [
      readTool("trello.boards.list", "List Trello boards.", ["read"]),
      readTool("trello.lists.list", "List Trello board lists.", ["read"]),
      readTool("trello.cards.list", "List Trello board cards.", ["read"]),
      writeTool("trello.cards.create", "Create a Trello card after confirmation.", ["write"]),
    ],
  },
  {
    name: "airtable-bases",
    displayName: "Airtable Bases",
    description: "Read Airtable schemas and records, with confirmed record creation.",
    provider: "airtable",
    scopes: ["data.records:read", "data.records:write", "schema.bases:read", "user.email:read"],
    actions: [
      readTool("airtable.bases.list", "List Airtable bases.", ["schema.bases:read"]),
      readTool("airtable.tables.list", "List Airtable tables.", ["schema.bases:read"]),
      readTool("airtable.records.list", "List Airtable records.", ["data.records:read"]),
      writeTool("airtable.records.create", "Create an Airtable record after confirmation.", ["data.records:write"]),
    ],
  },
  {
    name: "linear-issues",
    displayName: "Linear Issues",
    description: "Read Linear teams and issues, with confirmed issue creation.",
    provider: "linear",
    scopes: ["read", "write"],
    actions: [
      readTool("linear.teams.list", "List Linear teams.", ["read"]),
      readTool("linear.issues.list", "List Linear issues.", ["read"]),
      readTool("linear.issues.get", "Read one Linear issue.", ["read"]),
      writeTool("linear.issues.create", "Create a Linear issue after confirmation.", ["write"]),
    ],
  },
  {
    name: "figma-design",
    displayName: "Figma Design",
    description: "Read Figma files and nodes, with confirmed comment creation.",
    provider: "figma",
    scopes: ["current_user:read", "projects:read", "file_metadata:read", "file_content:read", "file_comments:read", "file_comments:write"],
    actions: [
      readTool("figma.project_files.list", "List Figma project files.", ["projects:read"]),
      readTool("figma.file_metadata.get", "Read Figma file metadata.", ["file_metadata:read"]),
      readTool("figma.file_nodes.get", "Read bounded Figma node summaries.", ["file_content:read"]),
      readTool("figma.comments.list", "List Figma file comments.", ["file_comments:read"]),
      writeTool("figma.comments.create", "Create a Figma comment after confirmation.", ["file_comments:write"]),
    ],
  },
  {
    name: "box-files",
    displayName: "Box Files",
    description: "Read and search Box content, with confirmed folder creation.",
    provider: "box",
    scopes: ["root_readwrite"],
    actions: [
      readTool("box.folders.items.list", "List Box folder items.", ["root_readwrite"]),
      readTool("box.files.get", "Read Box file metadata.", ["root_readwrite"]),
      readTool("box.search", "Search Box content.", ["root_readwrite"]),
      writeTool("box.folders.create", "Create a Box folder after confirmation.", ["root_readwrite"]),
    ],
  },
] as const;

export const extendedCapabilityPacks = extendedCapabilityPackSpecs.map(
  (spec) => createProviderCapabilityPack(spec),
);

export const builtInCapabilityPacks = [
  googleWorkspaceCapabilityPack,
  githubWorkflowCapabilityPack,
  slackWorkspaceCapabilityPack,
  ...extendedCapabilityPacks,
] satisfies readonly CapabilityPackManifest[];

export function listBuiltInCapabilityPacks() {
  return builtInCapabilityPacks.map((manifest) => ({
    manifest,
    digest: computeCapabilityPackDigest(manifest),
  }));
}

export function getBuiltInCapabilityPack(
  name: string,
): CapabilityPackManifest | undefined {
  return builtInCapabilityPacks.find((pack) => pack.name === name);
}

function readTool(id: string, description: string, requiredScopes: string[]) {
  return {
    id,
    description,
    readOnly: true,
    requiresConfirmation: false,
    requiredScopes,
  };
}

function writeTool(id: string, description: string, requiredScopes: string[]) {
  return {
    id,
    description,
    readOnly: false,
    requiresConfirmation: true,
    requiredScopes,
  };
}

function createProviderCapabilityPack(spec: {
  actions: readonly ReturnType<typeof readTool>[];
  description: string;
  displayName: string;
  name: string;
  provider: string;
  scopes: readonly string[];
}): CapabilityPackManifest {
  const tools = spec.actions.map((action) => ({
    ...action,
    requiredScopes: [...action.requiredScopes],
  }));
  const writeActions = tools.filter((tool) => tool.readOnly === false);
  return capabilityPackManifestSchema.parse({
    format: "one-status.capability-pack",
    schemaVersion: 1,
    name: spec.name,
    version: "1.0.0",
    displayName: spec.displayName,
    description: spec.description,
    instructions: [
      {
        id: "gateway-first",
        description: `Use ${spec.displayName} actions through the One Status Permission Gateway.`,
        source: "instructions/gateway-first.md",
        tools: tools.map((tool) => tool.id),
        memoryScopes: ["user.preferences", "project.context"],
      },
    ],
    tools,
    memory: { scopes: ["user.preferences", "project.context"] },
    authorization: {
      provider: spec.provider,
      requiredScopes: [...spec.scopes],
    },
    adapters: defaultAdapters,
    ui: {
      settings: [],
      actions: writeActions.map((tool) => ({
        id: tool.id.replaceAll(".", "-"),
        label: tool.description ?? tool.id,
        tool: tool.id,
      })),
    },
  });
}
