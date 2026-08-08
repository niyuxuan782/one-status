import { timingSafeEqual } from "node:crypto";
import type { SyncedStatusVault } from "@one-status/client";
import { OneStatusClient } from "@one-status/client";
import { importStatusKey } from "@one-status/crypto";
import {
  loadLocalProfile,
  type LocalProfile,
} from "@one-status/local-config";
import type {
  AccountResponse,
  StatusDocument,
} from "@one-status/protocol";

export interface DashboardStatusSnapshot {
  account: AccountResponse;
  profile: {
    baseUrl: string;
    deviceId: string;
    deviceName: string;
    tokenExpiresAt: string;
    userId: string;
  };
  status: StatusDocument;
  updatedAt: string | null;
  version: number;
}

export interface DashboardBackend {
  authenticateDevice?(
    authorization?: string,
  ): Promise<{ deviceId: string; userId: string } | undefined>;
  getSnapshot(): Promise<DashboardStatusSnapshot>;
  mutateStatus(
    mutator: (status: StatusDocument) => void,
  ): Promise<DashboardStatusSnapshot>;
  revokeDevice(deviceId: string): Promise<void>;
  userId(): Promise<string>;
}

export class LocalDashboardBackend implements DashboardBackend {
  constructor(
    private readonly loadProfile: () => Promise<LocalProfile> =
      loadLocalProfile,
  ) {}

  async authenticateDevice(
    authorization?: string,
  ): Promise<{ deviceId: string; userId: string } | undefined> {
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return undefined;
    try {
      const profile = await this.loadProfile();
      const expiresAt = Date.parse(profile.tokenExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
      const supplied = Buffer.from(token);
      const expected = Buffer.from(profile.token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        return undefined;
      }
      return { deviceId: profile.deviceId, userId: profile.userId };
    } catch {
      return undefined;
    }
  }

  async getSnapshot(): Promise<DashboardStatusSnapshot> {
    const { client, profile, vault } = await this.#open();
    const [snapshot, account] = await Promise.all([
      vault.read(),
      client.getAccount(),
    ]);
    return {
      account,
      profile: publicProfile(profile),
      status: snapshot.status,
      updatedAt: snapshot.updatedAt,
      version: snapshot.version,
    };
  }

  async mutateStatus(
    mutator: (status: StatusDocument) => void,
  ): Promise<DashboardStatusSnapshot> {
    const { client, profile, vault } = await this.#open();
    const snapshot = await vault.mutate(mutator);
    return {
      account: await client.getAccount(),
      profile: publicProfile(profile),
      status: snapshot.status,
      updatedAt: snapshot.updatedAt,
      version: snapshot.version,
    };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const profile = await this.loadProfile();
    if (deviceId === profile.deviceId) {
      throw new Error("The active dashboard device cannot revoke itself.");
    }
    const client = new OneStatusClient({
      baseUrl: profile.baseUrl,
      token: profile.token,
    });
    await client.revokeDevice(deviceId);
  }

  async userId(): Promise<string> {
    return (await this.loadProfile()).userId;
  }

  async #open(): Promise<{
    client: OneStatusClient;
    profile: LocalProfile;
    vault: SyncedStatusVault;
  }> {
    const profile = await this.loadProfile();
    const client = new OneStatusClient({
      baseUrl: profile.baseUrl,
      token: profile.token,
    });
    return {
      client,
      profile,
      vault: client.createVault(importStatusKey(profile.statusKey)),
    };
  }
}

function publicProfile(profile: LocalProfile) {
  return {
    baseUrl: profile.baseUrl,
    deviceId: profile.deviceId,
    deviceName: profile.deviceName,
    tokenExpiresAt: profile.tokenExpiresAt,
    userId: profile.userId,
  };
}
