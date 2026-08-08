import { OneStatusClient, type SyncedStatusVault } from "@one-status/client";
import { importStatusKey } from "@one-status/crypto";
import type { McpRuntimeConfig, McpRuntimeConfigLoader } from "./config.js";
import type { Vault } from "./server.js";

export async function createRuntimeVault(
  config: McpRuntimeConfig,
): Promise<SyncedStatusVault> {
  const vault = instantiateRuntimeVault(config);
  await vault.read();
  return vault;
}

export function createReloadingRuntimeVault(
  loadConfig: McpRuntimeConfigLoader,
): Vault {
  const getVault = async (): Promise<SyncedStatusVault> => {
    return instantiateRuntimeVault(await loadConfig());
  };

  return {
    async read() {
      return (await getVault()).read();
    },
    async mutate(mutation, options) {
      return (await getVault()).mutate(mutation, options);
    },
  };
}

function instantiateRuntimeVault(
  config: McpRuntimeConfig,
): SyncedStatusVault {
  const client = new OneStatusClient({
    baseUrl: config.baseUrl,
    token: config.token,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  return client.createVault(importStatusKey(config.exportedKey));
}
