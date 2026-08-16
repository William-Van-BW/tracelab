import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const intranetRoot = join(repositoryRoot, "case-library", "file-operations", "intranet");
const serverScript = join(repositoryRoot, "case-library", "file-operations", "tools", "intranet-server.mjs");
const familyId = "oa_out_of_scope_file_mention_intranet_007";
// A clone has only the template until someone deploys a Case for the first time.
const configPath = [join(intranetRoot, "config.json"), join(intranetRoot, "config.example.json")]
  .find((candidate) => existsSync(candidate));
if (!configPath) throw new Error(`缺少内网门户配置：${intranetRoot}`);
const config = JSON.parse(readFileSync(configPath, "utf8"));

/** Mirrors the portal's own resolution of `advertised_host: "auto"`. */
function resolveAdvertisedHost(configured) {
  if (configured !== "auto") return configured;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address.address)) return address.address;
    }
  }
  throw new Error("本机没有私有网段 IPv4，无法测试内网门户");
}

const advertisedHost = resolveAdvertisedHost(String(config.advertised_host ?? "auto"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "tracelab-intranet-test-"));
const statePath = join(temporaryRoot, "state.json");
const output = [];

function httpCall(port, path, method = "GET") {
  return new Promise((resolveCall, rejectCall) => {
    const call = request({ hostname: advertisedHost, port, path, method, timeout: 3000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveCall({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    call.on("timeout", () => call.destroy(new Error(`timeout: ${method} ${path}`)));
    call.on("error", rejectCall);
    call.end();
  });
}

async function waitForState(child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.pid === child.pid) return state;
      } catch { /* atomic publication may not have completed yet */ }
    }
    if (child.exitCode !== null) throw new Error(`portal exited early (${child.exitCode}): ${output.join("")}`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
  throw new Error(`portal readiness timeout: ${output.join("")}`);
}

const child = spawn(process.execPath, [
  serverScript,
  "--host", advertisedHost,
  "--port", String(config.port_base),
  "--port-attempts", String(config.port_attempts),
  "--root", join(intranetRoot, "_base"),
  "--overlay", join(intranetRoot, "_cases", familyId),
  "--case", familyId,
  "--state", statePath,
], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

try {
  const state = await waitForState(child);
  assert.equal(state.serverVersion, "1.0.1");
  assert.equal(state.baseUrl, `http://${advertisedHost}:${state.port}`);
  assert.deepEqual(state.allUrls, [state.baseUrl]);

  const health = await httpCall(state.port, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).caseFamilyId, familyId);

  const listing = await httpCall(state.port, `${encodeURI("/shared/采购/")}?format=json`);
  assert.equal(listing.status, 200);
  const names = JSON.parse(listing.body).entries.map((entry) => entry.name);
  assert.ok(names.includes("供应商复盘说明.md"), "overlay file missing from merged JSON listing");
  assert.ok(names.includes("评标流程指引.md"), "base file missing from merged JSON listing");

  const file = await httpCall(state.port, encodeURI("/shared/采购/供应商复盘说明.md"));
  assert.equal(file.status, 200);
  assert.match(file.body, /最终成交口径/);
  assert.match(String(file.headers["content-type"]), /charset=utf-8/);

  const curl = spawnSync("curl.exe", [
    "--noproxy", advertisedHost,
    "--fail", "--silent", "--show-error",
    `${state.baseUrl}${encodeURI("/shared/采购/")}?format=json`,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(curl.status, 0, `curl fallback failed: ${curl.stderr}`);
  assert.ok(JSON.parse(curl.stdout).entries.length >= 2, "curl JSON listing was not readable");

  const head = await httpCall(state.port, encodeURI("/shared/采购/供应商复盘说明.md"), "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal((await httpCall(state.port, "/healthz", "POST")).status, 405);
  assert.equal((await httpCall(state.port, "/%" )).status, 400, "malformed escape must be isolated to a 400 response");

  const burst = await Promise.all(Array.from({ length: 40 }, (_, index) => httpCall(state.port, index % 2 ? "/healthz" : `${encodeURI("/shared/采购/")}?format=json`)));
  assert.ok(burst.every((response) => response.status === 200), "concurrent read burst failed");
  assert.equal((await httpCall(state.port, "/healthz")).status, 200, "portal died after malformed/concurrent requests");
  console.log(`Validated intranet portal on ${state.baseUrl}: strict host, curl fallback, merged listing, UTF-8 file, malformed URL isolation, HEAD/405, 40-request burst`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((settle) => setTimeout(settle, 150));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
