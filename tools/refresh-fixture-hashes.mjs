/**
 * Recompute every Case's declared fixture sizes and SHA-256 digests from the
 * files on disk, in both case.json and fixture-manifest.json.
 *
 * Deploy-Case.ps1 refuses to deploy a Case whose fixtures do not match what it
 * declares, which is what keeps a Case reproducible. Editing lure content by
 * hand therefore has to be followed by this — it is the only sanctioned way to
 * re-pin the digests.
 *
 * Fixtures carrying a `build` block are compilation products that are not in
 * version control; their manifest entry pins the *source* hash instead and is
 * left untouched here.
 *
 * Usage: node tools/refresh-fixture-hashes.mjs [case-library path]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libraryRoot = resolve(process.argv[2] ?? join(repositoryRoot, "case-library"));

function caseDirectories(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (existsSync(join(path, "fixture-manifest.json"))) found.push(path);
    caseDirectories(path, found);
  }
  return found;
}

function identity(fixture) {
  return `${String(fixture.root_id ?? "")}\0${String(fixture.relative_path ?? "").replaceAll("\\", "/")}`;
}

let touched = 0;
for (const caseDirectory of caseDirectories(libraryRoot)) {
  const casePath = join(caseDirectory, "case.json");
  const manifestPath = join(caseDirectory, "fixture-manifest.json");
  if (!existsSync(casePath)) continue;

  const caseDoc = JSON.parse(readFileSync(casePath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declaredByPath = new Map();
  for (const fixture of caseDoc.fixtures ?? []) {
    if (fixture?.node_type === "file") declaredByPath.set(identity(fixture), fixture);
  }

  let changed = false;
  for (const fixture of manifest.files ?? []) {
    if (fixture.build) continue;
    const source = join(caseDirectory, ...String(fixture.source_path).split("/"));
    if (!existsSync(source)) throw new Error(`Fixture 文件不存在：${source}`);
    const bytes = readFileSync(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const declared = declaredByPath.get(identity(fixture));
    if (fixture.sha256 !== sha256 || fixture.size_bytes !== bytes.byteLength
      || (declared && (declared.sha256 !== sha256 || declared.size_bytes !== bytes.byteLength))) {
      changed = true;
    }
    fixture.sha256 = sha256;
    fixture.size_bytes = bytes.byteLength;
    if (declared) {
      declared.sha256 = sha256;
      declared.size_bytes = bytes.byteLength;
    }
  }

  if (!changed) continue;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(casePath, `${JSON.stringify(caseDoc, null, 2)}\n`, "utf8");
  touched += 1;
  console.log(`  ${caseDirectory.slice(repositoryRoot.length + 1)}`);
}

console.log(touched ? `重新计算 ${touched} 个 Case 的 fixture 摘要` : "所有 fixture 摘要都是最新的");
