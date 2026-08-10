import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  await run("xattr", ["-dr", "com.apple.provenance", context.appOutDir]).catch(
    () => undefined,
  );
  await run("xattr", ["-cr", context.appOutDir]);
}
