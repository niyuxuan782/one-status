import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;

execFileSync("pnpm", ["pack:local"], { cwd: root, stdio: "inherit" });

const artifactName = `one-status-${version}.tgz`;
const artifactPath = resolve(root, "dist", artifactName);
const digest = createHash("sha256")
  .update(await readFile(artifactPath))
  .digest("hex");
const formulaPath = resolve(root, "Formula", "one-status.rb");
let formula = await readFile(formulaPath, "utf8");
formula = formula
  .replace(/one-status-[\d.]+\.tgz/g, artifactName)
  .replace(
    /releases\/download\/v[\d.]+\//g,
    `releases/download/v${version}/`,
  )
  .replace(/sha256 "[a-f0-9]+"/, `sha256 "${digest}"`);
await writeFile(formulaPath, formula, "utf8");

console.log(`Prepared ${artifactName}`);
console.log(`sha256 ${digest}`);
