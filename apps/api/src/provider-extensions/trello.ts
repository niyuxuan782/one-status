import { z } from "zod";
import {
  addSearchParams,
  parseProviderPayload,
  providerJsonRequest,
  type ProviderExtension,
} from "../provider-extension.js";
import { ProviderRequestError } from "../provider-errors.js";

const resourceId = z.string().min(1).max(500);
const shortText = z.string().min(1).max(500);
const emptyArguments = z.object({}).strict();

const boardsListArguments = z.object({
  filter: z.enum(["all", "closed", "members", "open", "organization", "public", "starred"]).default("open"),
}).strict();
const listsListArguments = z.object({ boardId: resourceId }).strict();
const cardsListArguments = z.object({ boardId: resourceId }).strict();
const cardCreateArguments = z.object({
  description: z.string().max(20_000).optional(),
  due: z.iso.datetime({ offset: true }).optional(),
  listId: resourceId,
  name: shortText,
}).strict();

const trelloMember = z.object({
  fullName: z.string().max(500).optional(),
  id: resourceId,
  username: z.string().max(500).optional(),
}).passthrough();
const trelloToken = z.object({
  permissions: z
    .array(
      z
        .object({
          read: z.boolean().default(false),
          write: z.boolean().default(false),
        })
        .passthrough(),
    )
    .min(1)
    .max(1_000),
}).passthrough();
const trelloBoard = z.object({
  closed: z.boolean().optional(),
  dateLastActivity: z.string().max(100).nullable().optional(),
  desc: z.string().max(20_000).optional(),
  id: resourceId,
  name: shortText,
  url: z.url().optional(),
}).passthrough();
const trelloList = z.object({ closed: z.boolean().optional(), id: resourceId, name: shortText, pos: z.number().optional() }).passthrough();
const trelloCard = z.object({
  closed: z.boolean().optional(),
  dateLastActivity: z.string().max(100).nullable().optional(),
  desc: z.string().max(20_000).optional(),
  due: z.string().max(100).nullable().optional(),
  id: resourceId,
  idBoard: resourceId,
  idList: resourceId,
  name: shortText,
  shortUrl: z.url().optional(),
}).passthrough();

