import type { OAuthProvider } from "../permission-vault.js";
import type { ProviderExtension } from "../provider-extension.js";
import {
  boxProvider,
  dropboxProvider,
  notionProvider,
} from "./content-storage.js";
import { canvaProvider, figmaProvider } from "./design.js";
import { microsoftProvider } from "./microsoft.js";
import { trelloProvider } from "./trello.js";
import {
  airtableProvider,
  asanaProvider,
  linearProvider,
  zoomProvider,
} from "./work-management.js";

export const providerExtensions: readonly ProviderExtension[] = [
  microsoftProvider,
  notionProvider,
  dropboxProvider,
  zoomProvider,
  canvaProvider,
  asanaProvider,
  trelloProvider,
  airtableProvider,
  linearProvider,
  figmaProvider,
  boxProvider,
];

export const providerExtensionById = new Map<OAuthProvider, ProviderExtension>(
  providerExtensions.map((provider) => [provider.id, provider]),
);

export const providerExtensionCatalog = Object.fromEntries(
  providerExtensions.map((provider) => [provider.id, provider.definition]),
);

export function requireProviderExtension(
  provider: OAuthProvider,
): ProviderExtension {
  const extension = providerExtensionById.get(provider);
  if (!extension) throw new Error(`Unsupported OAuth provider: ${provider}`);
  return extension;
}
