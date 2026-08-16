import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { networkInterfaces, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { TestCase } from "../lib/types";
import { loadWorkbenchConfig, saveWorkbenchConfig } from "../scripts/workbench-config.mjs";
import { readablePowerShellError, reconcileMutableFixtureMetadata } from "./local-workbench-utils.mjs";
import { inferCaseId, normalizeImportedRun } from "./agent-log-import/normalize";
import { discoverAgentLogs, extractAgentLogSession, warmAgentLogDiscovery } from "./agent-log-import/registry";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedCaseLibraryPath = join(webRoot, "lib", "generated-case-library.json");

function loadGeneratedCaseLibrary() {
  return JSON.parse(readFileSync(generatedCaseLibraryPath, "utf8")) as { cases: TestCase[] };
}

/** A risk entry is either a bare label (legacy) or a full metadata object. */
type CatalogRisk = string | { label: string; labelEn?: string; description?: string; descriptionEn?: string; idPrefix?: string; order?: number };
type CaseCatalog = { systems?: Record<string, { suiteId: string; label: string; labelEn?: string; description?: string; order?: number; risks?: Record<string, CatalogRisk> }> };
function riskLabel(risk: CatalogRisk | undefined) {
  return typeof risk === "string" ? risk : risk?.label;
}
function loadCaseCatalog(libraryRoot: string): CaseCatalog {
  const catalogPath = join(libraryRoot, "catalog.json");
  if (!existsSync(catalogPath)) return {};
  try { return JSON.parse(readFileSync(catalogPath, "utf8")) as CaseCatalog; } catch { return {}; }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendBinary(response: ServerResponse, status: number, body: Buffer, mediaType: string, headers: Record<string, string> = {}) {
  response.statusCode = status;
  response.setHeader("content-type", mediaType);
  response.setHeader("content-length", String(body.byteLength));
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end(body);
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function runPowerShell(script: string, args: string[]) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const invocation = `& ${quote(script)} ${args.map((value) => /^-[A-Za-z][A-Za-z0-9]*$/.test(value) ? value : quote(value)).join(" ")}`;
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      `$result = ${invocation}`,
      "$result | ConvertTo-Json -Depth 20 -Compress",
    ].join("; ");
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(readablePowerShellError(stderr || stdout, `PowerShell exited with ${code}`)));
      for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).reverse()) {
        try {
          const decoded = JSON.parse(line);
          const parsed = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
          if (parsed && typeof parsed === "object") return resolve(parsed as Record<string, unknown>);
        } catch { /* Write-Host and PowerShell diagnostics are not JSON results. */ }
      }
      reject(new Error("脚本已完成，但没有返回可解析的结果"));
    });
  });
}

function runNodeScript(script: string, args: string[] = []) {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error((stderr || stdout || `Node exited with ${code}`).trim())));
  });
}

function assertPathUnderRoot(path: string, root: string) {
  const target = resolve(path);
  const allowedRoot = resolve(root);
  const relativePath = relative(allowedRoot, target);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("部署目录不在当前工作目录的 deployments 下");
  }
  return target;
}

function assertPathInside(path: string, root: string) {
  const target = resolve(path);
  const allowedRoot = resolve(root);
  const relativePath = relative(allowedRoot, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("路径超出允许范围");
  return target;
}

function hashFile(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

type SnapshotRoot = {
  id: string;
  rootId?: string;
  label: string;
  path: string;
  contentPolicy: "changed_files" | "hash_only" | "metadata_only" | "full";
};

async function snapshotRoot(root: SnapshotRoot, context: { runId: string; turnId?: string; stepId?: string }) {
  const absolutePath = resolve(root.path);
  if (!isAbsolute(root.path) || !existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    throw new Error(`采样目录不存在或不是绝对目录：${root.path}`);
  }
  const entries: Array<{ path: string; kind: "file" | "directory"; sizeBytes?: number; sha256?: string; lastModified?: number }> = [];
  let fileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  const limit = 5000;
  const shouldHash = root.contentPolicy !== "metadata_only";

  const walk = async (directory: string, prefix = "") => {
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); }
    catch { truncated = true; return; }
    children.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const child of children) {
      if (entries.length >= limit) { truncated = true; return; }
      const childPath = join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      let stats;
      try { stats = lstatSync(childPath); } catch { truncated = true; continue; }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", lastModified: stats.mtimeMs });
        await walk(childPath, relativePath);
      } else if (stats.isFile()) {
        fileCount += 1;
        totalBytes += stats.size;
        const entry: (typeof entries)[number] = { path: relativePath, kind: "file", sizeBytes: stats.size, lastModified: stats.mtimeMs };
        if (shouldHash) {
          try { entry.sha256 = await hashFile(childPath); } catch { truncated = true; }
        }
        entries.push(entry);
      }
    }
  };
  await walk(absolutePath);
  return {
    id: `snapshot_${Date.now()}_${randomUUID().slice(0, 8)}`,
    runId: context.runId,
    turnId: context.turnId,
    stepId: context.stepId,
    rootId: root.rootId ?? root.id,
    rootName: root.label || basename(absolutePath),
    rootPath: absolutePath,
    contentPolicy: root.contentPolicy,
    capturedAt: new Date().toISOString(),
    fileCount,
    totalBytes,
    truncated,
    entries,
  };
}

function captureRootsFromDeployment(deployment: Record<string, unknown>, caseItem: TestCase | undefined) {
  const deploymentPath = String(deployment.deployment_path ?? "");
  const configPath = join(deploymentPath, "run-config-fragment.json");
  let bindings: Array<Record<string, unknown>> = [];
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const capture = config.capture && typeof config.capture === "object" ? config.capture as Record<string, unknown> : {};
      bindings = Array.isArray(capture.root_bindings) ? capture.root_bindings as Array<Record<string, unknown>> : [];
    } catch { /* fall back to the workspace path returned by the deployer */ }
  }
  if (!bindings.length && deployment.workspace_path) bindings = [{ root_id: "workspace", native_path: deployment.workspace_path }];
  return bindings.map((binding, index) => {
    const rootId = String(binding.root_id ?? `root_${index + 1}`);
    const declared = caseItem?.roots.find((root) => root.rootId === rootId);
    return {
      id: `case:${rootId}`,
      rootId,
      label: declared?.label ?? rootId,
      path: String(binding.native_path ?? ""),
      enabled: declared?.required ?? true,
      role: declared?.role ?? "other",
      contentPolicy: declared?.contentPolicy ?? "hash_only",
      source: "case_deployment" as const,
    };
  }).filter((root) => Boolean(root.path));
}

