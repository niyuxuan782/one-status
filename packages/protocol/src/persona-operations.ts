import { randomUUID } from "node:crypto";
import {
  personaCategorySchema,
  personaConfidenceSchema,
  type PersonaEvent,
  type PersonaPolicy,
  type PersonaProfileEntry,
  type StatusDocument,
} from "./index.js";
import { z } from "zod";

const timestampSchema = z.iso.datetime({ offset: true });

export const personaRecordInputSchema = z
  .object({
    category: personaCategorySchema,
    content: z.string().trim().min(1).max(10_000),
    observedAt: timestampSchema.optional(),
    sourceProject: z.string().min(1).max(200).optional(),
    confidence: personaConfidenceSchema,
  })
  .strict();

export const personaUpdateInputSchema = z
  .object({
    id: z.string().min(1).max(200),
    category: personaCategorySchema.optional(),
    content: z.string().trim().min(1).max(10_000).optional(),
    confidence: personaConfidenceSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.category !== undefined ||
      input.content !== undefined ||
      input.confidence !== undefined,
    { message: "At least one Persona field must be updated." },
  );

export const personaPolicyInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    blockedCategories: z.array(personaCategorySchema).max(200).optional(),
    allowedConfidences: z
      .array(personaConfidenceSchema)
      .min(1)
      .max(personaConfidenceSchema.options.length)
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.enabled !== undefined ||
      input.blockedCategories !== undefined ||
      input.allowedConfidences !== undefined,
    { message: "At least one Persona policy field must be supplied." },
  );

export type PersonaRecordInput = z.infer<typeof personaRecordInputSchema>;
export type PersonaUpdateInput = z.infer<typeof personaUpdateInputSchema>;
export type PersonaPolicyInput = z.infer<typeof personaPolicyInputSchema>;

export interface PersonaRecordResult {
  event: PersonaEvent;
  created: boolean;
  observationAdded: boolean;
}

export function recordPersonaEvent(
  status: StatusDocument,
  inputValue: PersonaRecordInput,
  sourceAgent: string,
  now = new Date().toISOString(),
  eventId: string = randomUUID(),
): PersonaRecordResult {
  const input = personaRecordInputSchema.parse(inputValue);
  assertPersonaRecordingAllowed(status.persona.policy, input);
  assertPersonaContentIsSafe(input.content);
  const observedAt = input.observedAt ?? now;
  const normalizedContent = normalizePersonaContent(input.content);
  let event = status.persona.events.find(
    (candidate) =>
      candidate.category === input.category &&
      normalizePersonaContent(candidate.content) === normalizedContent,
  );
  const created = event === undefined;
  if (!event) {
    if (status.persona.events.some((candidate) => candidate.id === eventId)) {
      throw new Error(`Persona event ID already exists: ${eventId}`);
    }
    const observation = {
      observedAt,
      sourceAgent,
      ...(input.sourceProject ? { sourceProject: input.sourceProject } : {}),
      confidence: input.confidence,
    };
    event = {
      id: eventId,
      category: input.category,
      content: input.content,
      observedAt,
      lastObservedAt: observedAt,
      observationCount: 1,
      observations: [observation],
      sourceAgent,
      ...(input.sourceProject ? { sourceProject: input.sourceProject } : {}),
      confidence: input.confidence,
      updatedAt: now,
    };
    status.persona.events.push(event);
    rebuildPersonaProfile(status, now);
    return { event, created: true, observationAdded: true };
  }

  const observation = {
    observedAt,
    sourceAgent,
    ...(input.sourceProject ? { sourceProject: input.sourceProject } : {}),
    confidence: input.confidence,
  };
  const observationAdded = !event.observations.some(
    (existing) =>
      existing.observedAt === observation.observedAt &&
      existing.sourceAgent === observation.sourceAgent &&
      existing.sourceProject === observation.sourceProject &&
      existing.confidence === observation.confidence,
  );
  if (observationAdded) {
    event.observations.push(observation);
    refreshPersonaEvent(event, now);
    rebuildPersonaProfile(status, now);
  }
  return { event, created, observationAdded };
}

export function updatePersonaEvent(
  status: StatusDocument,
  inputValue: PersonaUpdateInput,
  now = new Date().toISOString(),
): PersonaEvent {
  const input = personaUpdateInputSchema.parse(inputValue);
  const event = status.persona.events.find((candidate) => candidate.id === input.id);
  if (!event) throw new Error(`Persona event was not found: ${input.id}`);
  const category = input.category ?? event.category;
  const content = input.content ?? event.content;
  const confidence = input.confidence ?? event.confidence;
  if (input.content !== undefined) assertPersonaContentIsSafe(content);

  event.category = category;
  event.content = content;
  if (input.confidence !== undefined) {
    event.confidence = confidence;
    event.observations = event.observations.map((observation, index) =>
      index === 0 ? { ...observation, confidence } : observation,
    );
  }
  event.updatedAt = now;

  const duplicate = status.persona.events.find(
    (candidate) =>
      candidate.id !== event.id &&
      candidate.category === event.category &&
      normalizePersonaContent(candidate.content) ===
        normalizePersonaContent(event.content),
  );
  if (duplicate) {
    duplicate.observations.push(...event.observations);
    refreshPersonaEvent(duplicate, now);
    status.persona.events = status.persona.events.filter(
      (candidate) => candidate.id !== event.id,
    );
    rebuildPersonaProfile(status, now);
    return duplicate;
  }

  refreshPersonaEvent(event, now);
  rebuildPersonaProfile(status, now);
  return event;
}

