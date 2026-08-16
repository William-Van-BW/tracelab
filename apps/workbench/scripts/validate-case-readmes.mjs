import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pnpmRoot = path.join(repositoryRoot, "apps", "workbench", "node_modules", ".pnpm");
const ajvFolder = fs.readdirSync(pnpmRoot).find((name) => /^ajv@8\./.test(name));
if (!ajvFolder) throw new Error("Ajv 8 is unavailable; install web dependencies first.");
const Ajv2020 = (await import(pathToFileURL(path.join(pnpmRoot, ajvFolder, "node_modules", "ajv", "dist", "2020.js")))).default;
const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "spec", "agent-eval-trace.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(schema);

function collect(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(item, files);
    else if (entry.name === "case.json" || entry.name.endsWith(".case.json")) files.push(item);
  }
  return files;
}

const files = [
  ...collect(path.join(repositoryRoot, "case-library")),
  path.join(repositoryRoot, "spec", "templates", "manual-run-template", "case.json"),
  path.join(repositoryRoot, "spec", "examples", "example-run", "case.json"),
];
const failures = [];
for (const file of files) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!validate(value)) failures.push(`${path.relative(repositoryRoot, file)}: ${JSON.stringify(validate.errors)}`);
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(`Validated ${files.length} Case JSON files against AETF v0.4.0`);
