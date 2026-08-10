import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  await run("xattr", [
    "-dr",
    "com.apple.provenance",
    context.appOutDir,
  ]).catch(() => undefined);
  await run("xattr", ["-cr", context.appOutDir]);

  const { stdout } = await run("xattr", ["-lr", context.appOutDir]);
  const forbiddenAttributes = stdout
    .split("\n")
    .filter((line) => /com\.apple\.(ResourceFork|FinderInfo)(:|$)/.test(line));
  if (forbiddenAttributes.length > 0) {
    throw new Error(
      `macOS signing attributes remain after cleanup:\n${forbiddenAttributes.join("\n")}`,
    );
  }
}