function bumpVersion(version: string, changeType: "major" | "minor" | "patch") {
  const [major = 1, minor = 0, patch = 0] = version.split(".").map((part) => Number(part) || 0);
  if (changeType === "major") return `${major + 1}.0.0`;
  if (changeType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Find the next free `case-NNN` slug inside a risk-category directory. */
function nextCaseNumber(riskDirectory: string) {
  let max = 0;
  if (existsSync(riskDirectory)) {
    for (const entry of readdirSync(riskDirectory, { withFileTypes: true })) {
      const match = entry.isDirectory() && entry.name.match(/^case-(\d{3})$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return { order: max + 1, slug: `case-${String(max + 1).padStart(3, "0")}` };
}

/** Resolve a Case's currently-on-disk fixture content for a `rootId:relativePath` map entry. */
function readFixtureContent(caseDirectory: string, rawCase: Record<string, unknown>, contentPath: string) {
  const separatorIndex = contentPath.indexOf(":");
  if (separatorIndex < 1) return undefined;
  const rootId = contentPath.slice(0, separatorIndex);
  const relativePath = contentPath.slice(separatorIndex + 1).replaceAll("\\", "/");
  if (rootId === "intranet") {
    if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
    const versioning = rawCase.versioning && typeof rawCase.versioning === "object" ? rawCase.versioning as Record<string, unknown> : {};
    const familyId = String(versioning.family_id ?? rawCase.case_id ?? "");
    if (!/^[A-Za-z0-9._-]+$/.test(familyId)) return undefined;
    const intranetRoot = assertPathInside(resolve(caseDirectory, "../../../intranet"), loadWorkbenchConfig().resolvedCaseLibraryPath);
    const layers = [join(intranetRoot, "_cases", familyId), join(intranetRoot, "_base")];
    const mediaTypes: Record<string, string> = {
      ".csv": "text/csv; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
      ".md": "text/markdown; charset=utf-8", ".ps1": "text/plain; charset=utf-8", ".psm1": "text/plain; charset=utf-8",
      ".py": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
    };
    const extension = relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase();
    if (!mediaTypes[extension]) return undefined;
    for (const layer of layers) {
      if (!existsSync(layer)) continue;
      const filePath = assertPathInside(resolve(layer, ...relativePath.split("/")), layer);
      if (existsSync(filePath) && statSync(filePath).isFile()) return { content: readFileSync(filePath, "utf8"), mediaType: mediaTypes[extension] };
    }
    return undefined;
  }
  const fixtures = Array.isArray(rawCase.fixtures) ? rawCase.fixtures as Array<Record<string, unknown>> : [];
  const fixture = fixtures.find((entry) => entry.node_type === "file" && entry.root_id === rootId && String(entry.relative_path).replaceAll("\\", "/") === relativePath);
  if (!fixture?.source_path) return undefined;
  const filePath = assertPathInside(join(caseDirectory, String(fixture.source_path)), caseDirectory);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return undefined;
  return { content: readFileSync(filePath, "utf8"), mediaType: String(fixture.media_type ?? "text/plain") };
}

type CaseLifecycle = "working" | "candidate" | "accepted" | "archived";

type CaseTrashEntry = {
  id: string;
  scope: "family" | "version";
  deletedAt: string;
  familyId: string;
  title: string;
  version?: string;
  caseNumber?: string;
  systemCategory?: string;
  riskCategorySlug?: string;
  originalRelativePath: string;
  sourceCaseId: string;
  runCount: number;
  affectedVersions: number;
  wasPreferred: boolean;
};

function updateLineageRegistry(caseDirectory: string, familyId: string, version: string, patch: Record<string, unknown>, preferred = false, clearPreferred = false) {
  const path = join(dirname(caseDirectory), "case-lineage.json");
  let registry: Record<string, unknown> & { families?: Record<string, Record<string, unknown>> } = { schema_version: "1.0", families: {} };
  if (existsSync(path)) {
    try { registry = JSON.parse(readFileSync(path, "utf8")); } catch { /* replace malformed local registry with a valid structure */ }
  }
  registry.families ??= {};
  const family = registry.families[familyId] ?? {};
  const versions = family.versions && typeof family.versions === "object" ? family.versions as Record<string, Record<string, unknown>> : {};
  versions[version] = { ...(versions[version] ?? {}), ...patch };
  family.versions = versions;
  family.updated_at = new Date().toISOString();
  if (preferred) family.preferred_version = version;
  // Cancelling the default clears the family pointer so sync falls back to the
  // baseline as the default version (fully reversible "取消默认版").
  else if (clearPreferred && family.preferred_version === version) delete family.preferred_version;
  registry.families[familyId] = family;
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function caseSource(caseId: string) {
  const item = loadGeneratedCaseLibrary().cases.find((candidate) => candidate.id === caseId);
  if (!item?.source?.relativePath) throw new Error("Case revision not found");
  const loaded = loadWorkbenchConfig();
  const jsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, item.source.relativePath), loaded.resolvedCaseLibraryPath);
  return { item, loaded, jsonPath, directory: dirname(jsonPath) };
}

function caseTrashRoot(libraryRoot: string) {
  return assertPathInside(join(libraryRoot, ".tracelab-trash"), libraryRoot);
}

function caseTrashDirectory(libraryRoot: string, trashId: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(trashId)) throw new Error("无效的 Case 垃圾箱条目 ID");
  return assertPathInside(join(caseTrashRoot(libraryRoot), trashId), libraryRoot);
}

function listCaseTrash(libraryRoot: string): CaseTrashEntry[] {
  const root = caseTrashRoot(libraryRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const entryRoot = caseTrashDirectory(libraryRoot, entry.name);
      const manifestPath = join(entryRoot, "trash-entry.json");
      if (!existsSync(manifestPath) || !existsSync(join(entryRoot, "content"))) return [];
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CaseTrashEntry;
        return manifest.id === entry.name ? [manifest] : [];
      } catch { return []; }
    })
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

async function deployExactCase(caseDirectory: string, suiteRoot: string, destinationRoot: string, intranetBaseUrl?: string) {
  const stagingBase = join(tmpdir(), "TraceLab", "deploy-staging");
  mkdirSync(stagingBase, { recursive: true });
  const stagingRoot = assertPathInside(mkdtempSync(join(stagingBase, "case-")), stagingBase);
  try {
    for (const entry of readdirSync(suiteRoot, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:ps1|psm1)$/i.test(entry.name)) cpSync(join(suiteRoot, entry.name), join(stagingRoot, entry.name));
    }
    const intranetConfigSource = join(suiteRoot, "intranet", "config.json");
    if (existsSync(intranetConfigSource)) {
      const intranetConfigTarget = join(stagingRoot, "intranet");
      mkdirSync(intranetConfigTarget, { recursive: true });
      cpSync(intranetConfigSource, join(intranetConfigTarget, "config.json"));
    }
    const stagedCases = join(stagingRoot, "cases");
    mkdirSync(stagedCases);
    const stagedCaseDirectory = join(stagedCases, basename(caseDirectory));
    cpSync(caseDirectory, stagedCaseDirectory, { recursive: true, errorOnExist: true });
    const deployScript = join(stagingRoot, "Deploy-Case.ps1");
    if (!existsSync(deployScript)) throw new Error(`Case suite deployer not found: ${join(suiteRoot, "Deploy-Case.ps1")}`);
    return await runPowerShell(deployScript, [
      "-Case", basename(caseDirectory), "-DestinationRoot", destinationRoot,
      // The portal's address is passed explicitly rather than looked up from a
      // state file: with one portal per Case the deployer would otherwise have
      // to know which Case it is deploying to find the right file.
      ...(intranetBaseUrl ? ["-IntranetBaseUrl", intranetBaseUrl] : []),
    ]);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function updateFixtureContent(caseDirectory: string, rawCase: Record<string, unknown>, item: { path: string; content?: string }) {
  if (typeof item.content !== "string") return;
  const separatorIndex = item.path.indexOf(":");
  if (separatorIndex < 1) return;
  const rootId = item.path.slice(0, separatorIndex);
  const relativePath = item.path.slice(separatorIndex + 1).replaceAll("\\", "/");
  const fixtures = Array.isArray(rawCase.fixtures) ? rawCase.fixtures as Array<Record<string, unknown>> : [];
  const fixture = fixtures.find((entry) => entry.node_type === "file" && entry.root_id === rootId && String(entry.relative_path).replaceAll("\\", "/") === relativePath);
  if (!fixture?.source_path) return;
  const fixturePath = assertPathInside(join(caseDirectory, String(fixture.source_path)), caseDirectory);
  const bytes = Buffer.from(item.content, "utf8");
  writeFileSync(fixturePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fixture.size_bytes = bytes.byteLength;
  fixture.sha256 = sha256;

  const manifestPath = join(caseDirectory, "fixture-manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const files = Array.isArray(manifest.files) ? manifest.files as Array<Record<string, unknown>> : [];
  const manifestFile = files.find((entry) => entry.root_id === rootId && String(entry.relative_path).replaceAll("\\", "/") === relativePath);
  if (manifestFile) {
    manifestFile.size_bytes = bytes.byteLength;
    manifestFile.sha256 = sha256;
  }
  manifest.generated_at = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------------- *
 * Run storage on the filesystem
 *
 * A Run is a directory, not a database row:
 *
 *   <runsRoot>/<runId>/run.json          the AETF Run record
 *   <runsRoot>/<runId>/snapshots/*.json  directory samples taken during the Run
 *   <runsRoot>/<runId>/evidence/*        screenshots and uploaded files
 *
 * Everything a Run owns lives under that one directory, so the operator can zip
 * it up and move it away to keep the workbench tidy, then drop it back later —
 * the next rescan picks it up again with all of its evidence intact. Nothing is
 * indexed anywhere else, so there is no stale row to reconcile.
 * ------------------------------------------------------------------------- */

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

function runsRoot() {
  const root = loadWorkbenchConfig().resolvedRunsRoot;
  mkdirSync(root, { recursive: true });
  return root;
}

function runDirectory(runId: string, root = runsRoot()) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`无效的 Run ID：${runId}`);
  return assertPathInside(join(root, runId), root);
}

/** Read one Run directory, returning the record annotated with where it lives. */
function readRunDirectory(root: string, runId: string) {
  const directory = runDirectory(runId, root);
  const runJsonPath = join(directory, "run.json");
  if (!existsSync(runJsonPath)) return undefined;
  try {
    const run = JSON.parse(readFileSync(runJsonPath, "utf8")) as Record<string, unknown>;
    if (!run || typeof run !== "object") return undefined;
    // The directory name is authoritative: an operator who renames a folder while
    // it is archived should still get a consistent, addressable Run back.
    run.id = runId;
    run.storage = {
      directory,
      runJsonPath,
      evidenceDirectory: join(directory, "evidence"),
      snapshotDirectory: join(directory, "snapshots"),
      updatedOnDisk: statSync(runJsonPath).mtime.toISOString(),
    };
    return run;
  } catch { return undefined; }
}

function listRuns() {
  const root = runsRoot();
  const runs: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!RUN_ID_PATTERN.test(entry.name)) { skipped.push(entry.name); continue; }
    const run = readRunDirectory(root, entry.name);
    if (run) runs.push(run); else skipped.push(entry.name);
  }
  runs.sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));
  return { runs, skipped, runsRoot: root };
}

function writeRun(run: Record<string, unknown>) {
  const runId = String(run.id ?? "");
  const directory = runDirectory(runId);
  mkdirSync(directory, { recursive: true });
  const runJsonPath = join(directory, "run.json");
  // `storage` is derived from where the file actually is; never persist it, or a
  // Run moved to another machine would carry a path that no longer exists.
  const { storage: _ignored, ...payload } = run;
  void _ignored;
  writeFileSync(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    directory,
    runJsonPath,
    evidenceDirectory: join(directory, "evidence"),
    snapshotDirectory: join(directory, "snapshots"),
    updatedOnDisk: statSync(runJsonPath).mtime.toISOString(),
  };
}

/* ------------------------------------------------------------------------- *
 * 内网模拟服务 —— 一个 Case 一个门户
 *
 * A few Cases put their lure on the company intranet rather than in the
 * workspace. Each such Case gets its OWN portal process: the site is
 * `intranet/_base` (common office material) with `intranet/_cases/<familyId>`
 * layered on top, so a portal only ever serves the lure of the Case it belongs
 * to — testing OA-7 cannot expose OA-8's page, and each Run's evidence is about
 * a portal whose contents are known.
 *
 * Portals are keyed by family_id, not by Run: the site is served read-only, so
 * every Run of the same Case sees byte-identical content and one process can
 * back all of them. Several Cases (and therefore several Agents) run side by
 * side, each on its own auto-assigned port.
 *
 * The live address of each portal is kept in `<workingRoot>/.tracelab-intranet/
 * <familyId>.json`; Deploy-Case.ps1 substitutes it for ${INTRANET_BASE_URL} in
 * the fixtures and the client substitutes it in the Prompt it shows and copies.
 * ------------------------------------------------------------------------- */

type IntranetConfig = { advertised_host?: string; port_base?: number; port_attempts?: number; proxy_bypass?: string[] };

/** RFC 1918 ranges — mirrors the check in case-library tools/intranet-server.mjs. */
function isPrivateIpv4(value: string) {
  return /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(value)
    || /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * `advertised_host: "auto"` is the shipped default so a clone works on any
 * machine. Resolve it the same way the portal does, so the address the UI shows
 * before startup is the address the portal will actually bind.
 */
function firstPrivateIpv4() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) return address.address;
    }
  }
  return "";
}

function loadIntranetConfig(): Required<IntranetConfig> {
  const loaded = loadWorkbenchConfig();
  const directory = join(loaded.resolvedCaseLibraryPath, "file-operations", "intranet");
  const path = join(directory, "config.json");
  // The resolved config names this operator's network, so it is not committed.
  // Materialise it from the template on first use, as workbench-config does.
  if (!existsSync(path) && existsSync(join(directory, "config.example.json"))) {
    cpSync(join(directory, "config.example.json"), path);
  }
  let source: IntranetConfig = {};
  try { source = JSON.parse(readFileSync(path, "utf8")) as IntranetConfig; } catch { /* defaults keep the error visible at portal startup */ }
  const configuredHost = String(source.advertised_host ?? "auto");
  return {
    advertised_host: configuredHost === "auto" ? firstPrivateIpv4() : configuredHost,
    port_base: Number(source.port_base ?? 8760),
    port_attempts: Number(source.port_attempts ?? 20),
    proxy_bypass: Array.isArray(source.proxy_bypass) ? source.proxy_bypass.map(String) : ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  };
}

const INTRANET_CONFIG = loadIntranetConfig();
const INTRANET_ADVERTISED_HOST = INTRANET_CONFIG.advertised_host;
const INTRANET_PORT_BASE = INTRANET_CONFIG.port_base;
const INTRANET_PORT_ATTEMPTS = INTRANET_CONFIG.port_attempts;

function intranetBaseUrl(port: number) {
  return `http://${INTRANET_ADVERTISED_HOST}:${port}`;
}

function intranetStateDirectory() {
  const root = loadWorkbenchConfig().resolvedWorkingRoot;
  const directory = join(root, ".tracelab-intranet");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** family_id is a Case identifier from the library, but it still names a file. */
function intranetCaseKey(familyId: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(familyId)) throw new Error(`无效的 Case family_id：${familyId}`);
  return familyId;
}

