import { describe, expect, it } from "vitest";
import { booleanFlag, parseArguments } from "./arguments.js";

describe("CLI arguments", () => {
  it("accepts the standalone publish confirmation", () => {
    const parsed = parseArguments([
      "handoff",
      "--project",
      "one-status",
      "--agent",
      "claude-code",
      "--publish",
    ]);

    expect(parsed.command).toBe("handoff");
    expect(parsed.flags.get("project")).toBe("one-status");
    expect(parsed.flags.get("agent")).toBe("claude-code");
    expect(booleanFlag(parsed.flags, "publish")).toBe(true);
  });

  it("keeps required value flags strict", () => {
    expect(() => parseArguments(["handoff", "--project", "--publish"])).toThrow(
      "Expected --flag value near --project.",
    );
  });

  it("supports an explicit false boolean value", () => {
    const parsed = parseArguments(["handoff", "--publish", "false"]);
    expect(booleanFlag(parsed.flags, "publish")).toBe(false);
  });

  it("rejects invalid boolean values", () => {
    const parsed = parseArguments(["handoff", "--publish", "yes"]);
    expect(() => booleanFlag(parsed.flags, "publish")).toThrow(
      "--publish must be true or false.",
    );
  });

  it("parses a capability subcommand before strict flags", () => {
    const parsed = parseArguments([
      "capability",
      "preview",
      "--pack",
      "google-workspace",
      "--target",
      "codex",
    ]);
    expect(parsed).toMatchObject({
      command: "capability",
      subcommand: "preview",
    });
    expect(parsed.flags.get("pack")).toBe("google-workspace");
  });
});
