import process from "node:process";
import { startApiServer } from "../../api/src/runtime.js";
import { OneStatusClient } from "@one-status/client";
import { loadLocalProfile } from "@one-status/local-config";
import {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  type Event,
} from "electron";
import {
  ensureLocalService,
  LocalServicePortError,
  resolveDesktopPort,
  type LocalService,
} from "./service-runtime.js";

const PRODUCT_NAME = "One Status";
const APP_USER_MODEL_ID = "top.furesta.onestatus";

let mainWindow: BrowserWindow | undefined;
let localService: LocalService | undefined;
let stopHeartbeat: (() => void) | undefined;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;

app.setName(PRODUCT_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  installApplicationLifecycle();
  void launch();
}

async function launch(): Promise<void> {
  try {
    await app.whenReady();
    installSessionSecurity();
    localService = await ensureLocalService({
      port: resolveDesktopPort(),
      start: async (port) =>
        startApiServer({
          dashboard: true,
          host: "127.0.0.1",
          logger: false,
          port,
          publicBaseUrl: `http://127.0.0.1:${port}`,
        }),
    });
    stopHeartbeat = startHeartbeatLoop();
    await createMainWindow(localService.baseUrl);
  } catch (error) {
    await app.whenReady().catch(() => undefined);
    dialog.showErrorBox("One Status could not start", startupErrorMessage(error));
    stopHeartbeat?.();
    await localService?.close().catch((closeError: unknown) =>
      console.error("Failed to stop local service", closeError),
    );
    shutdownComplete = true;
    app.exit(1);
  }
}

function installApplicationLifecycle(): void {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && localService) {
      void createMainWindow(localService.baseUrl).catch(showRuntimeError);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event: Event) => {
    if (shutdownComplete || !localService) return;
    event.preventDefault();
    stopHeartbeat?.();
    stopHeartbeat = undefined;
    shutdownPromise ??= localService
      .close()
      .catch((error: unknown) => console.error("Failed to stop local service", error))
      .finally(() => {
        shutdownComplete = true;
        app.exit(0);
      });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => app.quit());
  }
}

function startHeartbeatLoop(): () => void {
  const heartbeat = async () => {
    try {
      const profile = await loadLocalProfile();
      await new OneStatusClient({
        baseUrl: profile.baseUrl,
        token: profile.token,
      }).heartbeat();
    } catch {
      // Onboarding may be incomplete, or the configured sync service may be offline.
    }
  };
  void heartbeat();
  const timer = setInterval(() => void heartbeat(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

function installSessionSecurity(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
}

async function createMainWindow(baseUrl: string): Promise<void> {
  const window = new BrowserWindow({
    backgroundColor: "#f3efe6",
    height: 820,
    minHeight: 640,
    minWidth: 900,
    show: false,
    title: PRODUCT_NAME,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    width: 1240,
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, baseUrl);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event: Event, url: string) => {
    if (isLocalApplicationUrl(url, baseUrl)) return;
    event.preventDefault();
    openExternalUrl(url, baseUrl);
  });
  window.webContents.on("will-redirect", (event: Event, url: string) => {
    if (isLocalApplicationUrl(url, baseUrl)) return;
    event.preventDefault();
    openExternalUrl(url, baseUrl);
  });
  window.webContents.on(
    "render-process-gone",
    (_event: Event, details: { reason: string }) => {
      if (details.reason === "clean-exit" || window.isDestroyed()) return;
      void dialog
        .showMessageBox(window, {
          buttons: ["Reload", "Close"],
          detail: `Renderer exit reason: ${details.reason}`,
          message: "The One Status window stopped unexpectedly.",
          type: "error",
        })
        .then(({ response }) => {
          if (response === 0 && !window.isDestroyed()) {
            void window.loadURL(baseUrl);
          }
        });
    },
  );
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  await window.loadURL(baseUrl);
}

function isLocalApplicationUrl(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string, baseUrl: string): void {
  if (isLocalApplicationUrl(url, baseUrl)) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    void shell.openExternal(parsed.toString());
  } catch {
    // Invalid navigation targets remain blocked.
  }
}

function startupErrorMessage(error: unknown): string {
  if (error instanceof LocalServicePortError) {
    return `${error.message}\n\nThe desktop app only reuses a listener when its /health endpoint identifies One Status.`;
  }
  return error instanceof Error
    ? `${error.message}\n\nCheck the local data directory permissions and try again.`
    : "An unknown startup error occurred.";
}

function showRuntimeError(error: unknown): void {
  dialog.showErrorBox(
    "One Status window error",
    error instanceof Error ? error.message : String(error),
  );
}