export const trelloProvider: ProviderExtension = {
  id: "trello",
  definition: {
    id: "trello",
    label: "Trello",
    description: "通过一次 API key 与用户 Token 连接读取看板，并在确认后创建卡片。",
    accent: "#0c66e4",
    authMode: "token",
    documentationUrl: "https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/",
    requiresPkce: false,
    requiresSecret: false,
    scopes: ["read", "write"],
    actions: [
      readAction("trello.boards.list", "读取 Trello Boards", "读取当前成员的看板。"),
      readAction("trello.lists.list", "读取 Trello Lists", "读取指定看板的列表。"),
      readAction("trello.cards.list", "读取 Trello Cards", "读取指定看板的卡片。"),
      writeAction("trello.cards.create", "创建 Trello Card", "在确认后向指定列表创建卡片。"),
    ],
  },
  actionArgumentsSchema(action) {
    if (action === "trello.boards.list") return boardsListArguments;
    if (action === "trello.lists.list") return listsListArguments;
    if (action === "trello.cards.list") return cardsListArguments;
    if (action === "trello.cards.create") return cardCreateArguments;
    throw unsupported(action);
  },
  buildAuthorizationUrl() {
    throw new ProviderRequestError(
      "Trello uses a user Token connection in this release.",
      "token_connection_required",
    );
  },
  async exchangeOAuthCode() {
    throw new ProviderRequestError(
      "Trello uses a user Token connection in this release.",
      "token_connection_required",
    );
  },
  async refreshCredential() {
    throw new ProviderRequestError(
      "Trello user Tokens do not use OAuth refresh.",
      "refresh_not_supported",
    );
  },
  async revokeCredential() {},
  tokenConnection: {
    label: "Trello user Token",
    async verify({ accessToken, config, fetch }) {
      const memberResponse = await trelloRequest({
        accessToken,
        config,
        fetch,
        url: "https://api.trello.com/1/members/me?fields=id,username,fullName",
      });
      const member = parseProviderPayload(trelloMember, memberResponse.body);
      const tokenResponse = await trelloRequest({
        accessToken,
        config,
        fetch,
        url:
          `https://api.trello.com/1/tokens/${encodeURIComponent(accessToken)}` +
          "?fields=id,idMember,dateCreated,dateExpires,identifier,permissions",
      });
      const token = parseProviderPayload(trelloToken, tokenResponse.body);
      const scopes = [
        ...(token.permissions.some((permission) => permission.read)
          ? ["read"]
          : []),
        ...(token.permissions.some((permission) => permission.write)
          ? ["write"]
          : []),
      ];
      if (scopes.length === 0) {
        throw new ProviderRequestError(
          "Trello Token has no usable permissions.",
          "insufficient_provider_scope",
        );
      }
      return {
        accountId: member.id,
        label: member.username ?? member.fullName ?? `Trello ${member.id}`,
        scopes,
      };
    },
  },
  async executeAction(input) {
    if (!input.config) {
      throw new ProviderRequestError(
        "Trello API key configuration is missing.",
        "missing_provider_config",
      );
    }
    if (input.action === "trello.boards.list") {
      const args = boardsListArguments.parse(input.arguments ?? {});
      const url = addSearchParams(new URL("https://api.trello.com/1/members/me/boards"), {
        fields: "id,name,desc,closed,url,dateLastActivity",
        filter: args.filter,
      });
      const response = await trelloRequest({ ...input, url });
      const boards = parseProviderPayload(z.array(trelloBoard).max(1_000), response.body);
      return { data: { items: boards.map(normalizeBoard) }, providerRequestId: response.requestId };
    }
    if (input.action === "trello.lists.list") {
      const args = listsListArguments.parse(input.arguments);
      const response = await trelloRequest({ ...input, url: `https://api.trello.com/1/boards/${encodeURIComponent(args.boardId)}/lists?fields=id,name,closed,pos` });
      const lists = parseProviderPayload(z.array(trelloList).max(1_000), response.body);
      return { data: { items: lists.map((list) => ({ closed: list.closed ?? false, id: list.id, name: list.name, position: list.pos ?? null })) }, providerRequestId: response.requestId };
    }
    if (input.action === "trello.cards.list") {
      const args = cardsListArguments.parse(input.arguments);
      const response = await trelloRequest({ ...input, url: `https://api.trello.com/1/boards/${encodeURIComponent(args.boardId)}/cards?fields=id,name,desc,closed,due,idBoard,idList,shortUrl,dateLastActivity` });
      const cards = parseProviderPayload(z.array(trelloCard).max(2_000), response.body);
      return { data: { items: cards.map(normalizeCard) }, providerRequestId: response.requestId };
    }
    if (input.action === "trello.cards.create") {
      const args = cardCreateArguments.parse(input.arguments);
      const body = new URLSearchParams({ idList: args.listId, name: args.name });
      if (args.description) body.set("desc", args.description);
      if (args.due) body.set("due", args.due);
      const response = await trelloRequest({
        ...input,
        init: { body, headers: { "content-type": "application/x-www-form-urlencoded" }, method: "POST" },
        url: "https://api.trello.com/1/cards",
      });
      return { data: normalizeCard(parseProviderPayload(trelloCard, response.body)), providerRequestId: response.requestId };
    }
    throw unsupported(input.action);
  },
};

async function trelloRequest(input: {
  accessToken?: string;
  config?: { clientId: string };
  credential?: { accessToken: string };
  fetch?: Parameters<typeof providerJsonRequest>[0]["fetch"];
  init?: RequestInit;
  url: string | URL;
}) {
  const token = input.accessToken ?? input.credential?.accessToken;
  if (!token || !input.config?.clientId) {
    throw new ProviderRequestError("Trello credentials are missing.", "missing_provider_credential");
  }
  const headers = new Headers(input.init?.headers);
  headers.set(
    "authorization",
    `OAuth oauth_consumer_key="${oauthHeaderValue(input.config.clientId)}", oauth_token="${oauthHeaderValue(token)}"`,
  );
  return providerJsonRequest({ fetch: input.fetch, init: { ...input.init, headers }, url: input.url });
}

function oauthHeaderValue(value: string): string {
  if (!value || value.length > 32_000 || /["\\\r\n]/.test(value)) {
    throw new ProviderRequestError("Trello credential is invalid.", "invalid_provider_credential");
  }
  return encodeURIComponent(value);
}

function normalizeBoard(board: z.infer<typeof trelloBoard>) {
  return { closed: board.closed ?? false, description: board.desc ?? null, id: board.id, lastActivityAt: board.dateLastActivity ?? null, name: board.name, url: board.url ?? null };
}

function normalizeCard(card: z.infer<typeof trelloCard>) {
  return { boardId: card.idBoard, closed: card.closed ?? false, description: card.desc ?? null, dueAt: card.due ?? null, id: card.id, lastActivityAt: card.dateLastActivity ?? null, listId: card.idList, name: card.name, url: card.shortUrl ?? null };
}

function readAction(id: string, title: string, description: string) {
  return { description, id, readOnly: true, requiredScopes: ["read"], requiresConfirmation: false, title };
}

function writeAction(id: string, title: string, description: string) {
  return { description, id, readOnly: false, requiredScopes: ["write"], requiresConfirmation: true, title };
}

function unsupported(action: string): Error {
  return new Error(`Unsupported provider action: ${action}`);
}
