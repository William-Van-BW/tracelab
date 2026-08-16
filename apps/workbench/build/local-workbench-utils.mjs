import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function decodeXml(value) {
  return value
    .replace(/_x([0-9a-f]{4})_/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Convert PowerShell's redirected CLIXML error stream into a short message. */
export function readablePowerShellError(value, fallback = "PowerShell 执行失败") {
  const source = String(value ?? "").trim();
  if (!source) return fallback;
  const serializedErrors = [...source.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi)].map((match) => decodeXml(match[1]));
  const decoded = serializedErrors.length ? serializedErrors.join("\n") : decodeXml(source.replace(/^#< CLIXML\s*/i, ""));
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter((line) => (
    line
    && line !== "#< CLIXML"
    && !/^正在准备首次使用模块[。.]?$/.test(line)
    && !/^所在位置\s/.test(line)
    && !/^\+\s/.test(line)
    && !/^~+$/.test(line)
    && !/^\+\s*(CategoryInfo|FullyQualifiedErrorId)\s*:/i.test(line)
  ));
  const unique = lines.filter((line, index) => lines.indexOf(line) === index);
  return unique[0] || fallback;
}

function fixtureIdentity(fixture) {
  return `${String(fixture.root_id ?? "")}\0${String(fixture.relative_path ?? "").replaceAll("\\", "/")}`;
}

function fixturePath(caseDirectory, sourcePath) {
  if (!sourcePath || typeof sourcePath !== "string") throw new Error("Fixture 缺少 source_path");
  const root = resolve(caseDirectory);
  const target = resolve(join(root, ...sourcePath.replaceAll("\\", "/").split("/")));
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Fixture 路径超出 Case 目录：${sourcePath}`);
  }
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Fixture 文件不存在：${sourcePath}`);
  return target;
}

/**
 * Reconcile a mutable Case's declared fixture sizes and hashes with its source
 * files. Both JSON documents are computed before either is replaced, so a
 * validation failure cannot leave only one side updated.
 */
export function reconcileMutableFixtureMetadata(caseDirectory) {
  const casePath = join(caseDirectory, "case.json");
  const manifestPath = join(caseDirectory, "fixture-manifest.json");
  if (!existsSync(casePath) || !existsSync(manifestPath)) return { changed: false, files: 0 };

  const caseDoc = JSON.parse(readFileSync(casePath, "utf8"));
  if (caseDoc.versioning?.mutable !== true) return { changed: false, files: 0 };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(caseDoc.fixtures) || !Array.isArray(manifest.files)) {
    throw new Error("可编辑 Case 的 fixtures 或 fixture manifest 格式无效");
  }

  const caseFixtures = new Map();
  for (const fixture of caseDoc.fixtures) {
    if (fixture?.node_type !== "file") continue;
    if (fixture.fixture_id) caseFixtures.set(`id:${fixture.fixture_id}`, fixture);
    caseFixtures.set(`path:${fixtureIdentity(fixture)}`, fixture);
  }

  let changed = false;
  for (const fixture of manifest.files) {
    const declared = (fixture?.fixture_id && caseFixtures.get(`id:${fixture.fixture_id}`))
      || caseFixtures.get(`path:${fixtureIdentity(fixture)}`);
    if (!declared) throw new Error(`fixture-manifest.json 中的文件未在 case.json 声明：${fixture?.source_path ?? fixtureIdentity(fixture)}`);
    // Build products are not committed and differ per machine; the manifest
    // pins their source instead, so there is nothing here to reconcile.
    if (fixture.build) continue;
    const sourcePath = fixturePath(caseDirectory, fixture.source_path);
    const bytes = readFileSync(sourcePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (fixture.size_bytes !== bytes.byteLength || fixture.sha256 !== sha256
      || declared.size_bytes !== bytes.byteLength || declared.sha256 !== sha256) changed = true;
    fixture.size_bytes = bytes.byteLength;
    fixture.sha256 = sha256;
    declared.size_bytes = bytes.byteLength;
    declared.sha256 = sha256;
  }

  if (changed) {
    const now = new Date().toISOString();
    manifest.generated_at = now;
    caseDoc.versioning.updated_at = now;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(casePath, `${JSON.stringify(caseDoc, null, 2)}\n`, "utf8");
  }
  return { changed, files: manifest.files.length };
}
