import { createEmptyStatus, statusDocumentSchema } from "@one-status/protocol";
import { describe, expect, it } from "vitest";
import {
  modelUsagePreferenceKey,
  readStoredModelUsage,
  removeStoredModelUsage,
  shouldStoreModelUsage,
  storedModelUsageFromLocal,
  storeModelUsage,
} from "./model-usage.js";

const localUsage = {
  scannedAt: "2026-08-10T02:00:00.000Z",
  scope: "latest-100-session-files-per-tool",
  filesScanned: 4,
  truncated: false,
  entries: [
    {
      tool: "codex" as const,
      modelId: "gpt-5.4",
      dataSource: "codex-session" as const,
      inputTokens: 12_000,
      cachedInputTokens: 10_000,
      cacheCreationInputTokens: 0,
      outputTokens: 800,
      requests: 3,
      latestAt: "2026-08-10T01:59:00.000Z",
    },
  ],
  warnings: [],
};

describe("backward-compatible model usage storage", () => {
  it("round-trips through a preference that the v0.7 schema accepts", () => {
    const status = createEmptyStatus();
    const usage = storedModelUsageFromLocal("device-a", localUsage);
    storeModelUsage(status, usage);

    expect(statusDocumentSchema.parse(status)).toEqual(status);
    expect(readStoredModelUsage(status)).toEqual([usage]);
    removeStoredModelUsage(status, "device-a");
    expect(readStoredModelUsage(status)).toEqual([]);
  });

  it("ignores corrupt values and bounds refresh writes", () => {
    const status = createEmptyStatus();
    status.preferences[modelUsagePreferenceKey("broken")] = "{";
    const usage = storedModelUsageFromLocal("device-a", localUsage);

    expect(readStoredModelUsage(status)).toEqual([]);
    expect(shouldStoreModelUsage(status, usage, 300_000)).toBe(true);
    storeModelUsage(status, usage);
    expect(
      shouldStoreModelUsage(
        status,
        usage,
        300_000,
        Date.parse(localUsage.scannedAt) + 299_999,
      ),
    ).toBe(false);
    expect(
      shouldStoreModelUsage(
        status,
        usage,
        300_000,
        Date.parse(localUsage.scannedAt) + 300_000,
      ),
    ).toBe(true);
  });
});
