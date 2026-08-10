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

export type OnboardingLoginInput = OnboardingAccountInput;

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
      userId: session.userId,
    };
  }

  async login(input: OnboardingLoginInput): Promise<{
    deviceId: string;
    userId: string;
  }> {
    const baseUrl = normalizeServerUrl(input.serverUrl);
    const migrationCandidate = await loadMigrationCandidate(baseUrl);
    await prepareLocalProfileStorage(
      resolveProfilePath(),
      migrationCandidate === undefined,
    );
    const anonymous = new OneStatusClient({ baseUrl });
    const session = await anonymous.login(
      {
        deviceName: input.deviceName,
        email: input.email,
        installationId: await loadOrCreateInstallationId(
          migrationCandidate?.deviceId,
        ),
        password: input.password,
      },
      migrationCandidate,
    );
    if (migrationCandidate && migrationCandidate.userId !== session.userId) {
      await new OneStatusClient({ baseUrl, token: session.token })
        .logout()
        .catch(() => undefined);
      throw new Error(
        "The existing local profile belongs to another One Status account.",
      );
    }
    const exportedKey = exportStatusKey(session.statusKey);
    const authenticated = new OneStatusClient({
      baseUrl,
      token: session.token,
    });
    try {
      await authenticated.createVault(session.statusKey).read();
    } catch (error) {
      await authenticated.logout().catch(() => undefined);
      throw error;
    }
    await saveSession(baseUrl, input.deviceName, exportedKey, session);
    return { deviceId: session.deviceId, userId: session.userId };
  }
}

async function loadMigrationCandidate(baseUrl: string): Promise<
  | { deviceId: string; statusKey: Uint8Array; userId: string }
  | undefined
> {
  try {
    await stat(resolveProfilePath());
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const profile = await loadLocalProfile();
  if (normalizeServerUrl(profile.baseUrl) !== baseUrl) return undefined;
  return {
    deviceId: profile.deviceId,
    statusKey: importStatusKey(profile.statusKey),
    userId: profile.userId,
  };
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