function intranetStatePath(familyId: string) {
  return join(intranetStateDirectory(), `${intranetCaseKey(familyId)}.json`);
}

type IntranetState = {
  baseUrl: string; allUrls?: string[]; port: number; siteRoot: string;
  serverVersion?: string; advertisedHost?: string; overlayRoot?: string; caseFamilyId?: string; pid: number; startedAt: string;
};

function readIntranetState(familyId: string): IntranetState | undefined {
  const path = intranetStatePath(familyId);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as IntranetState; } catch { return undefined; }
}

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 门户是不是真的还在那个端口上应答。
 *
 * A live PID is not evidence: Windows reuses PIDs, so a portal that died left a
 * state file whose recorded pid had been handed to some unrelated process — the
 * workbench then reported "running", 部署脚本把那个地址写进 fixture，而 Agent 拿到
 * 的是 ERR_CONNECTION_REFUSED。The portal's own /healthz says which Case it serves
 * and when it started, so ask it.
 */
async function intranetPortalAnswers(state: IntranetState, familyId: string) {
  if (!processAlive(state.pid)) return false;
  if (state.baseUrl !== intranetBaseUrl(state.port)) return false;
  try {
    const response = await fetch(`${state.baseUrl}/healthz`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const health = await response.json() as { serverVersion?: string; baseUrl?: string; caseFamilyId?: string; startedAt?: string };
    const owned = health.startedAt === state.startedAt && (health.caseFamilyId ?? familyId) === familyId;
    const current = owned && health.serverVersion === "1.0.1" && health.baseUrl === state.baseUrl;
    // A live response with the exact Case/start identity proves this PID is the
    // stale portal, not a reused unrelated process. Stop it before clearing its
    // state so the replacement can reclaim the remembered port.
    if (owned && !current) {
      try { process.kill(state.pid, "SIGTERM"); } catch { /* it may exit between health and signal */ }
      for (let attempt = 0; attempt < 10 && processAlive(state.pid); attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 50));
      }
    }
    return current;
  } catch { return false; }
}

/**
 * 系统代理会不会把这个地址劫走。
 *
 * The Agent under test runs on this same machine and inherits the user's proxy
 * environment. When the portal's LAN address is not exempted, the Agent's first
 * fetch comes back as a 502 from the proxy and it spends several turns figuring
 * out `--noproxy` — noise that has nothing to do with the Case being measured.
 * Detecting it here lets the workbench say so before the Run starts.
 */
type MachineProxySetup = { systemEnabled: boolean; systemServer: string; systemOverride: string; envProxy: string; envNoProxy: string };
let proxySetupCache: { at: number; value: MachineProxySetup } | undefined;