export function deletePersonaEvent(
  status: StatusDocument,
  eventId: string,
  now = new Date().toISOString(),
): PersonaEvent {
  const event = status.persona.events.find((candidate) => candidate.id === eventId);
  if (!event) throw new Error(`Persona event was not found: ${eventId}`);
  status.persona.events = status.persona.events.filter(
    (candidate) => candidate.id !== eventId,
  );
  rebuildPersonaProfile(status, now);
  return event;
}

export function setPersonaPolicy(
  status: StatusDocument,
  inputValue: PersonaPolicyInput,
  now = new Date().toISOString(),
): PersonaPolicy {
  const input = personaPolicyInputSchema.parse(inputValue);
  const previous = status.persona.policy;
  status.persona.policy = {
    enabled: input.enabled ?? previous.enabled,
    blockedCategories: uniqueSorted(
      input.blockedCategories ?? previous.blockedCategories,
    ),
    allowedConfidences: uniqueSorted(
      input.allowedConfidences ?? previous.allowedConfidences,
    ),
    updatedAt: now,
  };
  return status.persona.policy;
}

export function rebuildPersonaProfile(
  status: StatusDocument,
  now = new Date().toISOString(),
): void {
  const profile: Record<string, PersonaProfileEntry> = {};
  for (const event of status.persona.events) {
    const current = profile[event.category];
    if (current && comparePersonaEventToProfile(event, current) <= 0) continue;
    profile[event.category] = {
      category: event.category,
      content: event.content,
      confidence: strongestConfidence(event),
      sourceEventIds: [event.id],
      firstObservedAt: event.observedAt,
      lastObservedAt: event.lastObservedAt,
      observationCount: event.observationCount,
      updatedAt: now,
    };
  }
  status.persona.profile = profile;
}

export function normalizePersonaContent(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function assertPersonaContentIsSafe(content: string): void {
  const secretPatterns = [
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
    /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|password|client[ _-]?secret|private[ _-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    throw new Error(
      "Persona content looks like a credential or private key and was rejected.",
    );
  }
}

function assertPersonaRecordingAllowed(
  policy: PersonaPolicy,
  input: { category: string; confidence: PersonaRecordInput["confidence"] },
): void {
  if (!policy.enabled) {
    throw new Error("Persona recording is disabled by the user.");
  }
  if (policy.blockedCategories.includes(input.category)) {
    throw new Error(`Persona category is blocked by the user: ${input.category}`);
  }
  if (!policy.allowedConfidences.includes(input.confidence)) {
    throw new Error(
      `Persona confidence is disabled by the user: ${input.confidence}`,
    );
  }
}

function refreshPersonaEvent(event: PersonaEvent, now: string): void {
  event.observations.sort((left, right) =>
    compareTimestamps(left.observedAt, right.observedAt) ||
    left.sourceAgent.localeCompare(right.sourceAgent) ||
    (left.sourceProject ?? "").localeCompare(right.sourceProject ?? "") ||
    left.confidence.localeCompare(right.confidence),
  );
  event.observations = event.observations.filter(
    (observation, index, observations) =>
      index === 0 ||
      !sameObservation(observation, observations[index - 1]!),
  );
  const first = event.observations[0]!;
  const last = event.observations[event.observations.length - 1]!;
  event.observedAt = first.observedAt;
  event.lastObservedAt = last.observedAt;
  event.observationCount = event.observations.length;
  event.sourceAgent = first.sourceAgent;
  if (first.sourceProject) event.sourceProject = first.sourceProject;
  else delete event.sourceProject;
  event.confidence = first.confidence;
  event.updatedAt = now;
}

function sameObservation(
  left: PersonaEvent["observations"][number],
  right: PersonaEvent["observations"][number],
): boolean {
  return (
    left.observedAt === right.observedAt &&
    left.sourceAgent === right.sourceAgent &&
    left.sourceProject === right.sourceProject &&
    left.confidence === right.confidence
  );
}

function comparePersonaEventToProfile(
  event: PersonaEvent,
  profile: PersonaProfileEntry,
): number {
  const byTime = compareTimestamps(
    event.lastObservedAt,
    profile.lastObservedAt,
  );
  if (byTime !== 0) return byTime;
  return event.id.localeCompare(profile.sourceEventIds[0] ?? "");
}

function compareTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function strongestConfidence(event: PersonaEvent): PersonaEvent["confidence"] {
  if (
    event.observations.some(
      (observation) => observation.confidence === "explicit",
    )
  ) {
    return "explicit";
  }
  if (
    event.observations.some(
      (observation) => observation.confidence === "observed",
    )
  ) {
    return "observed";
  }
  return "inferred";
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
