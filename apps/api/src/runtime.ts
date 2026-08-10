import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { importStatusKey } from "@one-status/crypto";
import { loadLocalProfile } from "@one-status/local-config";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
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
import { PermissionVault } from "./permission-vault.js";
import { PermissionSyncService } from "./permission-sync.js";
import { ToolGateway } from "./tool-gateway.js";

export interface ApiServerOptions {
  dashboard?: boolean;
  dbPath?: string;
  defaultSyncUrl?: string;
  host?: string;
  logger?: boolean;
  permissionDbPath?: string;
  permissionKeyPath?: string;
  port?: number;
  publicBaseUrl?: string;
  releaseId?: string;
  trustProxy?: boolean;
  workspaceDbPath?: string;
}

export async function startApiServer(
  options: ApiServerOptions = {},
): Promise<FastifyInstance> {
  const host = options.host ?? "127.0.0.1";
  const dbPath = resolve(options.dbPath ?? resolveDefaultDatabasePath());
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
  const deviceControl =
    backend && inventory && permissionVault
      ? new DeviceControlService(
          backend,
          inventory,
          permissionVault,
          new SidecarModelConfigurationAdapter(),
          modelUsage,
        )
      : undefined;
  let stopDeviceControl: (() => void) | undefined;
  const app = createApp({
    dbPath,
    ...(permissionVault && backend && inventory && workspaceStore
      ? {
          dashboard: {
            backend,
            capabilityManager: new LocalCapabilityManager(),
            closeLocalState: () => {
              stopDeviceControl?.();
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
            deviceControl: deviceControl!,
            modelUsage: modelUsage!,
            onboarding: new LocalOnboardingService(
              options.defaultSyncUrl ??
                process.env.ONE_STATUS_DEFAULT_SYNC_URL ??
                "https://os.furesta.top",
            ),
            permissionVault,
            permissionSync: permissionSync!,
            publicBaseUrl: normalizePublicBaseUrl(options.publicBaseUrl),
            toolGateway: new ToolGateway(permissionVault),
          },
        }
      : {}),
    logger: options.logger ?? true,
    releaseId: options.releaseId ?? process.env.ONE_STATUS_RELEASE_ID,
    trustProxy: options.trustProxy,
  });
  await app.listen({
    host,
    port: options.port ?? 8787,
  });
  if (deviceControl && permissionSync) {
    stopDeviceControl = startDeviceControlLoop(
      deviceControl,
      permissionSync,
    );
  }
  return app;
}

function startDeviceControlLoop(
  deviceControl: DeviceControlService,
  permissionSync: Pick<PermissionSyncService, "run">,
): () => void {
  let stopped = false;
  const synchronize = async () => {
    try {
      await permissionSync.run(() =>
        deviceControl.synchronizeCurrentDevice(),
      );
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