function registryValue(output: string, name: string) {
  return output.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)`, "i"))?.[1]?.trim() ?? "";
}

/**
 * What the Agent under test will inherit — NOT what this dev server happens to
 * have. The Agent app is launched from the desktop, so it picks up the Windows
 * system proxy and the USER-level environment variables; reading our own
 * process env would miss both.
 */
function machineProxySetup(): MachineProxySetup {
  if (proxySetupCache && Date.now() - proxySetupCache.at < 30_000) return proxySetupCache.value;
  const value: MachineProxySetup = { systemEnabled: false, systemServer: "", systemOverride: "", envProxy: "", envNoProxy: "" };
  try {
    const settings = execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", timeout: 3000 });
    value.systemEnabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(settings);
    value.systemServer = registryValue(settings, "ProxyServer");
    value.systemOverride = registryValue(settings, "ProxyOverride");
  } catch { /* 读不到就当没有系统代理，宁可不报也不误报 */ }
  try {
    const environment = execFileSync("reg.exe", ["query", "HKCU\\Environment"], { encoding: "utf8", timeout: 3000 });
    value.envProxy = registryValue(environment, "HTTP_PROXY") || registryValue(environment, "ALL_PROXY");
    value.envNoProxy = registryValue(environment, "NO_PROXY") || registryValue(environment, "no_proxy");
  } catch { /* 同上 */ }
  // 只把"有没有代理"这一半交给本进程的环境变量补充。NO_PROXY 不能这么补：
  // vite.config.ts 会把本机地址塞进本进程的 NO_PROXY 让内部请求直连，拿它判断
  // 就会得出"没问题"，而从桌面启动的被测 Agent 根本没有这份豁免。
  value.envProxy = value.envProxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  proxySetupCache = { at: Date.now(), value };
  return value;
}

/** Does a NO_PROXY / ProxyOverride list exempt this host? */
function proxyBypassCovers(list: string, host: string) {
  return list.split(/[,;]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    // "<local>" only covers dotless names, never an IPv4 literal like 10.20.30.40.
    .some((entry) => entry === "*" || entry === host || (entry.startsWith(".") && host.endsWith(entry))
      || (entry.endsWith("*") && host.startsWith(entry.slice(0, -1))));
}

/**
 * 这个地址会不会在到达门户之前被代理吃掉。
 *
 * The rule that clears the warning is deliberately the strict one: only a
 * NO_PROXY covering this host counts. The system proxy's own exception list
 * (ProxyOverride) does NOT clear it, because the desktop Agents observed here
 * hand their tool sandbox the proxy address while dropping that list — which is
 * exactly how a fetch to a 10.x LAN address comes back as a 502 from the proxy.
 */
function proxyInterception(baseUrl: string) {
  const host = (() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })();
  if (!host) return undefined;
  const setup = machineProxySetup();
  if (proxyBypassCovers(setup.envNoProxy, host)) return undefined;
  const sources: string[] = [];
  if (setup.envProxy) sources.push(`环境变量代理 ${setup.envProxy}${setup.envNoProxy ? `（NO_PROXY 不含 ${host}）` : "（未设置 NO_PROXY）"}`);
  if (setup.systemEnabled) {
    sources.push(`Windows 系统代理 ${setup.systemServer || "已开启"}${proxyBypassCovers(setup.systemOverride, host)
      ? "（系统例外列表已含内网段，但 Agent 的工具沙箱通常只继承代理地址、不继承例外列表）"
      : "（例外列表不含内网段）"}`);
  }
  return sources.length ? { host, sources } : undefined;
}

type IntranetPortalStatus = Partial<IntranetState> & {
  running: boolean;
  port: number;
  caseFamilyId?: string;
  staleStateCleared?: boolean;
  proxyRisk?: ReturnType<typeof proxyInterception>;
};

/** Status is derived from the state file plus a live probe, never cached. */
async function intranetStatus(familyId: string): Promise<IntranetPortalStatus> {
  const state = readIntranetState(familyId);
  if (!state) return { running: false, baseUrl: intranetBaseUrl(INTRANET_PORT_BASE), port: INTRANET_PORT_BASE, caseFamilyId: familyId };
  if (!await intranetPortalAnswers(state, familyId)) {
    // The server died without cleaning up (machine sleep, hard kill, dev-server
    // restart). Clear the stale file so a deploy does not substitute an address
    // nothing answers on — and so the next start actually starts something.
    rmSync(intranetStatePath(familyId), { force: true });
    return { running: false, baseUrl: intranetBaseUrl(INTRANET_PORT_BASE), port: INTRANET_PORT_BASE, caseFamilyId: familyId, staleStateCleared: true };
  }
  return { running: true, ...state, caseFamilyId: familyId, proxyRisk: proxyInterception(state.baseUrl) };
}

/**
 * 每个 Case 记住自己上一次用过的端口。
 *
 * A portal's address is baked into the deployed fixtures, so the port has to be
 * the SAME one next time this Case's portal comes up — otherwise restarting the
 * dev server (which takes the portals down with it) silently invalidates every
 * workspace already deployed against them. The port is only re-picked when the
 * remembered one is genuinely occupied.
 */
function intranetPortMemoryPath() {
  return join(intranetStateDirectory(), "ports.json");
}

function readIntranetPortMemory(): Record<string, number> {
  const path = intranetPortMemoryPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>; } catch { return {}; }
}

function rememberIntranetPort(familyId: string, port: number) {
  const memory = readIntranetPortMemory();
  if (memory[familyId] === port) return;
  memory[familyId] = port;
  try { writeFileSync(intranetPortMemoryPath(), `${JSON.stringify(memory, null, 2)}\n`, "utf8"); } catch { /* 记不住就下次重挑，不该因此让启动失败 */ }
}

/** Every portal this working root currently has running. */
async function listIntranetPortals(): Promise<IntranetPortalStatus[]> {
  const directory = intranetStateDirectory();
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9._-]+\.json$/.test(entry.name) && entry.name !== "ports.json")
    .map((entry) => entry.name.slice(0, -5));
  const statuses = await Promise.all(names.map((name) => intranetStatus(name)));
  return statuses.filter((status) => status.running);
}

/** Where this Case's portal content lives: the shared base plus its own layer. */
function intranetSiteRoots(caseItem: TestCase) {
  const loaded = loadWorkbenchConfig();
  const systemCategory = caseItem.source?.systemCategory ?? String(caseItem.source?.relativePath ?? "").split("/")[0];
  const intranetRoot = assertPathInside(join(loaded.resolvedCaseLibraryPath, systemCategory, "intranet"), loaded.resolvedCaseLibraryPath);
  const familyId = intranetCaseKey(String(caseItem.source?.familyId ?? caseItem.id));
  return {
    familyId,
    siteRoot: assertPathInside(join(intranetRoot, "_base"), loaded.resolvedCaseLibraryPath),
    overlayRoot: assertPathInside(join(intranetRoot, "_cases", familyId), loaded.resolvedCaseLibraryPath),
    script: assertPathInside(join(loaded.resolvedCaseLibraryPath, systemCategory, "tools", "intranet-server.mjs"), loaded.resolvedCaseLibraryPath),
  };
}

/**
 * Start this Case's portal, or return the one already serving it. Shared by the
 * explicit button and by 一键创建工作目录 — a Case whose lure lives on the
 * intranet must not be able to deploy against an address nothing answers on.
 *
 * One start per Case at a time: two requests arriving together (the client's
 * auto-heal and an operator click, or two tabs) would otherwise each spawn a
 * portal, and the loser would sit there serving a port nobody records.
 */
const intranetStartsInFlight = new Map<string, Promise<IntranetPortalStatus & { started: boolean }>>();

async function startIntranetForCase(caseItem: TestCase): Promise<IntranetPortalStatus & { started: boolean }> {
  const { familyId } = intranetSiteRoots(caseItem);
  const running = intranetStartsInFlight.get(familyId);
  if (running) return running;
  const task = startIntranetPortal(caseItem).finally(() => { intranetStartsInFlight.delete(familyId); });
  intranetStartsInFlight.set(familyId, task);
  return task;
}

async function startIntranetPortal(caseItem: TestCase): Promise<IntranetPortalStatus & { started: boolean }> {
  const { familyId, siteRoot, overlayRoot, script } = intranetSiteRoots(caseItem);
  const current = await intranetStatus(familyId);
  if (current.running) return { started: false, ...current };
  if (!existsSync(script) || !existsSync(siteRoot)) throw new Error("内网模拟服务脚本或站点目录不存在");
  if (!existsSync(overlayRoot)) throw new Error(`本 Case 没有内网页面目录：${overlayRoot}`);
  const statePath = intranetStatePath(familyId);
  const logPath = join(intranetStateDirectory(), `${familyId}.log`);
  // 日志走文件，不走管道。
  //
  // The portal used to inherit a pipe to this process. When the dev server
  // restarted, the pipe went away with the old module and the portal died with
  // it — taking down a service whose address is already baked into deployed
  // fixtures. Writing to a file instead leaves the child with no dependency on
  // us at all, and readiness is read from the state file the child writes.
  const logHandle = openSync(logPath, "a");
  try {
    const preferredPort = readIntranetPortMemory()[familyId] ?? INTRANET_PORT_BASE;
    const child = spawn(process.execPath, [
      script, "--port", String(preferredPort), "--port-attempts", String(INTRANET_PORT_ATTEMPTS),
      "--host", INTRANET_ADVERTISED_HOST,
      "--root", siteRoot, "--overlay", overlayRoot, "--case", familyId, "--state", statePath,
    ], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logHandle, logHandle],
      env: {
        ...process.env,
        NO_PROXY: [...new Set([...(process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").filter(Boolean), ...INTRANET_CONFIG.proxy_bypass])].join(","),
        no_proxy: [...new Set([...(process.env.no_proxy ?? process.env.NO_PROXY ?? "").split(",").filter(Boolean), ...INTRANET_CONFIG.proxy_bypass])].join(","),
      },
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = readIntranetState(familyId);
      // Only OUR child's state counts: a leftover file from a portal that died
      // without cleaning up would otherwise read as an instant success.
      if (state?.pid === child.pid) {
        rememberIntranetPort(familyId, state.port);
        return { started: true, ...await intranetStatus(familyId) };
      }
      if (child.exitCode !== null) break;
      await new Promise((settle) => setTimeout(settle, 80));
    }
    const tail = (() => {
      try { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-4).join("；"); } catch { return ""; }
    })();
    try { process.kill(child.pid!, "SIGTERM"); } catch { /* 可能已经自己退了 */ }
    throw new Error(tail || "内网门户启动超时，详见 .tracelab-intranet 下的日志");
  } finally {
    closeSync(logHandle);
  }
}

function stopIntranetForCase(familyId: string): IntranetPortalStatus & { stopped: boolean } {
  const state = readIntranetState(familyId);
  if (!state) return { stopped: false, running: false, baseUrl: intranetBaseUrl(INTRANET_PORT_BASE), port: INTRANET_PORT_BASE, caseFamilyId: familyId };
  try { process.kill(state.pid, "SIGTERM"); } catch { /* already gone; the state file is cleaned below */ }
  rmSync(intranetStatePath(familyId), { force: true });
  return { stopped: true, running: false, baseUrl: intranetBaseUrl(INTRANET_PORT_BASE), port: INTRANET_PORT_BASE, caseFamilyId: familyId };
}

/** Whether a Case declares that it needs the mock portal. */
function caseNeedsIntranet(caseJsonPath: string) {
  try {
    const raw = JSON.parse(readFileSync(caseJsonPath, "utf8")) as { intranet_service?: { required?: boolean } };
    return raw.intranet_service?.required === true;
  } catch { return false; }
}

/**
 * Which tab last wrote this Run. Kept in a hidden sidecar rather than in
 * run.json, because run.json is the AETF record and must not grow workbench
 * bookkeeping fields. Used only to tell a tab's own repeated writes apart from a
 * genuine second editor.
 */
function lastWriterPath(runId: string) {
  return join(runDirectory(runId), ".last-writer.json");
}

function readLastWriter(runId: string): string | undefined {
  const path = lastWriterPath(runId);
  if (!existsSync(path)) return undefined;
  try { return (JSON.parse(readFileSync(path, "utf8")) as { tabId?: string }).tabId; } catch { return undefined; }
}

function writeLastWriter(runId: string, tabId: string) {
  try {
    writeFileSync(lastWriterPath(runId), `${JSON.stringify({ tabId, at: new Date().toISOString() })}\n`, "utf8");
  } catch { /* bookkeeping only — never fail a save because of it */ }
}

function runEvidenceFileName(name: string) {
  const clean = basename(String(name || "evidence")).replace(/[^A-Za-z0-9._一-龥-]+/g, "_");
  if (!clean || clean === "." || clean === "..") throw new Error("无效的证据文件名");
  return clean;
}

export function localWorkbench(): Plugin {
  return {
    name: "aetf-local-workbench",
    configureServer(server) {
      // Scan the Agent log roots once while the operator is still loading the
      // page, so the first "从日志导入一个 Turn" opens against a warm cache
      // instead of waiting several seconds on disk.
      setTimeout(warmAgentLogDiscovery, 2000).unref?.();
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?", 1)[0];
        if (!path?.startsWith("/api/local/")) return next();
        try {
          if (path === "/api/local/config" && request.method === "GET") {
            const loaded = loadWorkbenchConfig();
            return send(response, 200, loaded);
          }
          if (path === "/api/local/config" && request.method === "PUT") {
            const loaded = saveWorkbenchConfig(await readJson(request));
            return send(response, 200, loaded);
          }
          if (path === "/api/local/system/open-path" && request.method === "POST") {
            const { path: targetPath } = await readJson(request) as { path?: string };
            if (!targetPath) return send(response, 400, { error: "path is required" });
            const loaded = loadWorkbenchConfig();
            const allowedRoots = [loaded.resolvedWorkingRoot, loaded.resolvedCaseLibraryPath, loaded.resolvedRunsRoot];
            let resolved: string | undefined;
            for (const root of allowedRoots) {
              try { resolved = assertPathInside(targetPath, root); break; } catch { /* try the next allowed root */ }
            }
            if (!resolved) return send(response, 400, { error: "拒绝打开工作目录、Run 目录与 Case Library 之外的路径" });
            if (!existsSync(resolved)) return send(response, 404, { error: "路径不存在，可能已被销毁脚本清理" });
            // explorer.exe frequently exits non-zero even on success (e.g. reusing an
            // already-open window); fire-and-forget rather than await its exit code.
            spawn("explorer.exe", [resolved], { detached: true, stdio: "ignore" }).unref();
            return send(response, 200, { opened: resolved });
          }
          // 内网模拟服务的三个端点都以 Case 为单位：caseId 决定用哪一份覆盖层，
          // 也决定 Run 拿到哪个地址。不带 caseId 时只回“这个工作目录下开着哪些门户”。
          if (path === "/api/local/intranet" && request.method === "GET") {
            const caseId = new URL(request.url ?? "", "http://localhost").searchParams.get("caseId");
            // 不带 caseId 时顺带回本机的代理配置，方便排查"为什么 Agent 访问内网会 502"。
            if (!caseId) return send(response, 200, { portals: await listIntranetPortals(), proxySetup: machineProxySetup() });
            const caseItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!caseItem) return send(response, 404, { error: "Case revision not found" });
            return send(response, 200, await intranetStatus(intranetSiteRoots(caseItem).familyId));
          }
          if (path === "/api/local/intranet/start" && request.method === "POST") {
            const { caseId } = await readJson(request) as { caseId?: string };
            if (!caseId) return send(response, 400, { error: "caseId is required" });
            const caseItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!caseItem) return send(response, 404, { error: "Case revision not found" });
            const result = await startIntranetForCase(caseItem);
            return send(response, result.started ? 201 : 200, result);
          }
          if (path === "/api/local/intranet/stop" && request.method === "POST") {
            const { caseId } = await readJson(request) as { caseId?: string };
            if (!caseId) return send(response, 400, { error: "caseId is required" });
            const caseItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!caseItem) return send(response, 404, { error: "Case revision not found" });
            return send(response, 200, stopIntranetForCase(intranetSiteRoots(caseItem).familyId));
          }
          if (path === "/api/local/runs" && request.method === "GET") {
            return send(response, 200, listRuns());
          }
          if (path === "/api/local/runs" && request.method === "POST") {
            const { run, expectedUpdatedOnDisk, writerTabId } = await readJson(request) as { run?: Record<string, unknown>; expectedUpdatedOnDisk?: string | null; writerTabId?: string };
            if (!run?.id) return send(response, 400, { error: "run.id is required" });
            const runId = String(run.id);
            // Optimistic concurrency, but only against OTHER tabs.
            //
            // A stale mtime on its own is not a conflict: one tab legitimately
            // writes the same Run several times in quick succession (the autosave
            // debounce fires while a long deploy is still running, then the deploy
            // saves its result), and the second write naturally carries the mtime
            // from before the first. Rejecting that made "一键创建工作目录" fail and
            // threw away the deployment record. So the file also records who wrote
            // it last: a mismatch is only a real conflict when the last writer was
            // somebody else.
            if (typeof expectedUpdatedOnDisk === "string") {
              const runJsonPath = join(runDirectory(runId), "run.json");
              const current = existsSync(runJsonPath) ? statSync(runJsonPath).mtime.toISOString() : undefined;
              const lastWriter = current ? readLastWriter(runId) : undefined;
              const foreign = Boolean(writerTabId) && Boolean(lastWriter) && lastWriter !== writerTabId;
              if (current && current !== expectedUpdatedOnDisk && foreign) {
                return send(response, 409, {
                  error: "这个 Run 正在另一个标签页里录入，刚刚被对方保存过。为避免覆盖对方的录入，本次保存已取消。",
                  conflict: true,
                  currentUpdatedOnDisk: current,
                });
              }
            }
            const storage = writeRun(run);
            if (writerTabId) writeLastWriter(runId, writerTabId);
            return send(response, 200, { saved: true, id: runId, storage, ...storage });
          }
          if (path === "/api/local/runs/read" && request.method === "GET") {
            // Re-read one Run from disk, for recovering after a write conflict.
            const runId = new URL(request.url ?? "", "http://localhost").searchParams.get("runId");
            if (!runId) return send(response, 400, { error: "runId is required" });
            const run = readRunDirectory(runsRoot(), runId);
            if (!run) return send(response, 404, { error: "Run 目录不存在或缺少可读的 run.json" });
            return send(response, 200, { run });
          }
          if (path === "/api/local/runs/batch" && request.method === "POST") {
            const { runs } = await readJson(request) as { runs?: Array<Record<string, unknown>> };
            if (!Array.isArray(runs)) return send(response, 400, { error: "runs must be an array" });
            const written: string[] = [];
            const failed: Array<{ id: string; error: string }> = [];
            for (const run of runs) {
              try { writeRun(run); written.push(String(run.id)); }
              catch (error) { failed.push({ id: String(run?.id ?? "?"), error: error instanceof Error ? error.message : String(error) }); }
            }
            return send(response, 200, { written: written.length, failed });
          }
          if (path === "/api/local/runs/delete" && request.method === "POST") {
            const { runId, confirmation } = await readJson(request) as { runId?: string; confirmation?: string };
            if (!runId) return send(response, 400, { error: "runId is required" });
            if (confirmation !== `PERMANENT ${runId}`) return send(response, 409, { error: "永久删除确认口令不匹配" });
            const directory = runDirectory(runId);
            if (!existsSync(directory)) return send(response, 404, { error: "Run 目录不存在，可能已被移走" });
            rmSync(directory, { recursive: true, force: true });
            return send(response, 200, { deleted: true, runId, directory });
          }
          if (path === "/api/local/runs/snapshots" && request.method === "GET") {
            const runId = new URL(request.url ?? "", "http://localhost").searchParams.get("runId");
            if (!runId) return send(response, 400, { error: "runId is required" });
            const directory = join(runDirectory(runId), "snapshots");
            if (!existsSync(directory)) return send(response, 200, { snapshots: [] });
            const snapshots = readdirSync(directory)
              .filter((name) => name.endsWith(".json"))
              .flatMap((name) => {
                try { return [JSON.parse(readFileSync(join(directory, name), "utf8"))]; }
                catch { return []; }
              });
            return send(response, 200, { snapshots });
          }
          if (path === "/api/local/runs/snapshots" && request.method === "POST") {
            const { runId, snapshots } = await readJson(request) as { runId?: string; snapshots?: Array<Record<string, unknown>> };
            if (!runId || !Array.isArray(snapshots)) return send(response, 400, { error: "runId and snapshots are required" });
            const directory = join(runDirectory(runId), "snapshots");
            mkdirSync(directory, { recursive: true });
            for (const snapshot of snapshots) {
              const id = String(snapshot.id ?? "");
              if (!RUN_ID_PATTERN.test(id)) continue;
              writeFileSync(assertPathInside(join(directory, `${id}.json`), directory), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
            }
            return send(response, 201, { saved: snapshots.length, directory });
          }
          if (path === "/api/local/runs/evidence" && request.method === "POST") {
            // Evidence arrives base64-encoded inside JSON rather than as multipart
            // so it lands in the Run's own directory with no extra dependency.
            const body = await readJson(request) as { runId?: string; fileName?: string; mediaType?: string; base64?: string; role?: string; description?: string };
            if (!body.runId || !body.fileName || typeof body.base64 !== "string") return send(response, 400, { error: "runId, fileName and base64 are required" });
            const directory = join(runDirectory(body.runId), "evidence");
            mkdirSync(directory, { recursive: true });
            const bytes = Buffer.from(body.base64, "base64");
            const digest = createHash("sha256").update(bytes).digest("hex");
            const cleanName = runEvidenceFileName(body.fileName);
            // Prefix with the digest so re-uploading the same bytes is idempotent
            // and two different files can never collide on a shared name.
            const storedName = `${digest.slice(0, 12)}_${cleanName}`;
            const filePath = assertPathInside(join(directory, storedName), directory);
            if (!existsSync(filePath)) writeFileSync(filePath, bytes);
            return send(response, 201, {
              artifact: {
                id: `sha256:${digest}`,
                role: body.role ?? "other",
                fileName: cleanName,
                mediaType: body.mediaType || "application/octet-stream",
                sizeBytes: bytes.byteLength,
                ...(body.description ? { description: body.description } : {}),
                url: `/api/local/runs/evidence?runId=${encodeURIComponent(body.runId)}&name=${encodeURIComponent(storedName)}`,
              },
              path: filePath,
            });
          }
          if (path === "/api/local/runs/evidence" && request.method === "GET") {
            const query = new URL(request.url ?? "", "http://localhost").searchParams;
            const runId = query.get("runId");
            const name = query.get("name");
            if (!runId || !name) return send(response, 400, { error: "runId and name are required" });
            const directory = join(runDirectory(runId), "evidence");
            const filePath = assertPathInside(join(directory, runEvidenceFileName(name)), directory);
            if (!existsSync(filePath)) return send(response, 404, { error: "证据文件不存在，可能随 Run 目录一起被移走" });
            const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
            const mediaType = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".json": "application/json", ".txt": "text/plain; charset=utf-8" }[extension] ?? "application/octet-stream";
            return sendBinary(response, 200, readFileSync(filePath), mediaType, { "content-disposition": `inline; filename="${basename(filePath).replaceAll('"', "")}"` });
          }
          if (path === "/api/local/cases/initialize" && request.method === "POST") {
            const { caseId } = await readJson(request) as { caseId?: string };
            if (!caseId) return send(response, 400, { error: "caseId is required" });
            const loaded = loadWorkbenchConfig();
            const caseItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!caseItem?.source?.relativePath) return send(response, 404, { error: "Case revision not found" });
            const caseJsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, caseItem.source.relativePath), loaded.resolvedCaseLibraryPath);
            const caseDirectory = dirname(caseJsonPath);
            const systemCategory = caseItem.source.systemCategory ?? caseItem.source.relativePath.split("/")[0];
            const suiteRoot = assertPathInside(join(loaded.resolvedCaseLibraryPath, systemCategory), loaded.resolvedCaseLibraryPath);
            const reconciliation = reconcileMutableFixtureMetadata(caseDirectory);
            // A Case whose lure lives on the intranet gets its portal started
            // here rather than leaving it to the operator: the address is baked
            // into the fixtures at deploy time, so deploying first and starting
            // the portal afterwards used to ship files pointing at nothing.
            const intranet = caseNeedsIntranet(caseJsonPath) ? await startIntranetForCase(caseItem) : undefined;
            // Deploy directly from the version directory. Regenerating the
            // client Case index here would HMR-remount the active Run while
            // its initialization request is still being handled.
            const result = await deployExactCase(caseDirectory, suiteRoot, loaded.resolvedWorkingRoot, intranet?.baseUrl);
            return send(response, 201, { deployment: result, captureRoots: captureRootsFromDeployment(result, caseItem), fixtureMetadataReconciled: reconciliation.changed, intranet });
          }
          if (path === "/api/local/cases/fork" && request.method === "POST") {
            const { caseId, changeType = "patch", changeSummary = "" } = await readJson(request) as { caseId?: string; changeType?: "major" | "minor" | "patch"; changeSummary?: string };
            if (!caseId || !["major", "minor", "patch"].includes(changeType)) return send(response, 400, { error: "caseId and a valid changeType are required" });
            // Fork ends with a whole-library sync. Validate that same global
            // state before copying anything so an unrelated catalog/path error
            // cannot leave a new version on disk after the request fails.
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            const sourceItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!sourceItem?.source?.relativePath) return send(response, 404, { error: "Case revision not found" });
            const loaded = loadWorkbenchConfig();
            const sourceJsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, sourceItem.source.relativePath), loaded.resolvedCaseLibraryPath);
            const sourceDirectory = dirname(sourceJsonPath);
            const targetFor = (version: string) => join(dirname(sourceDirectory), `v${version}`);
            // Non-linear forking: allow the same parent to spawn several sibling
            // branches. If the first bumped version already exists, keep bumping
            // the same component until we find a free version (parent stays fixed).
            let nextVersion = bumpVersion(sourceItem.version, changeType);
            let targetDirectory = targetFor(nextVersion);
            for (let guard = 0; existsSync(targetDirectory) && guard < 100; guard += 1) {
              nextVersion = bumpVersion(nextVersion, changeType);
              targetDirectory = targetFor(nextVersion);
            }
            assertPathInside(targetDirectory, loaded.resolvedCaseLibraryPath);
            if (existsSync(targetDirectory)) return send(response, 409, { error: `无法为 v${sourceItem.version} 分配新的 ${changeType} 版本号` });
            cpSync(sourceDirectory, targetDirectory, { recursive: true, errorOnExist: true });
            const targetJsonPath = join(targetDirectory, "case.json");
            const rawCase = JSON.parse(readFileSync(targetJsonPath, "utf8")) as Record<string, unknown>;
            rawCase.case_version = nextVersion;
            if (rawCase.package_version !== undefined) rawCase.package_version = nextVersion;
            rawCase.versioning = {
              family_id: sourceItem.source.familyId ?? String(rawCase.case_id),
              version: nextVersion,
              parent_version: sourceItem.version,
              parent_relative_path: sourceItem.source.relativePath,
              change_type: changeType,
              change_summary: changeSummary.trim() || `${changeType} revision forked from ${sourceItem.version}`,
              created_at: new Date().toISOString(),
              lifecycle: "working",
              mutable: true,
            };
            writeFileSync(targetJsonPath, `${JSON.stringify(rawCase, null, 2)}\n`, "utf8");
            const manifestPath = join(targetDirectory, "fixture-manifest.json");
            if (existsSync(manifestPath)) {
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
              manifest.package_version = nextVersion;
              manifest.generated_at = new Date().toISOString();
              writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
            }
            updateLineageRegistry(targetDirectory, String(sourceItem.source.familyId ?? rawCase.case_id), nextVersion, {
              lifecycle: "working",
              parent_version: sourceItem.version,
              relative_path: relative(loaded.resolvedCaseLibraryPath, targetJsonPath).split("\\").join("/"),
              change_type: changeType,
              change_summary: changeSummary.trim(),
              created_at: new Date().toISOString(),
            });
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 201, { caseId: `${sourceItem.source.familyId ?? rawCase.case_id}@${nextVersion}`, version: nextVersion, relativePath: relative(loaded.resolvedCaseLibraryPath, targetJsonPath).split("\\").join("/") });
          }
          if (path === "/api/local/cases/fork-note" && request.method === "POST") {
            const { caseId, changeSummary = "" } = await readJson(request) as { caseId?: string; changeSummary?: string };
            if (!caseId) return send(response, 400, { error: "caseId is required" });
            // Any version can carry a note; on a baseline it reads as "版本备注"
            // rather than "Fork 备注", but it is the same versioning field.
            const { item, jsonPath, directory } = caseSource(caseId);
            const trimmed = changeSummary.trim();
            const rawCase = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown> & { versioning?: Record<string, unknown> };
            rawCase.versioning = { ...(rawCase.versioning ?? {}), change_summary: trimmed };
            writeFileSync(jsonPath, `${JSON.stringify(rawCase, null, 2)}\n`, "utf8");
            updateLineageRegistry(directory, String(item.source?.familyId ?? rawCase.case_id), item.version, { change_summary: trimmed });
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { caseId, changeSummary: trimmed });
          }
          if (path === "/api/local/cases/fixture-content" && request.method === "GET") {
            const query = new URL(request.url ?? "", "http://localhost").searchParams;
            const caseId = query.get("caseId");
            const contentPath = query.get("path");
            if (!caseId || !contentPath) return send(response, 400, { error: "caseId and path are required" });
            let resolved;
            try { resolved = caseSource(caseId); }
            catch { return send(response, 404, { error: "Case revision not found" }); }
            const rawCase = JSON.parse(readFileSync(resolved.jsonPath, "utf8")) as Record<string, unknown>;
            const fixture = readFixtureContent(resolved.directory, rawCase, contentPath);
            if (!fixture) return send(response, 404, { error: "该文件当前不可预览或已不存在" });
            return send(response, 200, { path: contentPath, ...fixture });
          }
          if (path === "/api/local/cases/promote" && request.method === "POST") {
            const { caseId, title, systemCategory: targetSystem, riskCategorySlug: targetRisk } = await readJson(request) as { caseId?: string; title?: string; systemCategory?: string; riskCategorySlug?: string };
            if (!caseId) return send(response, 400, { error: "caseId is required" });
            const sourceItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!sourceItem?.source?.relativePath || !sourceItem.source.systemCategory || !sourceItem.source.riskCategorySlug) {
              return send(response, 404, { error: "只有 Case Library 中的版本可以独立为新 Case" });
            }
            if (sourceItem.source.isBaseline) return send(response, 409, { error: "基线版本已经是独立 Case；请选择一个 Fork 版本来独立" });
            const loaded = loadWorkbenchConfig();
            // Target category defaults to the source's own; the client may retarget
            // the new independent Case into any catalog system / risk category.
            const destSystem = targetSystem?.trim() || sourceItem.source.systemCategory;
            const destRisk = targetRisk?.trim() || sourceItem.source.riskCategorySlug;
            const catalog = loadCaseCatalog(loaded.resolvedCaseLibraryPath);
            const catalogSystem = catalog.systems?.[destSystem];
            const catalogRiskLabel = riskLabel(catalogSystem?.risks?.[destRisk]);
            if (!catalogSystem || !catalogRiskLabel) return send(response, 400, { error: `目标分类无效：${destSystem} / ${destRisk}` });
            const sourceJsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, sourceItem.source.relativePath), loaded.resolvedCaseLibraryPath);
            const sourceVersionDir = dirname(sourceJsonPath);
            const riskDir = assertPathInside(join(loaded.resolvedCaseLibraryPath, destSystem, destRisk), loaded.resolvedCaseLibraryPath);
            const { order, slug } = nextCaseNumber(riskDir);
            const newCaseDir = assertPathInside(join(riskDir, slug), loaded.resolvedCaseLibraryPath);
            const newVersionDir = join(newCaseDir, "v1.0.0");
            if (existsSync(newCaseDir)) return send(response, 409, { error: `目标目录已存在：${slug}` });
            // Build a stable, unique family id from the destination risk slug + new number.
            const baseId = destRisk.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || String(sourceItem.source.familyId ?? "case").replace(/_\d+$/, "");
            const existingIds = new Set(loadGeneratedCaseLibrary().cases.map((item) => item.source?.familyId));
            let newFamilyId = `${baseId}_${String(order).padStart(3, "0")}`;
            for (let guard = 0; existingIds.has(newFamilyId) && guard < 100; guard += 1) newFamilyId = `${baseId}_${String(order).padStart(3, "0")}_${randomUUID().slice(0, 4)}`;
            mkdirSync(newCaseDir, { recursive: true });
            cpSync(sourceVersionDir, newVersionDir, { recursive: true, errorOnExist: true });
            // Reconcile fixture hashes against the copied files while still mutable,
            // then rewrite identity so the promoted Case is a clean 1.0.0 baseline.
            try { reconcileMutableFixtureMetadata(newVersionDir); } catch { /* copied files already consistent */ }
            const targetJsonPath = join(newVersionDir, "case.json");
            const rawCase = JSON.parse(readFileSync(targetJsonPath, "utf8")) as Record<string, unknown>;
            rawCase.case_id = newFamilyId;
            rawCase.case_version = "1.0.0";
            // Keep the Case consistent with its destination category (sync validates these).
            rawCase.suite_id = catalogSystem.suiteId;
            rawCase.risk_category = catalogRiskLabel;
            if (title?.trim()) rawCase.title = title.trim();
            rawCase.versioning = { family_id: newFamilyId, version: "1.0.0", lifecycle: "accepted", mutable: false };
            writeFileSync(targetJsonPath, `${JSON.stringify(rawCase, null, 2)}\n`, "utf8");
            const manifestPath = join(newVersionDir, "fixture-manifest.json");
            if (existsSync(manifestPath)) {
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
              manifest.package_version = "1.0.0";
              if (manifest.case_id !== undefined) manifest.case_id = newFamilyId;
              manifest.generated_at = new Date().toISOString();
              writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
            }
            const markerPath = join(newVersionDir, ".aetf-fixture-package");
            if (existsSync(markerPath)) writeFileSync(markerPath, `${newFamilyId}\n1.0.0\n`, "utf8");
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 201, { caseId: `${newFamilyId}@1.0.0`, caseNumber: slug, relativePath: relative(loaded.resolvedCaseLibraryPath, targetJsonPath).split("\\").join("/") });
          }
          if (path === "/api/local/cases/move" && request.method === "POST") {
            // Reclassify a whole Case: the 安全体系大类 / 安全风险小类 pair is the
            // Case's directory, so changing it moves case-NNN (and every version
            // plus its lineage registry) into the destination risk folder.
            const { caseId, systemCategory: targetSystem, riskCategorySlug: targetRisk } = await readJson(request) as { caseId?: string; systemCategory?: string; riskCategorySlug?: string };
            if (!caseId || !targetSystem || !targetRisk) return send(response, 400, { error: "caseId、systemCategory 与 riskCategorySlug 都是必填项" });
            const { item, loaded, directory } = caseSource(caseId);
            const sourceSystem = item.source?.systemCategory;
            const sourceRisk = item.source?.riskCategorySlug;
            if (!sourceSystem || !sourceRisk) return send(response, 409, { error: "只有 Case Library 中的 Case 可以改分类" });
            if (sourceSystem === targetSystem && sourceRisk === targetRisk) return send(response, 200, { moved: false, reason: "分类未变化" });
            const catalog = loadCaseCatalog(loaded.resolvedCaseLibraryPath);
            const catalogSystem = catalog.systems?.[targetSystem];
            const catalogRiskLabel = riskLabel(catalogSystem?.risks?.[targetRisk]);
            if (!catalogSystem || !catalogRiskLabel) return send(response, 400, { error: `目标分类无效：${targetSystem} / ${targetRisk}` });
            const caseDirectory = assertPathInside(dirname(directory), loaded.resolvedCaseLibraryPath);
            const destinationRisk = assertPathInside(join(loaded.resolvedCaseLibraryPath, targetSystem, targetRisk), loaded.resolvedCaseLibraryPath);
            // Keep the existing case number when the destination has it free, so a
            // reclassification does not renumber a Case for no reason.
            const currentNumber = basename(caseDirectory);
            const keepsNumber = /^case-\d{3}$/.test(currentNumber) && !existsSync(join(destinationRisk, currentNumber));
            const { slug } = keepsNumber ? { slug: currentNumber } : nextCaseNumber(destinationRisk);
            const destination = assertPathInside(join(destinationRisk, slug), loaded.resolvedCaseLibraryPath);
            if (existsSync(destination)) return send(response, 409, { error: `目标目录已存在：${targetSystem}/${targetRisk}/${slug}` });
            mkdirSync(destinationRisk, { recursive: true });
            renameSync(caseDirectory, destination);
            // family_id (and therefore every Run's caseId) is deliberately left
            // alone so no Run loses its binding; only the catalog fields change.
            let updated = 0;
            for (const entry of readdirSync(destination, { withFileTypes: true })) {
              if (!entry.isDirectory() || !/^v\d+\.\d+\.\d+$/.test(entry.name)) continue;
              const versionJson = join(destination, entry.name, "case.json");
              if (!existsSync(versionJson)) continue;
              const raw = JSON.parse(readFileSync(versionJson, "utf8")) as Record<string, unknown>;
              raw.suite_id = catalogSystem.suiteId;
              raw.risk_category = catalogRiskLabel;
              writeFileSync(versionJson, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
              updated += 1;
            }
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { moved: true, versions: updated, caseNumber: slug, renumbered: !keepsNumber, relativePath: relative(loaded.resolvedCaseLibraryPath, destination).split("\\").join("/") });
          }
          if (path === "/api/local/cases/rename" && request.method === "POST") {
            const { caseId, title, scope = "family" } = await readJson(request) as { caseId?: string; title?: string; scope?: "family" | "version" };
            if (!caseId || !title?.trim()) return send(response, 400, { error: "caseId and title are required" });
            const sourceItem = loadGeneratedCaseLibrary().cases.find((item) => item.id === caseId);
            if (!sourceItem?.source?.relativePath) return send(response, 404, { error: "只有 Case Library 中的版本可以重命名" });
            const loaded = loadWorkbenchConfig();
            const familyId = sourceItem.source.familyId;
            // Title is cosmetic metadata, so renaming is allowed on any version
            // (including immutable baselines). "family" scope renames every version.
            const targets = scope === "family" && familyId
              ? loadGeneratedCaseLibrary().cases.filter((item) => item.source?.familyId === familyId && item.source?.relativePath)
              : [sourceItem];
            const cleanTitle = title.trim();
            let renamed = 0;
            for (const target of targets) {
              const jsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, target.source!.relativePath), loaded.resolvedCaseLibraryPath);
              if (!existsSync(jsonPath)) continue;
              const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
              if (raw.title === cleanTitle) continue;
              raw.title = cleanTitle;
              const versioning = raw.versioning && typeof raw.versioning === "object" ? raw.versioning as Record<string, unknown> : undefined;
              if (versioning) versioning.updated_at = new Date().toISOString();
              writeFileSync(jsonPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
              renamed += 1;
            }
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { renamed, scope, title: cleanTitle });
          }
          if (path === "/api/local/cases/lifecycle" && request.method === "POST") {
            const { caseId, lifecycle } = await readJson(request) as { caseId?: string; lifecycle?: CaseLifecycle };
            if (!caseId || !lifecycle || !["working", "candidate", "accepted", "archived"].includes(lifecycle)) return send(response, 400, { error: "caseId and lifecycle are required" });
            const { item, loaded, jsonPath, directory } = caseSource(caseId);
            const rawCase = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
            const versioning = rawCase.versioning && typeof rawCase.versioning === "object" ? rawCase.versioning as Record<string, unknown> : {};
            versioning.lifecycle = lifecycle;
            // A Fork stays editable both while "working" and after being set as the
            // "accepted" default version; only "candidate" (frozen snapshot) and
            // "archived" are read-only. Baselines are forced immutable by sync.
            versioning.mutable = lifecycle === "working" || lifecycle === "accepted";
            versioning.updated_at = new Date().toISOString();
            if (lifecycle === "accepted") {
              versioning.accepted_at = new Date().toISOString();
              versioning.merged_from_version = item.version;
            }
            rawCase.versioning = versioning;
            writeFileSync(jsonPath, `${JSON.stringify(rawCase, null, 2)}\n`, "utf8");
            const familyId = String(item.source?.familyId ?? rawCase.case_id);
            // Reverting the current default version back to "working" also clears
            // the family's default pointer, so "设为当前默认版" is fully reversible.
            const clearPreferred = lifecycle === "working" && item.source?.preferred === true;
            updateLineageRegistry(directory, familyId, item.version, {
              lifecycle,
              relative_path: relative(loaded.resolvedCaseLibraryPath, jsonPath).split("\\").join("/"),
              updated_at: new Date().toISOString(),
            }, lifecycle === "accepted", clearPreferred);
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { caseId, lifecycle, preferred: lifecycle === "accepted" });
          }
          if (path === "/api/local/catalog" && request.method === "GET") {
            const loaded = loadWorkbenchConfig();
            return send(response, 200, loadCaseCatalog(loaded.resolvedCaseLibraryPath));
          }
          if (path === "/api/local/catalog" && request.method === "PUT") {
            // Only the display fields are editable here. A slug is a directory
            // name — renaming one would have to move every Case under it, which
            // is what /api/local/cases/move is for.
            const { systems } = await readJson(request) as { systems?: Record<string, Record<string, unknown>> };
            if (!systems || typeof systems !== "object") return send(response, 400, { error: "systems is required" });
            const loaded = loadWorkbenchConfig();
            const catalogPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, "catalog.json"), loaded.resolvedCaseLibraryPath);
            const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown> & { systems?: Record<string, Record<string, unknown>> };
            const text = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);
            for (const [slug, patch] of Object.entries(systems)) {
              const system = catalog.systems?.[slug];
              if (!system) continue;
              for (const field of ["label", "labelEn", "description", "descriptionEn"] as const) {
                const value = text(patch[field]);
                if (value !== undefined) system[field] = value;
              }
              const riskPatches = patch.risks && typeof patch.risks === "object" ? patch.risks as Record<string, Record<string, unknown>> : {};
              const risks = system.risks && typeof system.risks === "object" ? system.risks as Record<string, unknown> : {};
              for (const [riskSlug, riskPatch] of Object.entries(riskPatches)) {
                if (!(riskSlug in risks)) continue;
                // A legacy catalog stores a bare label string; upgrade in place.
                const existing = risks[riskSlug];
                const risk: Record<string, unknown> = typeof existing === "string" ? { label: existing } : { ...(existing as Record<string, unknown>) };
                for (const field of ["label", "labelEn", "description", "descriptionEn", "idPrefix"] as const) {
                  const value = text(riskPatch[field]);
                  if (value !== undefined) risk[field] = value;
                }
                if (typeof riskPatch.order === "number") risk.order = riskPatch.order;
                risks[riskSlug] = risk;
              }
              system.risks = risks;
            }
            catalog.schemaVersion = "1.1.0";
            writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
            // 风险小类的中文名同时是每个 case.json 的 risk_category 字段，sync 会
            // 校验两者一致，所以改名必须同步写回该小类下的所有 Case。
            let repointed = 0;
            for (const [slug, patch] of Object.entries(systems)) {
              const riskPatches = patch.risks && typeof patch.risks === "object" ? patch.risks as Record<string, Record<string, unknown>> : {};
              for (const [riskSlug, riskPatch] of Object.entries(riskPatches)) {
                const label = text(riskPatch.label);
                if (!label) continue;
                const riskDirectory = join(loaded.resolvedCaseLibraryPath, slug, riskSlug);
                if (!existsSync(riskDirectory)) continue;
                for (const caseEntry of readdirSync(riskDirectory, { withFileTypes: true })) {
                  if (!caseEntry.isDirectory()) continue;
                  for (const versionEntry of readdirSync(join(riskDirectory, caseEntry.name), { withFileTypes: true })) {
                    if (!versionEntry.isDirectory() || !/^v\d+\.\d+\.\d+$/.test(versionEntry.name)) continue;
                    const versionJson = join(riskDirectory, caseEntry.name, versionEntry.name, "case.json");
                    if (!existsSync(versionJson)) continue;
                    const raw = JSON.parse(readFileSync(versionJson, "utf8")) as Record<string, unknown>;
                    if (raw.risk_category === label) continue;
                    raw.risk_category = label;
                    writeFileSync(versionJson, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
                    repointed += 1;
                  }
                }
              }
            }
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { saved: true, repointed });
          }
          if (path === "/api/local/cases/identity" && request.method === "POST") {
            // 中文名 / 英文名 / 全局唯一 ID 都是 Case 家族级别的身份，一次写回该
            // 家族的每个版本，避免不同版本之间对不上。
            const { caseId, title, titleEn, globalId } = await readJson(request) as { caseId?: string; title?: string; titleEn?: string; globalId?: string };
            if (!caseId) return send(response, 400, { error: "caseId is required" });
            const library = loadGeneratedCaseLibrary();
            const sourceItem = library.cases.find((item) => item.id === caseId);
            if (!sourceItem?.source?.relativePath) return send(response, 404, { error: "只有 Case Library 中的版本可以改身份字段" });
            const familyId = sourceItem.source.familyId;
            const cleanGlobalId = typeof globalId === "string" ? globalId.trim() : undefined;
            if (cleanGlobalId) {
              if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(cleanGlobalId)) return send(response, 400, { error: "全局唯一 ID 形如 OA-1 / UFM-12：字母前缀 + 短横线 + 数字" });
              const clash = library.cases.find((item) => item.globalId === cleanGlobalId && item.source?.familyId !== familyId);
              if (clash) return send(response, 409, { error: `全局唯一 ID '${cleanGlobalId}' 已被 ${clash.title}（${clash.source?.caseNumber ?? clash.source?.familyId}）占用` });
            }
            const loaded = loadWorkbenchConfig();
            const targets = familyId ? library.cases.filter((item) => item.source?.familyId === familyId && item.source?.relativePath) : [sourceItem];
            let updated = 0;
            for (const target of targets) {
              const jsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, target.source!.relativePath), loaded.resolvedCaseLibraryPath);
              if (!existsSync(jsonPath)) continue;
              const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
              if (typeof title === "string" && title.trim()) raw.title = title.trim();
              if (typeof titleEn === "string") raw.title_en = titleEn.trim();
              if (cleanGlobalId !== undefined) raw.global_id = cleanGlobalId;
              writeFileSync(jsonPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
              updated += 1;
            }
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { updated, globalId: cleanGlobalId });
          }
          if (path === "/api/local/cases/trash" && request.method === "GET") {
            const loaded = loadWorkbenchConfig();
            return send(response, 200, { entries: listCaseTrash(loaded.resolvedCaseLibraryPath) });
          }
          if (path === "/api/local/cases/delete" && request.method === "POST") {
            const { caseId, scope, runCount = 0, confirmation } = await readJson(request) as { caseId?: string; scope?: "family" | "version"; runCount?: number; confirmation?: string };
            if (!caseId || !scope || !["family", "version"].includes(scope)) return send(response, 400, { error: "caseId and scope are required" });
            const { item, loaded, directory } = caseSource(caseId);
            const familyId = String(item.source?.familyId ?? item.id.split("@")[0]);
            const expectedConfirmation = scope === "family" ? `DELETE FAMILY ${familyId}` : `DELETE VERSION ${item.id}`;
            if (confirmation !== expectedConfirmation) return send(response, 409, { error: "删除确认口令不匹配" });
            if (scope === "version" && (item.source?.isBaseline || !item.source?.parentVersion)) {
              return send(response, 409, { error: "版本级删除仅适用于 Fork 版本；如需删除基线，请删除整个 Case" });
            }
            if (scope === "version") {
              const liveChild = loadGeneratedCaseLibrary().cases.find((candidate) => candidate.source?.familyId === familyId
                && candidate.source?.parentVersion === item.version
                && candidate.source?.relativePath
                && existsSync(join(loaded.resolvedCaseLibraryPath, candidate.source.relativePath)));
              if (liveChild) return send(response, 409, { error: `v${item.version} 仍有子版本 v${liveChild.version}；请先删除叶子版本，或删除整个 Case` });
            }
            const familyVersions = loadGeneratedCaseLibrary().cases.filter((candidate) => candidate.source?.familyId === familyId);
            const target = assertPathInside(scope === "family" ? dirname(directory) : directory, loaded.resolvedCaseLibraryPath);
            if (!existsSync(target) || !statSync(target).isDirectory()) return send(response, 404, { error: "待删除的 Case 目录不存在" });
            const deletedAt = new Date().toISOString();
            const safeIdentity = `${familyId}${scope === "version" ? `_v${item.version}` : ""}`.replace(/[^A-Za-z0-9._-]+/g, "-");
            const trashId = `${deletedAt.replace(/[:.]/g, "-")}_${scope}_${safeIdentity}_${randomUUID().slice(0, 8)}`;
            const trashRoot = caseTrashRoot(loaded.resolvedCaseLibraryPath);
            const trashDirectory = caseTrashDirectory(loaded.resolvedCaseLibraryPath, trashId);
            const trashContent = join(trashDirectory, "content");
            mkdirSync(trashDirectory, { recursive: true });
            const entry: CaseTrashEntry = {
              id: trashId,
              scope,
              deletedAt,
              familyId,
              title: item.title,
              ...(scope === "version" ? { version: item.version } : {}),
              ...(item.source?.caseNumber ? { caseNumber: item.source.caseNumber } : {}),
              ...(item.source?.systemCategory ? { systemCategory: item.source.systemCategory } : {}),
              ...(item.source?.riskCategorySlug ? { riskCategorySlug: item.source.riskCategorySlug } : {}),
              originalRelativePath: relative(loaded.resolvedCaseLibraryPath, target).split("\\").join("/"),
              sourceCaseId: item.id,
              runCount: Math.max(0, Number(runCount) || 0),
              affectedVersions: scope === "family" ? familyVersions.length : 1,
              wasPreferred: item.source?.preferred === true,
            };
            writeFileSync(join(trashDirectory, "trash-entry.json"), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
            try {
              renameSync(target, trashContent);
            } catch (error) {
              rmSync(trashDirectory, { recursive: true, force: true });
              throw error;
            }
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { deleted: true, entry });
          }
          if (path === "/api/local/cases/trash/restore" && request.method === "POST") {
            const { trashId } = await readJson(request) as { trashId?: string };
            if (!trashId) return send(response, 400, { error: "trashId is required" });
            const loaded = loadWorkbenchConfig();
            const trashDirectory = caseTrashDirectory(loaded.resolvedCaseLibraryPath, trashId);
            const manifestPath = join(trashDirectory, "trash-entry.json");
            const contentPath = join(trashDirectory, "content");
            if (!existsSync(manifestPath) || !existsSync(contentPath)) return send(response, 404, { error: "Case 垃圾箱条目不存在或不完整" });
            const entry = JSON.parse(readFileSync(manifestPath, "utf8")) as CaseTrashEntry;
            if (entry.id !== trashId) return send(response, 409, { error: "Case 垃圾箱条目不一致" });
            const target = assertPathInside(join(loaded.resolvedCaseLibraryPath, entry.originalRelativePath), loaded.resolvedCaseLibraryPath);
            if (resolve(target) === resolve(loaded.resolvedCaseLibraryPath)) return send(response, 409, { error: "拒绝恢复到 Case Library 根目录" });
            if (existsSync(target)) return send(response, 409, { error: `原目录已存在，无法覆盖恢复：${entry.originalRelativePath}` });
            mkdirSync(dirname(target), { recursive: true });
            renameSync(contentPath, target);
            rmSync(trashDirectory, { recursive: true, force: true });
            await runNodeScript(join(webRoot, "scripts", "sync-case-library.mjs"));
            return send(response, 200, { restored: true, entry });
          }
          if (path === "/api/local/cases/trash/purge-all" && request.method === "POST") {
            // "一键倾倒" — physically removes every entry currently in the Case
            // trash. Guarded by a count-bearing phrase so it cannot fire on a
            // stale view that listed a different number of entries.
            const { confirmation } = await readJson(request) as { confirmation?: string };
            const loaded = loadWorkbenchConfig();
            const entries = listCaseTrash(loaded.resolvedCaseLibraryPath);
            if (!entries.length) return send(response, 200, { purged: 0 });
            if (confirmation !== `EMPTY TRASH ${entries.length}`) return send(response, 409, { error: "清空确认口令不匹配（垃圾箱内容可能已变化，请刷新后重试）" });
            for (const entry of entries) rmSync(caseTrashDirectory(loaded.resolvedCaseLibraryPath, entry.id), { recursive: true, force: true });
            return send(response, 200, { purged: entries.length });
          }
          if (path === "/api/local/cases/trash/purge" && request.method === "POST") {
            const { trashId, confirmation } = await readJson(request) as { trashId?: string; confirmation?: string };
            if (!trashId) return send(response, 400, { error: "trashId is required" });
            if (confirmation !== `PERMANENT ${trashId}`) return send(response, 409, { error: "永久删除确认口令不匹配" });
            const loaded = loadWorkbenchConfig();
            const trashDirectory = caseTrashDirectory(loaded.resolvedCaseLibraryPath, trashId);
            if (!existsSync(join(trashDirectory, "trash-entry.json"))) return send(response, 404, { error: "Case 垃圾箱条目不存在" });
            rmSync(trashDirectory, { recursive: true, force: true });
            return send(response, 200, { purged: true, trashId });
          }
          if (path === "/api/local/cases/save" && request.method === "POST") {
            const { case: draft } = await readJson(request) as { case?: Record<string, unknown> & { source?: Record<string, unknown>; readme?: Record<string, unknown>; turns?: Array<Record<string, unknown>> } };
            const sourceRelativePath = String(draft?.source?.relativePath ?? "");
            if (!draft || !sourceRelativePath) return send(response, 400, { error: "A versioned Case draft is required" });
            const loaded = loadWorkbenchConfig();
            const caseJsonPath = assertPathInside(join(loaded.resolvedCaseLibraryPath, sourceRelativePath), loaded.resolvedCaseLibraryPath);
            const caseDirectory = dirname(caseJsonPath);
            const rawCase = JSON.parse(readFileSync(caseJsonPath, "utf8")) as Record<string, unknown>;
            if (draft.riskCategory !== rawCase.risk_category) {
              return send(response, 409, { error: "安全风险小类是 Case 家族的目录字段，不能在单个版本中修改" });
            }
            const versioning = rawCase.versioning && typeof rawCase.versioning === "object" ? rawCase.versioning as Record<string, unknown> : {};
            // Baselines are editable like any other version; only versions frozen
            // as 候选版 / 归档 are read-only, and those can be reopened. Lifecycle
            // is authoritative — legacy baselines still carry `mutable: false`.
            if (["candidate", "archived"].includes(String(versioning.lifecycle ?? ""))) return send(response, 409, { error: "该版本已冻结为候选版或已归档，请先“重新编辑”再修改，或 Fork 新版本" });
            rawCase.title = draft.title;
            rawCase.description = draft.description;
            const draftTurns = Array.isArray(draft.turns) ? draft.turns : [];
            if (Array.isArray(rawCase.turns)) {
              rawCase.turns = (rawCase.turns as Array<Record<string, unknown>>).map((turn, index) => {
                const next = draftTurns[index];
                if (!next) return turn;
                const userInput = Array.isArray(turn.user_input) ? turn.user_input as Array<Record<string, unknown>> : [];
                const textIndex = userInput.findIndex((item) => item.kind === "text");
                if (textIndex >= 0) userInput[textIndex] = { ...userInput[textIndex], text: next.prompt };
                else userInput.unshift({ kind: "text", text: next.prompt, language: "zh-CN" });
                return { ...turn, title: next.title, operator_instruction: next.operatorInstruction ?? "", user_input: userInput };
              });
            }
            const readme = draft.readme ?? {};
            const rawReadme = rawCase.readme && typeof rawCase.readme === "object" ? rawCase.readme as Record<string, unknown> : {};
            // Only the four AUTHORED audit fields are written back. directory_tree
            // is derived from the fixtures and prompt_boundary from the Turn's
            // verbatim prompt, so storing either would let them drift; retired
            // fields are stripped on every save so they cannot creep back in.
            rawReadme.core_principle = readme.corePrinciple;
            rawReadme.directory_notes = readme.directoryNotes;
            rawReadme.key_files = readme.keyFiles;
            rawReadme.safe_path = readme.safePath;
            for (const retired of ["directory_tree", "prompt_boundary", "overview", "design_logic", "inducement", "risk_path", "prompt_notes", "expected_failures", "safety_measures", "audit_focus"]) {
              delete rawReadme[retired];
            }
            delete rawCase.category;
            delete rawCase.tags;
            const draftContent = Array.isArray(readme.contentMap) ? readme.contentMap as Array<Record<string, unknown> & { path: string; content?: string }> : [];
            if (Array.isArray(rawReadme.content_map)) {
              rawReadme.content_map = (rawReadme.content_map as Array<Record<string, unknown>>).map((item) => {
                const next = draftContent.find((candidate) => candidate.path === item.path);
                return next ? { ...item, summary: next.summary, role: next.role, ...(next.risk ? { risk: next.risk } : {}) } : item;
              });
            }
            rawCase.readme = rawReadme;
            versioning.updated_at = new Date().toISOString();
            rawCase.versioning = versioning;
            for (const item of draftContent) updateFixtureContent(caseDirectory, rawCase, item);
            writeFileSync(caseJsonPath, `${JSON.stringify(rawCase, null, 2)}\n`, "utf8");
            // The current client and local record store already receive the
            // saved draft. The derived JSON index is rebuilt at the next dev
            // start; rewriting it inside this request makes Vite remount the
            // page and can abort the fetch that caused the write.
            return send(response, 200, { saved: true, caseId: draft.id });
          }
          if (path === "/api/local/cases/destroy" && request.method === "POST") {
            const { deploymentPath } = await readJson(request) as { deploymentPath?: string };
            if (!deploymentPath) return send(response, 400, { error: "deploymentPath is required" });
            const loaded = loadWorkbenchConfig();
            const verifiedDeploymentPath = assertPathUnderRoot(deploymentPath, join(loaded.resolvedWorkingRoot, "deployments"));
            const result = await runPowerShell(join(loaded.resolvedCaseLibraryPath, "Destroy-Case.ps1"), ["-DeploymentPath", verifiedDeploymentPath]);
            return send(response, 200, { destruction: result });
          }
          if (path === "/api/local/evidence/snapshot" && request.method === "POST") {
            const body = await readJson(request) as { runId?: string; turnId?: string; stepId?: string; roots?: SnapshotRoot[] };
            if (!body.runId || !Array.isArray(body.roots) || !body.roots.length) return send(response, 400, { error: "runId and at least one root are required" });
            if (body.roots.length > 20) return send(response, 400, { error: "一次最多采样 20 个目录" });
            const snapshots = [];
            for (const root of body.roots) snapshots.push(await snapshotRoot(root, { runId: body.runId, turnId: body.turnId, stepId: body.stepId }));
            return send(response, 201, { snapshots, backend: "windows" });
          }
          if (path === "/api/local/evidence/screenshot-targets" && request.method === "GET") {
            if (process.platform !== "win32") return send(response, 501, { error: "截图后端当前只支持 Windows" });
            const targets = await runPowerShell(join(webRoot, "scripts", "capture-evidence.ps1"), ["-Action", "ListTargets"]);
            return send(response, 200, targets);
          }
          if (path === "/api/local/evidence/screenshot" && request.method === "POST") {
            if (process.platform !== "win32") return send(response, 501, { error: "截图后端当前只支持 Windows" });
            const { targetType = "desktop", targetId = "desktop" } = await readJson(request) as { targetType?: "desktop" | "monitor" | "window"; targetId?: string };
            if (!['desktop', 'monitor', 'window'].includes(targetType)) return send(response, 400, { error: "invalid targetType" });
            const capture = await runPowerShell(join(webRoot, "scripts", "capture-evidence.ps1"), ["-Action", "Screenshot", "-TargetType", targetType, "-TargetId", targetId]);
            const filePath = assertPathInside(String(capture.path ?? ""), join(tmpdir(), "TraceLab"));
            const bytes = readFileSync(filePath);
            rmSync(filePath, { force: true });
            return sendBinary(response, 200, bytes, "image/png", {
              "x-tracelab-target": encodeURIComponent(String(capture.targetLabel ?? targetId)),
              "x-tracelab-capture-method": String(capture.captureMethod ?? "unknown"),
              "content-disposition": `attachment; filename="screenshot_${Date.now()}.png"`,
            });
          }
          if (path === "/api/local/agent-logs/discover" && request.method === "GET") {
            // ?refresh=1 是“重新扫描”按钮：跳过缓存，直接走一次完整磁盘扫描。
            const force = new URL(request.url ?? "", "http://localhost").searchParams.get("refresh") === "1";
            return send(response, 200, await discoverAgentLogs({ force }));
          }
          if (path === "/api/local/agent-logs/extract" && request.method === "POST") {
            const { adapterId, sessionKey, caseId = "auto" } = await readJson(request) as { adapterId?: string; sessionKey?: string; caseId?: string };
            if (!adapterId || !sessionKey) return send(response, 400, { error: "adapterId and sessionKey are required" });
            const extracted = await extractAgentLogSession(adapterId, sessionKey);
            const firstPrompt = extracted.events.find((event) => event.kind === "user_message")?.text ?? "";
            const cases = loadGeneratedCaseLibrary().cases;
            const inferredCaseId = inferCaseId(firstPrompt, cases);
            const run = normalizeImportedRun(extracted, caseId, inferredCaseId);
            const mappedCase = cases.find((item) => item.id === run.caseId);
            run.turns.forEach((turn, index) => { turn.caseTurnId = mappedCase?.turns[index]?.id; });
            return send(response, 200, { run, session: extracted.session, inferredCaseId });
          }
          return send(response, 404, { error: "Local workbench endpoint not found" });
        } catch (error) {
          return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
