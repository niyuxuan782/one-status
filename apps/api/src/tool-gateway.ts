import { createHash, randomUUID } from "node:crypto";
import {
  executeProviderAction,
  type ProviderFetch,
  type ProviderAction,
  ProviderRequestError,
  providerActionInputSchema,
  providerCatalog,
  refreshOAuthCredential,
} from "./oauth-providers.js";
import {
  PermissionVault,
  type OAuthConnection,
  type OAuthConnectionWithCredential,
} from "./permission-vault.js";

const REFRESH_SKEW_MS = 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_APPROVALS_PER_USER = 100;

export interface AvailableToolConnection {
  actions: Array<{
    description: string;
    id: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
    requiredScopes: string[];
    requiresConfirmation: boolean;
    title: string;
  }>;
  connection: OAuthConnection;
}

export interface ToolGatewayOptions {
  fetch?: ProviderFetch;
  now?: () => number;
}

interface FreshCredential {
  credential: OAuthConnectionWithCredential["credential"];
  scopes: string[];
}

export interface ToolActionApproval {
  action: string;
  agentId: string;
  arguments: Record<string, unknown>;
  connectionId: string;
  createdAt: string;
  expiresAt: string;
  id: string;
  status: "pending" | "approved" | "denied";
}

interface StoredToolActionApproval
  extends Omit<ToolActionApproval, "status"> {
  argumentsDigest: string;
  result?: unknown;
  status:
    | ToolActionApproval["status"]
    | "executing"
    | "failed"
    | "succeeded";
  userId: string;
}

interface AuthorizedActionContext {
  action: ProviderAction;
  connection: OAuthConnectionWithCredential;
}

export class ToolGateway {
  readonly #fetch?: ProviderFetch;
  readonly #now: () => number;
  readonly #refreshes = new Map<string, Promise<FreshCredential>>();
  readonly #approvals = new Map<string, StoredToolActionApproval>();

  constructor(
    private readonly vault: PermissionVault,
    options: ToolGatewayOptions = {},
  ) {
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
  }

  list(userId: string, agentId: string): AvailableToolConnection[] {
    return this.vault
      .listConnections(userId)
      .map((connection) => {
        const allowed = new Set(
          this.vault.getAllowedActions(userId, connection.id, agentId),
        );
        return {
          connection,
          actions:
            connection.status === "error"
              ? []
              : providerCatalog[connection.provider].actions
                  .filter(
                    (action) =>
                      allowed.has(action.id) &&
                      hasScopes(connection.scopes, action.requiredScopes),
                  )
                  .map((action) => ({
                    ...action,
                    inputSchema: providerActionInputSchema(
                      connection.provider,
                      action.id,
                    ),
                  })),
        };
      })
      .filter((entry) => entry.actions.length > 0);
  }

