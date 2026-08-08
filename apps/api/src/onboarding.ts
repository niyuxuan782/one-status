import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { OneStatusClient } from "@one-status/client";
import {
  exportStatusKey,
  generateStatusKey,
  importStatusKey,
} from "@one-status/crypto";
import {
  loadLocalProfile,
  loadOrCreateInstallationId,
  prepareLocalProfileStorage,
  resolveProfilePath,
  saveLocalProfile,
} from "@one-status/local-config";

export interface OnboardingAccountInput {
  deviceName: string;
  email: string;
  password: string;
  serverUrl: string;
}

export interface OnboardingLoginInput extends OnboardingAccountInput {
  statusKey: string;
}

export class LocalOnboardingService {
  constructor(
    private readonly defaultServerUrl = "https://os.furesta.top",
  ) {
    new OneStatusClient({ baseUrl: defaultServerUrl });
  }

  async status(): Promise<{
    authenticated: boolean;
    defaultServerUrl: string;
    deviceName: string;
    profile?: { deviceName: string; serverUrl: string; userId: string };
  }> {
    try {
      await stat(resolveProfilePath());
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          authenticated: false,
          defaultServerUrl: this.defaultServerUrl,
          deviceName: hostname(),
        };
      }
      throw error;
    }
    const profile = await loadLocalProfile();
    return {
      authenticated: true,
      defaultServerUrl: this.defaultServerUrl,
      deviceName: profile.deviceName,
      profile: {
        deviceName: profile.deviceName,
        serverUrl: profile.baseUrl,
        userId: profile.userId,
      },
    };
  }

  async register(input: OnboardingAccountInput): Promise<{
    deviceId: string;
    statusKey: string;
    userId: string;
  }> {
    await prepareLocalProfileStorage(resolveProfilePath(), true);
    const baseUrl = normalizeServerUrl(input.serverUrl);
    const statusKey = generateStatusKey();
    const exportedKey = exportStatusKey(statusKey);
    const client = new OneStatusClient({ baseUrl });
    const session = await client.register(
      {
        deviceName: input.deviceName,
        email: input.email,
        installationId: await loadOrCreateInstallationId(),
        password: input.password,
      },
      statusKey,
    );
    await saveSession(baseUrl, input.deviceName, exportedKey, session);
    return {
      deviceId: session.deviceId,
      statusKey: exportedKey,
      userId: session.userId,
    };
  }

  async login(input: OnboardingLoginInput): Promise<{
    deviceId: string;
    userId: string;
  }> {
    await prepareLocalProfileStorage(resolveProfilePath(), true);
    const baseUrl = normalizeServerUrl(input.serverUrl);
    const statusKey = importStatusKey(input.statusKey);
    const anonymous = new OneStatusClient({ baseUrl });
    const session = await anonymous.login({
      deviceName: input.deviceName,
      email: input.email,
      installationId: await loadOrCreateInstallationId(),
      password: input.password,
    });
    const authenticated = new OneStatusClient({
      baseUrl,
      token: session.token,
    });
    try {
      await authenticated.createVault(statusKey).read();
    } catch (error) {
      await authenticated.logout().catch(() => undefined);
      throw error;
    }
    await saveSession(baseUrl, input.deviceName, input.statusKey, session);
    return { deviceId: session.deviceId, userId: session.userId };
  }
}

async function saveSession(
  baseUrl: string,
  deviceName: string,
  statusKey: string,
  session: {
    deviceId: string;
    expiresAt: string;
    token: string;
    userId: string;
  },
): Promise<void> {
  await saveLocalProfile({
    baseUrl,
    deviceId: session.deviceId,
    deviceName,
    statusKey,
    token: session.token,
    tokenExpiresAt: session.expiresAt,
    userId: session.userId,
    version: 1,
  });
}

function normalizeServerUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/, "");
  new OneStatusClient({ baseUrl: normalized });
  return normalized;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
