import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  capabilityPackManifestSchema,
  type CapabilityPackManifest,
} from "./manifest.js";

export const MAX_CAPABILITY_PACK_DOCUMENT_BYTES = 1024 * 1024;

export const capabilityPackDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);

export type CapabilityPackDigest = z.infer<
  typeof capabilityPackDigestSchema
>;
export type CapabilityPackDocumentFormat = "auto" | "json" | "yaml";

export function parseCapabilityPackDocument(
  source: string,
  format: CapabilityPackDocumentFormat = "auto",
): CapabilityPackManifest {
  if (!source.trim()) {
    throw new Error("Capability Pack document is empty.");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_CAPABILITY_PACK_DOCUMENT_BYTES) {
    throw new Error("Capability Pack document exceeds the 1 MB limit.");
  }

  const resolvedFormat =
    format === "auto"
      ? source.trimStart().startsWith("{")
        ? "json"
        : "yaml"
      : format;
  const value =
    resolvedFormat === "json" ? parseJson(source) : parseYaml(source);
  return capabilityPackManifestSchema.parse(value);
}

export function canonicalCapabilityPackJson(value: unknown): string {
  const manifest = capabilityPackManifestSchema.parse(value);
  return JSON.stringify(sortJsonValue(manifest));
}

export function computeCapabilityPackDigest(
  value: unknown,
): CapabilityPackDigest {
  const digest = createHash("sha256")
    .update(canonicalCapabilityPackJson(value), "utf8")
    .digest("hex");
  return capabilityPackDigestSchema.parse(`sha256:${digest}`);
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Capability Pack JSON is invalid.", { cause: error });
  }
}

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`Capability Pack YAML is invalid: ${document.errors[0]}`);
  }
  try {
    return document.toJS({ maxAliasCount: 20 }) as unknown;
  } catch (error) {
    throw new Error("Capability Pack YAML aliases exceed the safety limit.", {
      cause: error,
    });
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
  );
}
