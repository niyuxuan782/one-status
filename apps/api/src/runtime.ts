import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { importStatusKey } from "@one-status/crypto";
import { loadLocalProfile } from "@one-status/local-config";
import { loadOrCreateOpaqueServerSetup } from "@one-status/pake/setup";
import { OpaquePasswordAuthority } from "@one-status/pake/authority";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { CloudVaultServiceClient } from "./cloud-vault-client.js";
import { CloudVaultDesktopClient } from "./cloud-vault-desktop-client.js";
import { LocalDashboardBackend } from "./dashboard-backend.js";
import { DeviceControlService } from "./device-control.js";
import {
  SidecarModelConfigurationAdapter,
  SidecarModelUsageReader,
} from "./device-sidecar.js";
import { PermissionVaultGitHubCredentialProvider } from "./github-git-credentials.js";
import { HandoffService } from "./handoff.js";
import { LocalInventoryService } from "./local-inventory.js";
import { LocalCapabilityManager } from "./local-capability-manager.js";
import { LocalWorkspaceStore } from "./local-workspace.js";
import { LocalOnboardingService } from "./onboarding.js";
import {
  ModelGateway,
  ModelGatewayTokenAuthority,
} from "./model-gateway.js";
import { PermissionVault } from "./permission-vault.js";
import { PermissionSyncService } from "./permission-sync.js";
import { PermissionCloudMigration } from "./permission-cloud-migration.js";
import { LocalPermissionVaultMigrationAdapter } from "./cloud-vault/index.js";
import { ToolGateway } from "./tool-gateway.js";
import type { BackgroundStartupControl } from "./dashboard.js";

export interface ApiServerOptions {
  dashboard?: boolean;
  dbPath?: string;
  defaultSyncUrl?: string;
  deviceRelay?: boolean;
  host?: string;
  logger?: boolean;
  modelGatewayKeyPath?: string;
  oauthDbPath?: string;
  opaqueSetupPath?: string;
  permissionDbPath?: string;
  permissionKeyPath?: string;
  port?: number;
  publicBaseUrl?: string;
  releaseId?: string;
  remoteMcp?: boolean;
  remoteMcpIssuer?: string;
  remoteMcpResource?: string;
  startupControl?: BackgroundStartupControl;
  trustProxy?: boolean;
  vaultServiceToken?: string;
  vaultServiceUrl?: string;
  workspaceDbPath?: string;
}

