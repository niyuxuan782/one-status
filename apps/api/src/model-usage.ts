import {
  deviceModelUsageSchema,
  type DeviceModelUsage,
  type StatusDocument,
} from "@one-status/protocol";
import { z } from "zod";
import type { LocalModelUsageSnapshot } from "./device-sidecar.js";

const MODEL_USAGE_PREFERENCE_PREFIX =
  "__one_status_internal:model-usage:v1:";
const MAX_STORED_USAGE_BYTES = 2 * 1024 * 1024;

const storedDeviceModelUsageSchema = deviceModelUsageSchema
  .extend({
    deviceId: z.string().min(1).max(200),
    version: z.literal(1),
  })
  .strict();

export type StoredDeviceModelUsage = DeviceModelUsage & {
  deviceId: string;
  version: 1;
};

export function storedModelUsageFromLocal(
  deviceId: string,
  usage: LocalModelUsageSnapshot,
): StoredDeviceModelUsage {
  return storedDeviceModelUsageSchema.parse({
    deviceId,
    version: 1,
    scannedAt: usage.scannedAt,
    scope: usage.scope,
    filesScanned: usage.filesScanned,
    truncated: usage.truncated,
    entries: usage.entries.map((entry) => ({
      toolId: entry.tool,
      modelId: entry.modelId,
      dataSource: entry.dataSource,
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      outputTokens: entry.outputTokens,
      requests: entry.requests,
      ...(entry.latestAt ? { latestAt: entry.latestAt } : {}),
    })),
  });
}

export function readStoredModelUsage(
  status: Pick<StatusDocument, "preferences">,
): StoredDeviceModelUsage[] {
  const snapshots: StoredDeviceModelUsage[] = [];
  for (const [key, value] of Object.entries(status.preferences)) {
    if (
      !key.startsWith(MODEL_USAGE_PREFERENCE_PREFIX) ||
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_STORED_USAGE_BYTES
    ) {
      continue;
    }
    try {
      const parsed = storedDeviceModelUsageSchema.safeParse(JSON.parse(value));
      if (parsed.success && modelUsagePreferenceKey(parsed.data.deviceId) === key) {
        snapshots.push(parsed.data);
      }
    } catch {
      // Corrupt internal preferences are ignored without blocking Status reads.
    }
  }
  return snapshots.sort((left, right) =>
    left.deviceId.localeCompare(right.deviceId),
  );
}

export function shouldStoreModelUsage(
  status: Pick<StatusDocument, "preferences">,
  next: StoredDeviceModelUsage,
  refreshIntervalMs: number,
  now = Date.now(),
): boolean {
  const previous = readStoredModelUsage(status).find(
    (entry) => entry.deviceId === next.deviceId,
  );
  if (!previous) return true;
  const age = now - Date.parse(previous.scannedAt);
  return !Number.isFinite(age) || Math.abs(age) >= refreshIntervalMs;
}

export function storeModelUsage(
  status: Pick<StatusDocument, "preferences">,
  usage: StoredDeviceModelUsage,
): void {
  status.preferences[modelUsagePreferenceKey(usage.deviceId)] =
    JSON.stringify(storedDeviceModelUsageSchema.parse(usage));
}

export function removeStoredModelUsage(
  status: Pick<StatusDocument, "preferences">,
  deviceId: string,
): void {
  delete status.preferences[modelUsagePreferenceKey(deviceId)];
}

export function modelUsagePreferenceKey(deviceId: string): string {
  return `${MODEL_USAGE_PREFERENCE_PREFIX}${deviceId}`;
}
