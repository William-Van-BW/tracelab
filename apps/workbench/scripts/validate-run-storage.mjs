/**
 * Out-of-band smoke test for the filesystem Run store. Bundles the dev plugin
 * with esbuild, mounts its middleware, and drives the /api/local/runs endpoints
 * against a throwaway runs root so nothing touches the operator's real data.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// esbuild ships inside vite rather than as a direct dependency, so resolve it
// through vite instead of adding a top-level dev dependency just for this test.
const fromWeb = createRequire(join(webRoot, "package.json"));
const { build } = await import(pathToFileURL(createRequire(fromWeb.resolve("vite/package.json")).resolve("esbuild")).href);
const sandbox = mkdtempSync(join(tmpdir(), "tracelab-smoke-"));
const runsRoot = join(sandbox, "runs");
const workingRoot = join(sandbox, "work");
const libraryRoot = join(sandbox, "library");
mkdirSync(workingRoot, { recursive: true });
mkdirSync(libraryRoot, { recursive: true });
const configPath = join(sandbox, "aetf-workbench.json");
writeFileSync(configPath, JSON.stringify({ schemaVersion: "0.5.0", caseLibraryPath: libraryRoot, workingRoot, runsRoot }, null, 2));
process.env.AETF_WORKBENCH_CONFIG = configPath;

const bundlePath = join(sandbox, "plugin.mjs");
await build({
  entryPoints: [join(webRoot, "build/local-workbench-plugin.ts")],
  bundle: true, platform: "node", format: "esm", outfile: bundlePath,
  external: ["vite", "node:*", "better-sqlite3"],
  absWorkingDir: webRoot,
});

const { localWorkbench } = await import(`file://${bundlePath.replaceAll("\\", "/")}`);
let middleware;
localWorkbench().configureServer({ middlewares: { use: (fn) => { middleware = fn; } } });

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const request = new PassThrough();
    request.method = method;
    request.url = url;
    if (body !== undefined) request.end(JSON.stringify(body)); else request.end();
    const chunks = [];
    const response = {
      statusCode: 200, headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      end(payload) { if (payload) chunks.push(Buffer.from(payload)); resolve({ status: this.statusCode, body: Buffer.concat(chunks) }); },
    };
    middleware(request, response, () => reject(new Error(`unhandled route ${method} ${url}`)));
  });
}
const json = async (...args) => { const r = await call(...args); return { status: r.status, body: JSON.parse(r.body.toString("utf8")) }; };

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

// 1. Empty scan creates the root.
let scan = await json("GET", "/api/local/runs");
check("empty scan", scan.status === 200 && scan.body.runs.length === 0, `runsRoot=${scan.body.runsRoot}`);
check("runs root created", existsSync(runsRoot));

// 2. Write a Run, then read it back with derived storage.
const run = { id: "run_20260730_101010_ab12", name: "冒烟 Run", agentId: "agent_workbuddy", caseId: "fs_x@1.0.0", attempt: 1, status: "in_progress", outcome: "not_evaluated", model: "Auto", permissionMode: "默认", startedAt: "2026-07-30T10:10:10.000Z", updatedAt: "2026-07-30T10:10:10.000Z", turns: [], verdicts: [], annotations: [], summaries: [], storage: { directory: "SHOULD_NOT_PERSIST" } };
const saved = await json("POST", "/api/local/runs", { run });
check("write run", saved.status === 200 && saved.body.storage.runJsonPath.includes("run.json"), saved.body.storage?.runJsonPath);
const onDisk = JSON.parse(readFileSync(join(runsRoot, run.id, "run.json"), "utf8"));
check("storage not persisted", onDisk.storage === undefined);
check("payload intact", onDisk.name === "冒烟 Run" && onDisk.agentId === "agent_workbuddy");

scan = await json("GET", "/api/local/runs");
check("scan finds run", scan.body.runs.length === 1 && scan.body.runs[0].id === run.id);
check("scan derives storage", scan.body.runs[0].storage?.directory === join(runsRoot, run.id));

// 3. Snapshots land inside the Run directory.
const snapshot = { id: "snapshot_1_aaaa", runId: run.id, rootName: "Workspace", capturedAt: "2026-07-30T10:11:00.000Z", fileCount: 3, totalBytes: 99, truncated: false, entries: [] };
const snapWrite = await json("POST", "/api/local/runs/snapshots", { runId: run.id, snapshots: [snapshot] });
check("write snapshot", snapWrite.status === 201 && existsSync(join(runsRoot, run.id, "snapshots", "snapshot_1_aaaa.json")));
const snapRead = await json("GET", `/api/local/runs/snapshots?runId=${run.id}`);
check("read snapshot", snapRead.body.snapshots.length === 1 && snapRead.body.snapshots[0].rootName === "Workspace");

// 4. Evidence round-trips through the Run directory.
const png = Buffer.from("89504e470d0a1a0a", "hex");
const evidence = await json("POST", "/api/local/runs/evidence", { runId: run.id, fileName: "截图 1.png", mediaType: "image/png", role: "screenshot", base64: png.toString("base64") });
check("write evidence", evidence.status === 201 && evidence.body.artifact.url.startsWith("/api/local/runs/evidence?"), evidence.body.artifact.url);
const fetched = await call("GET", evidence.body.artifact.url.replace("/api/local/runs/evidence", "/api/local/runs/evidence"));
check("read evidence bytes", fetched.status === 200 && fetched.body.equals(png));
const evidenceAgain = await json("POST", "/api/local/runs/evidence", { runId: run.id, fileName: "截图 1.png", mediaType: "image/png", role: "screenshot", base64: png.toString("base64") });
check("evidence idempotent", evidenceAgain.body.artifact.url === evidence.body.artifact.url);

// 5. Archiving the directory hides the Run; restoring brings it and its evidence back.
const archive = join(sandbox, "archive", run.id);
mkdirSync(join(sandbox, "archive"), { recursive: true });
renameSync(join(runsRoot, run.id), archive);
scan = await json("GET", "/api/local/runs");
check("archived run disappears", scan.body.runs.length === 0);
renameSync(archive, join(runsRoot, run.id));
scan = await json("GET", "/api/local/runs");
check("restored run reappears", scan.body.runs.length === 1 && scan.body.runs[0].name === "冒烟 Run");
const afterRestore = await call("GET", evidence.body.artifact.url);
check("restored evidence readable", afterRestore.status === 200 && afterRestore.body.equals(png));

// 6. A stray directory is reported, not crashed on.
mkdirSync(join(runsRoot, "run_broken_dir"), { recursive: true });
scan = await json("GET", "/api/local/runs");
check("stray dir reported", scan.body.skipped.includes("run_broken_dir") && scan.body.runs.length === 1);

// 7. Path traversal and bad ids are rejected.
const traversal = await json("POST", "/api/local/runs", { run: { id: "../escape" } });
check("rejects traversal id", traversal.status === 500 && /无效的 Run ID/.test(traversal.body.error), traversal.body.error);
const badEvidence = await json("GET", `/api/local/runs/evidence?runId=${run.id}&name=..%2F..%2Frun.json`);
check("rejects evidence traversal", badEvidence.status >= 400, JSON.stringify(badEvidence.body));

// 8. Permanent delete needs the confirmation phrase and removes the directory.
const noPhrase = await json("POST", "/api/local/runs/delete", { runId: run.id, confirmation: "nope" });
check("delete needs phrase", noPhrase.status === 409);
const deleted = await json("POST", "/api/local/runs/delete", { runId: run.id, confirmation: `PERMANENT ${run.id}` });
check("delete removes dir", deleted.status === 200 && !existsSync(join(runsRoot, run.id)));

rmSync(sandbox, { recursive: true, force: true });
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
