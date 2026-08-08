import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
const MAX_ACTIVITY_EVENTS = 500;

export interface LocalProjectMapping {
  createdAt: string;
  path: string;
  projectId: string;
  repoRoot: string;
  updatedAt: string;
}

export interface LocalActivityEvent {
  createdAt: string;
  id: string;
  projectId?: string;
  summary: string;
  type:
    | "handoff_opened"
    | "handoff_published"
    | "handoff_written"
    | "project_mapped"
    | "project_unmapped";
}

interface MappingRow {
  created_at: string;
  path: string;
  project_id: string;
  repo_root: string;
  updated_at: string;
}

interface ActivityRow {
  created_at: string;
  id: string;
  project_id: string | null;
  summary: string;
  type: LocalActivityEvent["type"];
}

export class LocalWorkspaceStore {
  readonly #database: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (created) chmodSync(directory, 0o700);
    }
    const { DatabaseSync } = nodeRequire(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    this.#database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS local_project_mappings (
        project_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_activity_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        project_id TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS local_activity_created
        ON local_activity_events(created_at DESC);
    `);
  }

  close(): void {
    this.#database.close();
  }

  getMapping(projectId: string): LocalProjectMapping | undefined {
    const row = this.#database
      .prepare("SELECT * FROM local_project_mappings WHERE project_id = ?")
      .get(projectId) as unknown as MappingRow | undefined;
    return row ? toMapping(row) : undefined;
  }

  listMappings(): LocalProjectMapping[] {
    const rows = this.#database
      .prepare("SELECT * FROM local_project_mappings ORDER BY updated_at DESC")
      .all() as unknown as MappingRow[];
    return rows.map(toMapping);
  }

  setMapping(projectId: string, path: string, repoRoot: string): LocalProjectMapping {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO local_project_mappings
           (project_id, path, repo_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           path = excluded.path,
           repo_root = excluded.repo_root,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, path, repoRoot, now, now);
    this.recordActivity({
      type: "project_mapped",
      projectId,
      summary: "Local project checkout mapped.",
    });
    return this.getMapping(projectId)!;
  }

  deleteMapping(projectId: string): boolean {
    const result = this.#database
      .prepare("DELETE FROM local_project_mappings WHERE project_id = ?")
      .run(projectId);
    const deleted = Number(result.changes) > 0;
    if (deleted) {
      this.recordActivity({
        type: "project_unmapped",
        projectId,
        summary: "Local project checkout unmapped.",
      });
    }
    return deleted;
  }

  listActivity(limit = 50): LocalActivityEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM local_activity_events
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as unknown as ActivityRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }

  recordActivity(input: {
    projectId?: string;
    summary: string;
    type: LocalActivityEvent["type"];
  }): void {
    this.#database
      .prepare(
        `INSERT INTO local_activity_events
           (id, type, project_id, summary, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.type,
        input.projectId ?? null,
        input.summary,
        new Date().toISOString(),
      );
    this.#database
      .prepare(
        `DELETE FROM local_activity_events
         WHERE id IN (
           SELECT id FROM local_activity_events
           ORDER BY created_at DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(MAX_ACTIVITY_EVENTS);
  }
}

function toMapping(row: MappingRow): LocalProjectMapping {
  return {
    projectId: row.project_id,
    path: row.path,
    repoRoot: row.repo_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
