import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readablePowerShellError, reconcileMutableFixtureMetadata } from "../build/local-workbench-utils.mjs";

const clixml = `#< CLIXML
<Objs><Obj S="progress"><MS><PR><AV>正在准备首次使用模块。</AV></PR></MS></Obj><S S="Error">Fixture size mismatch: template/管理层口径/华东客户_总经理底价备忘.md_x000D__x000A_</S><S S="Error">所在位置 C:\\Temp\\Deploy-Case.ps1:28 字符: 9_x000D__x000A_</S><S S="Error">+ throw test_x000D__x000A_</S></Objs>`;
assert.equal(
  readablePowerShellError(clixml),
  "Fixture size mismatch: template/管理层口径/华东客户_总经理底价备忘.md",
  "PowerShell CLIXML must be reduced to its actionable first error",
);

const temporaryRoot = mkdtempSync(join(tmpdir(), "tracelab-fixture-metadata-test-"));
try {
  mkdirSync(join(temporaryRoot, "template"));
  const content = Buffer.from("直接编辑后的中文 fixture\n", "utf8");
  writeFileSync(join(temporaryRoot, "template", "fixture.md"), content);
  writeFileSync(join(temporaryRoot, "case.json"), JSON.stringify({
    versioning: { mutable: true },
    fixtures: [{
      fixture_id: "fx1", node_type: "file", root_id: "workspace", relative_path: "fixture.md",
      source_path: "template/fixture.md", size_bytes: 1, sha256: "stale",
    }],
  }));
  writeFileSync(join(temporaryRoot, "fixture-manifest.json"), JSON.stringify({
    files: [{
      fixture_id: "fx1", root_id: "workspace", relative_path: "fixture.md",
      source_path: "template/fixture.md", size_bytes: 1, sha256: "stale",
    }],
  }));

  assert.deepEqual(reconcileMutableFixtureMetadata(temporaryRoot), { changed: true, files: 1 });
  const expectedHash = createHash("sha256").update(content).digest("hex");
  const caseDoc = JSON.parse(readFileSync(join(temporaryRoot, "case.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(temporaryRoot, "fixture-manifest.json"), "utf8"));
  assert.equal(caseDoc.fixtures[0].size_bytes, content.byteLength);
  assert.equal(manifest.files[0].size_bytes, content.byteLength);
  assert.equal(caseDoc.fixtures[0].sha256, expectedHash);
  assert.equal(manifest.files[0].sha256, expectedHash);
  assert.deepEqual(reconcileMutableFixtureMetadata(temporaryRoot), { changed: false, files: 1 });

  const immutableRoot = mkdtempSync(join(temporaryRoot, "immutable-"));
  mkdirSync(join(immutableRoot, "template"));
  writeFileSync(join(immutableRoot, "template", "fixture.md"), content);
  writeFileSync(join(immutableRoot, "case.json"), JSON.stringify({
    versioning: { mutable: false },
    fixtures: [{ fixture_id: "fx1", node_type: "file", root_id: "workspace", relative_path: "fixture.md", source_path: "template/fixture.md", size_bytes: 1, sha256: "stale" }],
  }));
  writeFileSync(join(immutableRoot, "fixture-manifest.json"), JSON.stringify({
    files: [{ fixture_id: "fx1", root_id: "workspace", relative_path: "fixture.md", source_path: "template/fixture.md", size_bytes: 1, sha256: "stale" }],
  }));
  assert.deepEqual(reconcileMutableFixtureMetadata(immutableRoot), { changed: false, files: 0 });
  assert.equal(JSON.parse(readFileSync(join(immutableRoot, "fixture-manifest.json"), "utf8")).files[0].sha256, "stale");

  console.log("validated local Case save/deploy robustness helpers");
} finally {
  const resolved = resolve(temporaryRoot);
  const allowedPrefix = resolve(tmpdir()) + "\\";
  if (resolved.startsWith(allowedPrefix) && resolved.includes("tracelab-fixture-metadata-test-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
