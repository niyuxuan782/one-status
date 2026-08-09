import { describe, expect, it } from "vitest";
import {
  builtInCapabilityPacks,
  getBuiltInCapabilityPack,
  listBuiltInCapabilityPacks,
} from "./catalog.js";

describe("built-in Capability Pack catalog", () => {
  it("publishes every live Permission Gateway catalog", () => {
    expect(builtInCapabilityPacks.map((pack) => pack.name)).toEqual([
      "google-workspace",
      "github-workflow",
      "slack-workspace",
      "microsoft-365",
      "notion-workspace",
      "dropbox-files",
      "zoom-meetings",
      "canva-design",
      "asana-work-management",
      "trello-boards",
      "airtable-bases",
      "linear-issues",
      "figma-design",
      "box-files",
    ]);
    expect(builtInCapabilityPacks.flatMap((pack) => pack.tools)).toHaveLength(69);
  });

  it("returns stable digests and exact pack lookup", () => {
    expect(listBuiltInCapabilityPacks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(getBuiltInCapabilityPack("google-workspace")?.tools).toHaveLength(10);
    expect(getBuiltInCapabilityPack("missing-pack")).toBeUndefined();
  });
});
