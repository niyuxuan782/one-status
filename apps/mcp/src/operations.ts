import { createHash, randomUUID } from "node:crypto";
import type { StatusDocument } from "@one-status/protocol";
import { z } from "zod";

const preferenceValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const statusMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_preference"),
    key: z.string().min(1),
    value: preferenceValueSchema,
  }),
  z.object({
    type: z.literal("append_memory"),
    scope: z.enum(["user", "project", "session"]),
    content: z.string().min(1),
    projectId: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    type: z.literal("upsert_project"),
    id: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().optional(),
    techStack: z.array(z.string().min(1)).optional(),
    currentGoal: z.string().optional(),
    decisions: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal("update_context"),
    currentContext: z.string().min(1),
    projectId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("upsert_task"),
    id: z.string().min(1),
    projectId: z.string().min(1).optional(),
    title: z.string().min(1),
    status: z.enum(["todo", "in_progress", "blocked", "done"]),
    completed: z.array(z.string()).default([]),
    next: z.array(z.string()).default([]),
  }),
]);

export type StatusMutation = z.infer<typeof statusMutationSchema>;

export function digestStatusMutation(mutationValue: StatusMutation): string {
  const mutation = statusMutationSchema.parse(mutationValue);
  return createHash("sha256")
    .update(JSON.stringify(mutation))
    .digest("base64url");
}

export function applyStatusMutation(
  status: StatusDocument,
  mutationValue: StatusMutation,
  agentId: string,
  now = new Date().toISOString(),
  id: string = randomUUID(),
): void {
  const mutation = statusMutationSchema.parse(mutationValue);

  switch (mutation.type) {
    case "set_preference":
      status.preferences[mutation.key] = mutation.value;
      break;
    case "append_memory":
      if (mutation.scope === "project" && !mutation.projectId) {
        throw new Error("projectId is required for project memory.");
      }
      status.memory.push({
        id,
        scope: mutation.scope,
        ...(mutation.projectId ? { projectId: mutation.projectId } : {}),
        content: mutation.content,
        tags: mutation.tags,
        createdAt: now,
        updatedAt: now,
      });
      break;
    case "upsert_project": {
      const previous = status.projects[mutation.id];
      status.projects[mutation.id] = {
        id: mutation.id,
        name: mutation.name,
        summary: mutation.summary ?? previous?.summary ?? "",
        techStack: mutation.techStack ?? previous?.techStack ?? [],
        currentGoal: mutation.currentGoal ?? previous?.currentGoal ?? "",
        decisions: mutation.decisions ?? previous?.decisions ?? [],
        ...(previous?.handoff ? { handoff: previous.handoff } : {}),
        updatedAt: now,
      };
      status.workspace.activeProjectId = mutation.id;
      break;
    }
    case "update_context":
      status.workspace.currentContext = mutation.currentContext;
      status.workspace.lastAgentId = agentId;
      if (mutation.projectId) {
        status.workspace.activeProjectId = mutation.projectId;
      }
      break;
    case "upsert_task":
      status.tasks[mutation.id] = {
        id: mutation.id,
        ...(mutation.projectId ? { projectId: mutation.projectId } : {}),
        title: mutation.title,
        status: mutation.status,
        completed: mutation.completed,
        next: mutation.next,
        updatedAt: now,
      };
      break;
  }
}
