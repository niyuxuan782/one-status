import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceStore } from "./local-workspace.js";

describe("local workspace store", () => {
  let directory: string;
  let store: LocalWorkspaceStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "one-status-workspace-"));
    store = new LocalWorkspaceStore(join(directory, "workspace.sqlite"));
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists, updates, lists, and removes local project mappings", () => {
    const first = store.setMapping(
      "project-1",
      "/tmp/project-one",
      "/tmp/project-one",
    );
    const second = store.setMapping(
      "project-2",
      "/tmp/project-two",
      "/tmp/project-two",
    );

    expect(store.getMapping("project-1")).toEqual(first);
    expect(store.getProjectPath("project-1")).toMatchObject({
      projectId: "project-1",
      path: "/tmp/project-one",
    });
    expect(store.listMappings()).toEqual(expect.arrayContaining([first, second]));

    const updated = store.setMapping(
      "project-1",
      "/tmp/project-one-next",
      "/tmp/project-one-next",
    );
    expect(updated).toMatchObject({
      projectId: "project-1",
      path: "/tmp/project-one-next",
      repoRoot: "/tmp/project-one-next",
      createdAt: first.createdAt,
    });
    expect(store.deleteMapping("project-1")).toBe(true);
    expect(store.deleteMapping("project-1")).toBe(false);
    expect(store.getMapping("project-1")).toBeUndefined();

    expect(store.listActivity()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project_mapped",
          projectId: "project-1",
        }),
        expect.objectContaining({
          type: "project_unmapped",
          projectId: "project-1",
        }),
      ]),
    );
  });

  it("persists a non-Git project path independently from Handoff mapping", () => {
    const registered = store.setProjectPath(
      "notes-project",
      "/tmp/notes-project",
    );

    expect(store.getProjectPath("notes-project")).toEqual(registered);
    expect(store.getMapping("notes-project")).toBeUndefined();
    expect(store.listProjectPaths()).toContainEqual(registered);
    expect(store.listActivity(1)[0]).toMatchObject({
      type: "project_registered",
      projectId: "notes-project",
    });
  });
});