  requestApproval(input: {
    action: string;
    agentId: string;
    arguments?: Record<string, unknown>;
    connectionId: string;
    userId: string;
  }): ToolActionApproval {
    const context = this.#authorizedAction(input);
    if (!context.action.requiresConfirmation) {
      throw new ToolApprovalError(
        "This action does not require an approval request.",
      );
    }
    this.#cleanupApprovals(input.userId);
    const arguments_ = structuredClone(input.arguments ?? {});
    const argumentsDigest = digestArguments(arguments_);
    const existing = [...this.#approvals.values()].find(
      (approval) =>
        approval.userId === input.userId &&
        approval.agentId === input.agentId &&
        approval.connectionId === input.connectionId &&
        approval.action === input.action &&
        approval.argumentsDigest === argumentsDigest &&
        (approval.status === "pending" || approval.status === "approved") &&
        Date.parse(approval.expiresAt) > this.#now(),
    );
    if (existing) return publicApproval(existing);

    const createdAt = new Date(this.#now()).toISOString();
    const approval: StoredToolActionApproval = {
      action: input.action,
      agentId: input.agentId,
      arguments: arguments_,
      argumentsDigest,
      connectionId: input.connectionId,
      createdAt,
      expiresAt: new Date(this.#now() + APPROVAL_TTL_MS).toISOString(),
      id: randomUUID(),
      status: "pending",
      userId: input.userId,
    };
    this.#approvals.set(approval.id, approval);
    this.#cleanupApprovals(input.userId);
    return publicApproval(approval);
  }

  listApprovals(userId: string): ToolActionApproval[] {
    this.#cleanupApprovals(userId);
    return [...this.#approvals.values()]
      .filter(
        (approval) =>
          approval.userId === userId &&
          (approval.status === "pending" || approval.status === "approved"),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicApproval);
  }

  decideApproval(
    userId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): ToolActionApproval {
    this.#cleanupApprovals(userId);
    const approval = this.#approvals.get(approvalId);
    if (
      !approval ||
      approval.userId !== userId ||
      approval.status !== "pending" ||
      Date.parse(approval.expiresAt) <= this.#now()
    ) {
      throw new ToolApprovalError("The approval request is unavailable.");
    }
    approval.status = decision === "approve" ? "approved" : "denied";
    return publicApproval(approval);
  }

  async execute(input: {
    action: string;
    agentId: string;
    approvalId?: string;
    arguments?: unknown;
    confirmed?: boolean;
    connectionId: string;
    userId: string;
  }): Promise<unknown> {
    const startedAt = Date.now();
    let context: AuthorizedActionContext;
    try {
      context = this.#authorizedAction(input);
    } catch {
      this.vault.recordAudit({
        action: input.action,
        agentId: input.agentId,
        connectionId: input.connectionId,
        decision: "deny",
        outcome: "blocked",
        userId: input.userId,
      });
      throw new ToolPermissionDeniedError();
    }
    const { action: actionDefinition, connection } = context;

    const approval = actionDefinition.requiresConfirmation && input.confirmed !== true
      ? this.#claimApproval(input)
      : undefined;
    if (approval?.status === "succeeded") return structuredClone(approval.result);

    try {
      let credential = connection.credential;
      if (
        connection.expiresAt &&
        Date.parse(connection.expiresAt) - REFRESH_SKEW_MS <= this.#now()
      ) {
        let refreshed: FreshCredential;
        try {
          refreshed = await this.#refreshConnection(
            input.userId,
            connection,
          );
        } catch {
          const recoverableFromSync = Boolean(
            connection.credential.refreshToken,
          );
          if (!recoverableFromSync) {
            this.vault.setConnectionStatus(
              input.userId,
              connection.id,
              "expired",
            );
          }
          throw new ToolConnectionExpiredError(recoverableFromSync);
        }
        credential = refreshed.credential;
        if (!hasScopes(refreshed.scopes, actionDefinition.requiredScopes)) {
          this.vault.setConnectionStatus(input.userId, connection.id, "error");
          throw new ToolPermissionDeniedError();
        }
      }
      const result = await executeProviderAction({
        action: input.action,
        arguments: input.arguments,
        config:
          this.vault.getProviderConfig(
            input.userId,
            connection.provider,
          ) ?? undefined,
        credential,
        fetch: this.#fetch,
        provider: connection.provider,
      });
      this.vault.recordAudit({
        action: input.action,
        agentId: input.agentId,
        connectionId: input.connectionId,
        decision: "allow",
        durationMs: Date.now() - startedAt,
        outcome: "success",
        providerRequestId: result.providerRequestId,
        userId: input.userId,
      });
      if (approval) {
        approval.result = structuredClone(result.data);
        approval.status = "succeeded";
      }
      return result.data;
    } catch (error) {
      if (approval && approval.status === "executing") {
        approval.status = "failed";
      }
      if (error instanceof ProviderRequestError && error.authorizationInvalid) {
        this.vault.setConnectionStatus(input.userId, connection.id, "error");
      }
      this.vault.recordAudit({
        action: input.action,
        agentId: input.agentId,
        connectionId: input.connectionId,
        decision: "allow",
        durationMs: Date.now() - startedAt,
        outcome: "error",
        userId: input.userId,
      });
      throw error;
    }
  }

  #authorizedAction(input: {
    action: string;
    agentId: string;
    connectionId: string;
    userId: string;
  }): AuthorizedActionContext {
    const connection = this.vault.getConnectionWithCredential(
      input.userId,
      input.connectionId,
    );
    const action = connection
      ? providerCatalog[connection.provider].actions.find(
          (candidate) => candidate.id === input.action,
        )
      : undefined;
    if (
      !connection ||
      !action ||
      connection.status === "error" ||
      !this.vault
        .getAllowedActions(input.userId, input.connectionId, input.agentId)
        .includes(input.action) ||
      !hasScopes(connection.scopes, action.requiredScopes)
    ) {
      throw new ToolPermissionDeniedError();
    }
    return { action, connection };
  }

