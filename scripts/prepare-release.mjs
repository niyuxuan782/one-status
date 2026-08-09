import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deviceSidecarAssetNames } from "./device-sidecar-release.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;

execFileSync("pnpm", ["pack:local"], { cwd: root, stdio: "inherit" });

const artifactName = `one-status-${version}.tgz`;
const artifactPath = resolve(root, "dist", artifactName);
const digest = createHash("sha256")
  .update(await readFile(artifactPath))
  .digest("hex");
const releaseAssetNames = [
  `One-Status-${version}-linux-x64.AppImage`,
  `One-Status-${version}-linux-x64.deb`,
  `One-Status-${version}-mac-arm64.dmg`,
  `One-Status-${version}-mac-arm64.zip`,
  `One-Status-${version}-mac-x64.dmg`,
  `One-Status-${version}-mac-x64.zip`,
  `One-Status-Portable-${version}-windows-x64.exe`,
  `One-Status-Setup-${version}-windows-x64.exe`,
  ...deviceSidecarAssetNames(version),
  `one-status-${version}.tgz`,
  "one-status-cask.rb",
  "one-status.rb",
  "SHA256SUMS.txt",
];
const releaseBase =
  `https://github.com/niyuxuan782/one-status/releases/download/v${version}`;
const releaseManifest = {
  tag_name: `v${version}`,
  html_url:
    `https://github.com/niyuxuan782/one-status/releases/tag/v${version}`,
  assets: releaseAssetNames.map((name) => ({
    name,
    browser_download_url: `${releaseBase}/${name}`,
  })),
};
await writeFile(
  resolve(root, "apps", "site", "public", "release.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  "utf8",
);

console.log(`Prepared ${artifactName}`);
console.log(`sha256 ${digest}`);