export async function startApiServer(
  options: ApiServerOptions = {},
): Promise<FastifyInstance> {
  const host = options.host ?? "127.0.0.1";
  const dbPath = resolve(options.dbPath ?? resolveDefaultDatabasePath());
  const opaqueServerSetup = await loadOrCreateOpaqueServerSetup({
    explicit: process.env.ONE_STATUS_OPAQUE_SERVER_SETUP,
    path: resolve(options.opaqueSetupPath ?? `${dbPath}.opaque-setup`),
  });
  const dashboardEnabled =
    options.dashboard !== false && isLoopbackHost(host);
  const permissionVault = dashboardEnabled
    ? new PermissionVault({
        path: resolve(options.permissionDbPath ?? `${dbPath}.permissions`),
        keyPath: resolve(options.permissionKeyPath ?? `${dbPath}.permission-key`),
      })
    : undefined;
  const backend = dashboardEnabled ? new LocalDashboardBackend() : undefined;
  const inventory = dashboardEnabled ? new LocalInventoryService() : undefined;
  const modelUsage = dashboardEnabled ? new SidecarModelUsageReader() : undefined;
  const workspaceStore = dashboardEnabled
    ? new LocalWorkspaceStore(
        resolve(options.workspaceDbPath ?? `${dbPath}.workspace`),
      )
    : undefined;
  const permissionSync =
    permissionVault && backend
      ? new PermissionSyncService(
          backend,
          permissionVault,
          async () => {
            const profile = await loadLocalProfile();
            return {
              statusKey: importStatusKey(profile.statusKey),
              userId: profile.userId,
            };
          },
        )
      : undefined;
  const permissionCloudMigration = permissionVault
    ? new PermissionCloudMigration({
        loadProfile: loadLocalProfile,
        local: new LocalPermissionVaultMigrationAdapter(permissionVault),
      })
    : undefined;
  const walletPake = permissionVault
    ? new OpaquePasswordAuthority({
        serverSetup: opaqueServerSetup,
        store: {
          async get(userId) {
            return permissionVault.getWalletPakeRecord(userId);
          },
          async set(record) {
            permissionVault.upsertWalletPakeRecord(record);
          },
        },
      })
    : undefined;
  const port = options.port ?? 8787;
  const vaultService = createVaultServiceClient(options);
  const modelGateway =
    permissionVault && backend
      ? new ModelGateway({
          baseUrl: loopbackBaseUrl(host, port),
          tokenAuthority: new ModelGatewayTokenAuthority({
            keyPath: resolve(
              options.modelGatewayKeyPath ?? `${dbPath}.model-gateway-key`,
            ),
          }),
          resolveSource: async ({ sourceId, userId }) => {
            const snapshot = await backend.getSnapshot();
            if (snapshot.profile.userId !== userId) return undefined;
            const source = snapshot.status.deviceControl.sources[sourceId];
            if (!source) return undefined;
            return {
              source,
              apiKey: permissionVault.getModelCredential(userId, sourceId),
            };
          },
        })
      : undefined;
  const deviceControl =
    backend && inventory && permissionVault
      ? new DeviceControlService(
          backend,
          inventory,
          permissionVault,
          new SidecarModelConfigurationAdapter(),
          modelUsage,
          async () => {
            const profile = await loadLocalProfile();
            return importStatusKey(profile.statusKey);
          },
          modelGateway,
        )
      : undefined;
  const onboarding = dashboardEnabled
    ? new LocalOnboardingService(
        options.defaultSyncUrl ??
          process.env.ONE_STATUS_DEFAULT_SYNC_URL ??
          "https://os.furesta.top",
      )
    : undefined;
  let stopDeviceControl: (() => void) | undefined;
  const app = createApp({
    dbPath,
    deviceRelay: options.deviceRelay || options.remoteMcp ? {} : false,
    remoteCloud: options.remoteMcp
      ? {
          issuer: requiredRemoteUrl(
            options.remoteMcpIssuer ?? options.publicBaseUrl,
            "Remote MCP OAuth issuer",
          ),
          oauthDbPath: resolve(options.oauthDbPath ?? dbPath),
          resource: requiredRemoteUrl(
            options.remoteMcpResource,
            "Remote MCP resource",
          ),
          vault: vaultService,
        }
      : false,
    ...(permissionVault && backend && inventory && workspaceStore
      ? {
          dashboard: {
            backend,
            capabilityManager: new LocalCapabilityManager(),
            cloudVault: new CloudVaultDesktopClient(),
            closeLocalState: () => {
              stopDeviceControl?.();
              onboarding?.close();
              walletPake?.close();
              workspaceStore.close();
            },
            handoffs: new HandoffService(backend, workspaceStore, {
              githubCredentialProvider:
                new PermissionVaultGitHubCredentialProvider(
                  backend,
                  permissionVault,
                ),
            }),
            inventory,
            modelGateway: modelGateway!,
            deviceControl: deviceControl!,
            modelUsage: modelUsage!,
            onboarding: onboarding!,
            permissionVault,
            permissionSync: permissionSync!,
            publicBaseUrl: normalizePublicBaseUrl(options.publicBaseUrl),
            startupControl: options.startupControl,
            toolGateway: new ToolGateway(permissionVault),
            walletPake: walletPake!,
          },
        }
      : {}),
    logger: options.logger ?? true,
    opaqueServerSetup,
    releaseId: options.releaseId ?? process.env.ONE_STATUS_RELEASE_ID,
    trustProxy: options.trustProxy,
  });
  await app.listen({
    host,
    port,
  });
  if (deviceControl && permissionSync) {
    stopDeviceControl = startDeviceControlLoop(
      deviceControl,
      permissionSync,
      permissionCloudMigration,
    );
  }
  return app;
}

function createVaultServiceClient(
  options: Pick<ApiServerOptions, "vaultServiceToken" | "vaultServiceUrl">,
): CloudVaultServiceClient | undefined {
  const baseUrl =
    options.vaultServiceUrl ?? process.env.ONE_STATUS_VAULT_SERVICE_URL;
  const serviceToken =
    options.vaultServiceToken ?? process.env.ONE_STATUS_VAULT_SERVICE_TOKEN;
  if (!baseUrl && !serviceToken) return undefined;
  if (!baseUrl || !serviceToken) {
    throw new Error(
      "Vault Service URL and service token must be configured together.",
    );
  }
  return new CloudVaultServiceClient({ baseUrl, serviceToken });
}

function requiredRemoteUrl(
  value: string | undefined,
  label: string,
): string {
  if (!value) throw new Error(`${label} is required when Remote MCP is enabled.`);
  return value;
}

function startDeviceControlLoop(
  deviceControl: DeviceControlService,
  permissionSync: Pick<PermissionSyncService, "run">,
  permissionCloudMigration?: Pick<PermissionCloudMigration, "run">,
): () => void {
  let stopped = false;
  const synchronize = async () => {
    try {
      await permissionSync.run(() =>
        deviceControl.synchronizeCurrentDevice(),
      );
      await permissionCloudMigration?.run();
    } catch {
      // Onboarding may be incomplete, or the encrypted sync service may be offline.
    }
  };
  void synchronize();
  const timer = setInterval(() => {
    if (!stopped) void synchronize();
  }, 30_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function loopbackBaseUrl(host: string, port: number): string {
  const hostname = host === "::1" ? "[::1]" : host;
  return `http://${hostname}:${port}`;
}

function normalizePublicBaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OAuth public base URL requires HTTPS outside loopback.");
  }
  return url.toString();
}

export function resolveDefaultDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.ONE_STATUS_DB) {
    return resolve(environment.ONE_STATUS_DB);
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "One Status",
      "server.sqlite",
    );
  }
  if (process.platform === "win32") {
    return join(
      environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "One Status",
      "server.sqlite",
    );
  }
  return join(
    environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "one-status",
    "server.sqlite",
  );
}
