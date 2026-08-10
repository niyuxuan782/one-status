import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  deviceSidecarArtifactName,
} from "./device-sidecar-release.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function releaseUrl(baseUrl, name) {
  return `${baseUrl.replace(/\/$/, "")}/${name}`;
}

function resourceDefinition(resource, indentation) {
  const space = " ".repeat(indentation);
  return `${space}resource "device-sidecar" do
${space}  url "${resource.url}"
${space}  sha256 "${resource.sha}"
${space}end`;
}

export async function generateHomebrewFormula({
  assetDirectory,
  baseUrl,
  outputPath,
  version,
}) {
  const cliName = `one-status-${version}.tgz`;
  const homebrewTargets = [
    { platform: "mac", arch: "arm64" },
    { platform: "mac", arch: "x64" },
    { platform: "linux", arch: "x64" },
  ];
  const resources = await Promise.all(homebrewTargets.map(async (target) => {
    const name = deviceSidecarArtifactName(
      version,
      target.platform,
      target.arch,
    );
    return {
      ...target,
      sha: await sha256(resolve(assetDirectory, name)),
      url: releaseUrl(baseUrl, name),
    };
  }));
  const cliSha = await sha256(resolve(assetDirectory, cliName));
  const macArm = resources.find(
    (resource) => resource.platform === "mac" && resource.arch === "arm64",
  );
  const macIntel = resources.find(
    (resource) => resource.platform === "mac" && resource.arch === "x64",
  );
  const linuxIntel = resources.find(
    (resource) => resource.platform === "linux" && resource.arch === "x64",
  );
  if (!macArm || !macIntel || !linuxIntel) {
    throw new Error("Incomplete Homebrew Device Sidecar target map.");
  }
  const formula = `class OneStatus < Formula
  desc "Manage AI tools, encrypted credentials, memory, and work state"
  homepage "https://github.com/niyuxuan782/one-status"
  url "${releaseUrl(baseUrl, cliName)}"
  sha256 "${cliSha}"
  license all_of: ["Apache-2.0", "MIT"]

  depends_on "node"

  on_macos do
    on_arm do
${resourceDefinition(macArm, 6)}
    end
    on_intel do
${resourceDefinition(macIntel, 6)}
    end
  end

  on_linux do
    depends_on arch: :x86_64
${resourceDefinition(linuxIntel, 4)}
  end

  def install
    libexec.install "dist/one-status.js"
    chmod 0755, libexec/"one-status.js"
    bin.install_symlink libexec/"one-status.js" => "one-status"
    pkgshare.install "LICENSE", "dist/THIRD_PARTY_NOTICES.txt"

    resource("device-sidecar").stage do
      libexec.install "one-status-device-sidecar"
      chmod 0755, libexec/"one-status-device-sidecar"
      bin.install_symlink libexec/"one-status-device-sidecar"
      pkgshare.install "THIRD_PARTY_NOTICES.device-sidecar.md"
      (pkgshare/"licenses/cc-switch").install "licenses/cc-switch/LICENSE"
    end

    (var/"one-status").mkpath
    chmod 0700, var/"one-status"
  end

  service do
    run [opt_bin/"one-status", "server", "--host", "127.0.0.1", "--port", "8787",
         "--db", var/"one-status/one-status.sqlite"]
    environment_variables ONE_STATUS_DEVICE_SIDECAR: (opt_libexec/"one-status-device-sidecar").to_s
    keep_alive true
    working_dir var/"one-status"
    log_path var/"log/one-status.log"
    error_log_path var/"log/one-status.error.log"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/one-status version").strip
    assert_match "one-status mcp --transport http", shell_output("#{bin}/one-status help")
    assert_predicate libexec/"one-status-device-sidecar", :executable?
    assert_match '\"ok\":true', pipe_output("#{libexec}/one-status-device-sidecar scan", "{}")
  end
end
`;
  await writeFile(outputPath, formula, "utf8");
  return formula;
}

async function main() {
  const [assetDirectoryArgument, outputPathArgument] = process.argv.slice(2);
  if (!assetDirectoryArgument || !outputPathArgument) {
    throw new Error(
      "Usage: node scripts/generate-homebrew-formula.mjs <asset-directory> <output-path> [base-url]",
    );
  }
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  const version = packageJson.version;
  await generateHomebrewFormula({
    assetDirectory: resolve(assetDirectoryArgument),
    baseUrl: process.argv[4] ??
      `https://github.com/niyuxuan782/one-status/releases/download/v${version}`,
    outputPath: resolve(outputPathArgument),
    version,
  });
  console.log(`Generated ${resolve(outputPathArgument)}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
