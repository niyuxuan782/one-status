import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const [assetsArgument, outputArgument] = process.argv.slice(2);
if (!assetsArgument || !outputArgument) {
  throw new Error(
    "Usage: node scripts/generate-homebrew-cask.mjs <assets-directory> <output-file>",
  );
}

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const version = packageJson.version;
const assetsDirectory = resolve(assetsArgument);
const outputPath = resolve(outputArgument);

const armName = `One-Status-${version}-mac-arm64.dmg`;
const intelName = `One-Status-${version}-mac-x64.dmg`;
const armSha = await sha256(resolve(assetsDirectory, armName));
const intelSha = await sha256(resolve(assetsDirectory, intelName));
const cask = `cask "one-status" do
  version "${version}"

  on_arm do
    sha256 "${armSha}"

    url "https://github.com/niyuxuan782/one-status/releases/download/v#{version}/One-Status-#{version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "${intelSha}"

    url "https://github.com/niyuxuan782/one-status/releases/download/v#{version}/One-Status-#{version}-mac-x64.dmg"
  end

  name "One Status"
  desc "Manage AI tools, encrypted credentials, memory, and work state"
  homepage "https://niyuxuan782.github.io/one-status/"

  depends_on :macos

  app "one-status.app", target: "One Status.app"
end
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, cask, "utf8");
console.log(`Generated ${basename(outputPath)} for One Status ${version}.`);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
