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
import { DesktopStartupControl } from "./startup-control.js";

const PRODUCT_NAME = "One Status";
const APP_USER_MODEL_ID = "top.furesta.onestatus";

let mainWindow: BrowserWindow | undefined;
let localService: LocalService | undefined;
let stopHeartbeat: (() => void) | undefined;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
const backgroundMode = process.argv.includes("--background");
let windowRequested = !backgroundMode;

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
    if (backgroundMode) app.dock?.hide();
    installSessionSecurity();
    const startupControl = new DesktopStartupControl({
      executablePath: process.execPath,
      launchArguments: backgroundLaunchArguments(),
    });
    localService = await ensureLocalService({
      port: resolveDesktopPort(),
      start: async (port) =>
        startApiServer({
          dashboard: true,
          host: "127.0.0.1",
          logger: false,
          port,
          publicBaseUrl: `http://127.0.0.1:${port}`,
          startupControl,
        }),
    });
    stopHeartbeat = startHeartbeatLoop();
    if (windowRequested) await createMainWindow(localService.baseUrl);
  } catch (error) {
    if (backgroundMode) {
      console.error(startupErrorMessage(error));
    } else {
      await app.whenReady().catch(() => undefined);
      dialog.showErrorBox("One Status could not start", startupErrorMessage(error));
    }
    stopHeartbeat?.();
    await localService?.close().catch((closeError: unknown) =>
      console.error("Failed to stop local service", closeError),
    );
    shutdownComplete = true;
    app.exit(1);
  }
}

function installApplicationLifecycle(): void {
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.includes("--background")) return;
    windowRequested = true;
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (localService) {
        void createMainWindow(localService.baseUrl).catch(showRuntimeError);
      }
      return;
    }
    focusMainWindow();
  });

  app.on("activate", () => {
    windowRequested = true;
    if (BrowserWindow.getAllWindows().length === 0 && localService) {
      void createMainWindow(localService.baseUrl).catch(showRuntimeError);
    }
  });

  app.on("window-all-closed", () => {
    app.dock?.hide();
  });

  app.on("before-quit", (event: Event) => {
    closeOwnedServiceBeforeQuit(event);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => app.quit());
  }
}

function closeOwnedServiceBeforeQuit(event: Event): void {
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
}

function backgroundLaunchArguments(): string[] {
  return app.isPackaged
    ? ["--background"]
    : [app.getAppPath(), "--background"];
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
  app.dock?.show();
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
    windowRequested = false;
    if (mainWindow === window) mainWindow = undefined;
  });

  await window.loadURL(baseUrl);
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  app.dock?.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