  #claimApproval(input: {
    action: string;
    agentId: string;
    approvalId?: string;
    arguments?: unknown;
    connectionId: string;
    userId: string;
  }): StoredToolActionApproval {
    this.#cleanupApprovals(input.userId);
    const approval = input.approvalId
      ? this.#approvals.get(input.approvalId)
      : undefined;
    if (
      !approval ||
      approval.userId !== input.userId ||
      approval.agentId !== input.agentId ||
      approval.connectionId !== input.connectionId ||
      approval.action !== input.action ||
      approval.argumentsDigest !== digestArguments(input.arguments ?? {}) ||
      Date.parse(approval.expiresAt) <= this.#now() ||
      !["approved", "succeeded"].includes(approval.status)
    ) {
      this.vault.recordAudit({
        action: input.action,
        agentId: input.agentId,
        connectionId: input.connectionId,
        decision: "deny",
        outcome: "blocked",
        userId: input.userId,
      });
      throw new ToolApprovalError(
        "This write action requires a current Dashboard approval.",
      );
    }
    if (approval.status === "approved") approval.status = "executing";
    return approval;
  }

  #cleanupApprovals(userId: string): void {
    const now = this.#now();
    const entries = [...this.#approvals.values()]
      .filter((approval) => approval.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const approval of entries) {
      if (
        Date.parse(approval.expiresAt) <= now &&
        approval.status !== "executing"
      ) {
        this.#approvals.delete(approval.id);
      }
    }
    const remaining = entries.filter((approval) =>
      this.#approvals.has(approval.id)
    );
    for (const approval of remaining.slice(
      0,
      Math.max(0, remaining.length - MAX_APPROVALS_PER_USER),
    )) {
      if (approval.status !== "executing") this.#approvals.delete(approval.id);
    }
  }

  #refreshConnection(
    userId: string,
    connection: OAuthConnectionWithCredential,
  ): Promise<FreshCredential> {
    const key = `${userId}:${connection.id}`;
    const active = this.#refreshes.get(key);
    if (active) return active;

    const refresh = (async () => {
      const config = this.vault.getProviderConfig(userId, connection.provider);
      if (!config) throw new Error("OAuth provider configuration is missing.");
      const refreshed = await refreshOAuthCredential({
        config,
        credential: connection.credential,
        fetch: this.#fetch,
        provider: connection.provider,
      });
      this.vault.updateCredential(
        userId,
        connection.id,
        refreshed.credential,
        refreshed.expiresAt,
        refreshed.scopes,
      );
      return {
        credential: refreshed.credential,
        scopes: refreshed.scopes ?? connection.scopes,
      };
    })();
    this.#refreshes.set(key, refresh);
    const clear = () => {
      if (this.#refreshes.get(key) === refresh) this.#refreshes.delete(key);
    };
    void refresh.then(clear, clear);
    return refresh;
  }
}

export class ToolPermissionDeniedError extends Error {
  constructor() {
    super("The agent is not allowed to execute this action.");
    this.name = "ToolPermissionDeniedError";
  }
}

export class ToolApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalError";
  }
}

export class ToolConnectionExpiredError extends Error {
  constructor(readonly recoverableFromSync = false) {
    super("The OAuth connection has expired and must be connected again.");
    this.name = "ToolConnectionExpiredError";
  }
}

function hasScopes(granted: string[], required: string[]): boolean {
  const available = new Set(granted);
  return required.every((scope) => available.has(scope));
}

function digestArguments(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ToolApprovalError("Arguments are invalid.");
  return serialized;
}

function publicApproval(
  approval: StoredToolActionApproval,
): ToolActionApproval {
  if (
    approval.status !== "pending" &&
    approval.status !== "approved" &&
    approval.status !== "denied"
  ) {
    throw new ToolApprovalError("The approval request is no longer active.");
  }
  return {
    action: approval.action,
    agentId: approval.agentId,
    arguments: structuredClone(approval.arguments),
    connectionId: approval.connectionId,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    id: approval.id,
    status: approval.status,
  };
}
