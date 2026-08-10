import type { ModelDefinition, ModelSource } from "@one-status/protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeviceSidecarCommandError,
  SidecarModelConfigurationAdapter,
  SidecarModelUsageReader,
  resolveDeviceSidecarExecutable,
  type SidecarCommand,
  type DeviceSidecarRunner,
} from "./device-sidecar.js";

const source: ModelSource = {
  id: "third-party:a",
  label: "Third-party A",
  kind: "compatible-api",
  protocol: "openai",
  endpoint: "https://api.example.test/v1",
  supportedTools: ["codex"],
  credentialRef: "model-source:third-party:a",
  credentialStatus: "available",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};
const model: ModelDefinition = {
  id: "third-party:a:model:1",
  sourceId: source.id,
  name: "GPT-5.4",
  modelId: "gpt-5.4",
  supportedTools: ["codex"],
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};
const planId = `plan_${"a".repeat(64)}`;
const planTarget = {
  purpose: "tool-configuration",
  path: "/tmp/config.toml",
  existed: true,
  beforeSha256: "b".repeat(64),
  afterSha256: "c".repeat(64),
  beforeMode: 0o640,
  afterMode: 0o600,
};
const previewResult = {
  planId,
  tool: "codex",
  profile: {},
  targets: [planTarget],
  changes: [],
  warnings: [],
};

describe("SidecarModelConfigurationAdapter", () => {
  it("discovers a Sidecar installed beside the CLI entrypoint", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "one-status-sidecar-path-"));
    try {
      const executable = process.platform === "win32"
        ? "one-status-device-sidecar.exe"
        : "one-status-device-sidecar";
      const sidecarPath = resolve(directory, executable);
      await writeFile(sidecarPath, "fixture");
      expect(resolveDeviceSidecarExecutable(
        {},
        resolve(directory, process.platform === "win32" ? "one-status.js" : "one-status"),
      )).toBe(sidecarPath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("passes only a Vault environment reference through sidecar JSON", async () => {
    const calls: Array<{
      command: string;
      environment?: NodeJS.ProcessEnv;
      input: unknown;
    }> = [];
    const runner: DeviceSidecarRunner = {
      async run<T>(
        command: SidecarCommand,
        input: unknown,
        environment?: NodeJS.ProcessEnv,
      ): Promise<T> {
        calls.push({ command, input, environment });
        if (command === "preview") return previewResult as T;
        return {
          planId,
          state: "applied",
          transactionId: "tx-12345678901234567890",
          tool: "codex",
          targets: [planTarget],
        } as T;
      },
    };
    const adapter = new SidecarModelConfigurationAdapter({ runner });
    const result = await adapter.apply({
      apiKey: "secret-never-in-json",
      model,
      source,
      toolId: "codex",
    });

    expect(result).toMatchObject({
      planId,
      transactionId: "tx-12345678901234567890",
    });
    expect(calls.map((call) => call.command)).toEqual(["preview", "apply"]);
    for (const call of calls) {
      const serialized = JSON.stringify(call.input);
      expect(serialized).not.toContain("secret-never-in-json");
      expect(serialized).not.toContain("apiKey");
      expect(serialized).toContain("credentialEnvVar");
      expect(Object.values(call.environment ?? {})).toContain(
        "secret-never-in-json",
      );
    }
    expect(calls[1]?.input).toMatchObject({ expectedPlanId: planId });
  });

  it("propagates confirmed automatic rollback state", async () => {
    const runner: DeviceSidecarRunner = {
      async run<T>(command: SidecarCommand): Promise<T> {
        if (command === "preview") return previewResult as T;
        throw new DeviceSidecarCommandError(
          "apply_failed_rolled_back",
          "The configuration write failed and was rolled back.",
          true,
        );
      },
    };
    const adapter = new SidecarModelConfigurationAdapter({ runner });
    await expect(
      adapter.apply({ model, source, toolId: "codex", apiKey: "secret" }),
    ).rejects.toMatchObject({ rolledBack: true });
  });

  it("returns a redacted local file plan before confirmation", async () => {
    const runner: DeviceSidecarRunner = {
      async run<T>(): Promise<T> {
        return {
          ...previewResult,
          changes: [
            {
              path: "model_providers.one-status.experimental_bearer_token",
              operation: "update",
              before: "<redacted>",
              after: "<redacted>",
              sensitive: true,
            },
          ],
        } as T;
      },
    };
    const adapter = new SidecarModelConfigurationAdapter({ runner });
    await expect(
      adapter.preview({ model, source, toolId: "codex", apiKey: "secret" }),
    ).resolves.toMatchObject({
      planId,
      requiresRestart: true,
      targets: [
        expect.objectContaining({ beforeMode: 0o640, afterMode: 0o600 }),
      ],
      changes: [expect.objectContaining({ sensitive: true })],
    });
  });
});

describe("SidecarModelUsageReader", () => {
  it("validates and caches redacted model aggregates", async () => {
    let calls = 0;
    const runner: DeviceSidecarRunner = {
      async run<T>(command: SidecarCommand): Promise<T> {
        calls += 1;
        expect(command).toBe("usage");
        return {
          scannedAt: "2026-08-10T02:00:00Z",
          scope: "latest-100-session-files-per-tool",
          filesScanned: 2,
          truncated: false,
          entries: [
            {
              tool: "codex",
              modelId: "gpt-5.4",
              dataSource: "codex-session",
              inputTokens: 100,
              cachedInputTokens: 80,
              cacheCreationInputTokens: 0,
              outputTokens: 20,
              requests: 1,
              latestAt: "2026-08-10T01:59:00Z",
            },
          ],
          warnings: [],
        } as T;
      },
    };
    const reader = new SidecarModelUsageReader({ runner, cacheTtlMs: 60_000 });

    const [first, second] = await Promise.all([reader.scan(), reader.scan()]);

    expect(first).toEqual(second);
    expect(first.entries[0]).toMatchObject({
      modelId: "gpt-5.4",
      inputTokens: 100,
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(first)).not.toContain("message");
  });

  it("drops an invalid session timestamp without blocking usage sync", async () => {
    const runner: DeviceSidecarRunner = {
      async run<T>(): Promise<T> {
        return {
          scannedAt: "2026-08-10T02:00:00Z",
          scope: "latest-100-session-files-per-tool",
          filesScanned: 1,
          truncated: false,
          entries: [
            {
              tool: "claude-code",
              modelId: "claude-opus",
              dataSource: "claude-session",
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 20,
              requests: 1,
              latestAt: "not-a-timestamp",
            },
          ],
          warnings: [],
        } as T;
      },
    };

    const usage = await new SidecarModelUsageReader({ runner }).scan();
    expect(usage.entries[0]?.latestAt).toBeUndefined();
  });
});
