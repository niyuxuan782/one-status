import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [source, destination, artifact] = process.argv.slice(2);
if (!source || !destination || !artifact) {
  throw new Error(
    "Usage: node make-local-formula.mjs <source> <destination> <artifact>",
  );
}

const formula = await readFile(source, "utf8");
const localFormula = formula.replace(
  /^  url "[^"]+"$/m,
  `  url "${pathToFileURL(artifact).href}"`,
);
if (localFormula === formula) {
  throw new Error("Formula URL line was not found.");
}
await writeFile(destination, localFormula, "utf8");

