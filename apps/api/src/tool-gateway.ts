import {
  executeProviderAction,
  type ProviderFetch,
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

export class ToolGateway {
  readonly #fetch?: ProviderFetch;
  readonly #now: () => number;
  readonly #refreshes = new Map<string, Promise<FreshCredential>>();

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

  async execute(input: {
    action: string;
    agentId: string;
    arguments?: unknown;
    confirmed?: boolean;
    connectionId: string;
    userId: string;
  }): Promise<unknown> {
    const startedAt = Date.now();
    const connection = this.vault.getConnectionWithCredential(
      input.userId,
      input.connectionId,
    );
    const allowed = connection
      ? this.vault
          .getAllowedActions(
            input.userId,
            input.connectionId,
            input.agentId,
          )
          .includes(input.action)
      : false;
    const actionDefinition = connection
      ? providerCatalog[connection.provider].actions.find(
          (action) => action.id === input.action,
        )
      : undefined;
    const hasRequiredScopes =
      connection && actionDefinition
        ? hasScopes(connection.scopes, actionDefinition.requiredScopes)
        : false;
    if (
      !connection ||
      !allowed ||
      !actionDefinition ||
      !hasRequiredScopes ||
      connection.status === "error"
    ) {
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

    if (actionDefinition.requiresConfirmation && input.confirmed !== true) {
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
      return result.data;
    } catch (error) {
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
