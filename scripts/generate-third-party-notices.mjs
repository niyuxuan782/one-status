import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, "dist", "THIRD_PARTY_NOTICES.txt");
const report = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
  }),
);

const packages = new Map();
for (const [reportedLicense, groups] of Object.entries(report)) {
  for (const group of groups) {
    for (const packagePath of group.paths) {
      const metadata = JSON.parse(
        await readFile(resolve(packagePath, "package.json"), "utf8"),
      );
      const key = `${metadata.name}@${metadata.version}`;
      if (packages.has(key)) continue;
      packages.set(key, {
        homepage: metadata.homepage ?? group.homepage,
        key,
        license: metadata.license ?? reportedLicense,
        licenseText: await readLicenseText(packagePath),
        repository: normalizeRepository(metadata.repository),
      });
    }
  }
}

const sections = [
  "One Status third-party software notices",
  "",
  "The One Status executable bundles the packages listed below. Their license",
  "terms remain applicable to their respective software.",
];

for (const dependency of [...packages.values()].sort((a, b) =>
  a.key.localeCompare(b.key),
)) {
  sections.push(
    "",
    "=".repeat(80),
    dependency.key,
    `License: ${formatLicense(dependency.license)}`,
  );
  if (dependency.homepage) sections.push(`Homepage: ${dependency.homepage}`);
  if (dependency.repository) sections.push(`Source: ${dependency.repository}`);
  sections.push("-".repeat(80));
  sections.push(
    dependency.licenseText ??
      "No standalone license file was included in the installed package. See the package metadata and source repository listed above.",
  );
}

await writeFile(outputPath, `${sections.join("\n").trimEnd()}\n`, "utf8");
console.log(`Generated ${packages.size} third-party notices at ${outputPath}`);

async function readLicenseText(packagePath) {
  const files = await readdir(packagePath);
  const licenseFile = files
    .filter((file) => /^(license|licence|copying|notice)(\..*)?$/i.test(file))
    .sort((a, b) => licenseFileRank(a) - licenseFileRank(b))[0];
  return licenseFile
    ? (await readFile(resolve(packagePath, licenseFile), "utf8")).trim()
    : undefined;
}

function licenseFileRank(file) {
  if (/^licen[cs]e$/i.test(file)) return 0;
  if (/^licen[cs]e\.(md|txt)$/i.test(file)) return 1;
  return 2;
}

function normalizeRepository(repository) {
  if (typeof repository === "string") return repository;
  return repository?.url;
}

function formatLicense(license) {
  if (typeof license === "string") return license;
  return JSON.stringify(license);
}
