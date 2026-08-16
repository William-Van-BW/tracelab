/**
 * Smoke test for the showcase: validates the generated snapshot's internal
 * links, then boots the real server on a throwaway port and exercises the
 * behaviours the site depends on under load (caching, compression, 404s,
 * method and traversal rejection).
 *
 * Run with: node scripts/check.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const showcaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = join(showcaseRoot, "data");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ----------------------------------------------------- 数据完整性 ---- */

if (!existsSync(join(dataRoot, "snapshot.json"))) {
  console.error("✗ 未找到 data/snapshot.json，请先运行 node scripts/build-data.mjs");
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(join(dataRoot, "snapshot.json"), "utf8"));
const version = JSON.parse(readFileSync(join(dataRoot, "version.json"), "utf8"));

check("snapshot 至少包含一个 Case", snapshot.cases.length > 0, `${snapshot.cases.length} 个`);
check("version.json 带 buildId", typeof version.buildId === "string" && version.buildId.length >= 8, version.buildId);

const caseFiles = new Set(readdirSync(join(dataRoot, "cases")));
const runFiles = new Set(readdirSync(join(dataRoot, "runs")));

let missingCase = 0;
let missingRun = 0;
let danglingSlug = 0;
const referencedRuns = new Set();

for (const summary of snapshot.cases) {
  if (!caseFiles.has(`${summary.slug}.json`)) missingCase += 1;
  for (const run of summary.runs) {
    referencedRuns.add(`${run.id}.json`);
    if (!runFiles.has(`${run.id}.json`)) missingRun += 1;
  }
}
check("每个 Case 摘要都有详情文件", missingCase === 0, `缺失 ${missingCase}`);
check("每条 Run 引用都有轨迹文件", missingRun === 0, `缺失 ${missingRun}`);
check("没有孤立的轨迹文件", referencedRuns.size === runFiles.size, `引用 ${referencedRuns.size} / 磁盘 ${runFiles.size}`);

// 每个 Case 只保留一个版本，并且五段读物齐全。
const families = new Map();
let incompleteReadme = 0;
for (const file of caseFiles) {
  const item = JSON.parse(readFileSync(join(dataRoot, "cases", file), "utf8"));
  families.set(item.familyId, (families.get(item.familyId) ?? 0) + 1);
  const readme = item.readme ?? {};
  if (!readme.corePrinciple || !readme.directoryTree || !readme.prompt || !readme.keyFiles || !readme.safePath) incompleteReadme += 1;
  for (const run of item.runs) if (run.caseSlug !== item.slug) danglingSlug += 1;
}
check("每个 Case 家族只有一个版本", [...families.values()].every((count) => count === 1), `${families.size} 个家族`);
check("五段读物字段齐全", incompleteReadme === 0, `缺字段的 Case：${incompleteReadme}`);
check("Run 与 Case 的绑定一致", danglingSlug === 0);

// Runs 只绑定各自 Case 的最新版本，且每个 Case × Agent 至多一条。
let duplicatePairs = 0;
const pairs = new Set();
for (const file of runFiles) {
  const run = JSON.parse(readFileSync(join(dataRoot, "runs", file), "utf8"));
  const key = `${run.caseSlug}::${run.agentId}`;
  if (pairs.has(key)) duplicatePairs += 1;
  pairs.add(key);
}
check("每个 Case × Agent 只保留最新一条轨迹", duplicatePairs === 0, `重复 ${duplicatePairs}`);

// 脱敏：整个 data/ 不得出现操作者账户名。
const username = homedir().split(/[\\/]/).filter(Boolean).pop() ?? "";
let leaked = 0;
if (username && snapshot.redacted) {
  const needle = username.toLowerCase();
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) scan(absolute);
      else if (readFileSync(absolute, "utf8").toLowerCase().includes(needle)) leaked += 1;
    }
  };
  scan(dataRoot);
}
check("数据中不含操作者账户名", leaked === 0, `泄露文件 ${leaked}`);

/* --------------------------------------------------------- 服务器 ---- */

const port = 8731 + (Date.now() % 200);
const child = spawn(process.execPath, [join(showcaseRoot, "server.mjs")], {
  cwd: showcaseRoot,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
child.stderr.on("data", (chunk) => (serverLog += chunk.toString()));

const base = `http://127.0.0.1:${port}`;

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务器提前退出：\n${serverLog}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`服务器启动超时：\n${serverLog}`);
}

try {
  const health = await waitForServer();
  check("/healthz 可用", health.ok === true, `build ${health.buildId} · ${health.assets} 份资源`);

  const home = await fetch(`${base}/`);
  check("首页返回 HTML", home.ok && (home.headers.get("content-type") ?? "").includes("text/html"));
  check("首页带安全响应头", home.headers.get("x-content-type-options") === "nosniff" && Boolean(home.headers.get("content-security-policy")));

  const snapshotResponse = await fetch(`${base}/data/snapshot.json?v=${version.buildId}`, { headers: { "Accept-Encoding": "gzip, br" } });
  check("snapshot 可下载", snapshotResponse.ok);
  check("snapshot 已压缩", ["br", "gzip"].includes(snapshotResponse.headers.get("content-encoding") ?? ""), snapshotResponse.headers.get("content-encoding") ?? "identity");
  check("带指纹的数据可长缓存", (snapshotResponse.headers.get("cache-control") ?? "").includes("immutable"));
  const etag = snapshotResponse.headers.get("etag");
  await snapshotResponse.arrayBuffer();

  const revalidate = await fetch(`${base}/data/snapshot.json?v=${version.buildId}`, { headers: { "If-None-Match": etag ?? "" } });
  check("ETag 命中返回 304", revalidate.status === 304);

  const versionResponse = await fetch(`${base}/data/version.json`);
  check("version.json 每次都重新校验", (versionResponse.headers.get("cache-control") ?? "").includes("must-revalidate"));
  await versionResponse.arrayBuffer();

  const spa = await fetch(`${base}/case/OA-7`);
  check("未知路径回落到应用外壳", spa.ok && (spa.headers.get("content-type") ?? "").includes("text/html"));
  await spa.arrayBuffer();

  const missing = await fetch(`${base}/data/cases/does-not-exist.json`);
  check("缺失的数据返回 404（不回落 HTML）", missing.status === 404);
  await missing.arrayBuffer();

  const traversal = await fetch(`${base}/data/../server.mjs`);
  check("路径穿越被拒绝", traversal.status === 404 || traversal.status === 400 || (traversal.headers.get("content-type") ?? "").includes("text/html"));
  const traversalBody = await traversal.text();
  check("路径穿越不会泄露源码", !traversalBody.includes("createServer"));

  const post = await fetch(`${base}/`, { method: "POST" });
  check("非 GET 请求被拒绝", post.status === 405);
  await post.arrayBuffer();

  // 并发：站点要能扛住同时到达的读者。
  const started = Date.now();
  const burst = await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      fetch(`${base}/data/${index % 2 ? "snapshot.json" : `cases/${snapshot.cases[index % snapshot.cases.length].slug}.json`}?v=${version.buildId}`)
        .then(async (response) => {
          await response.arrayBuffer();
          return response.ok;
        })
        .catch(() => false),
    ),
  );
  check("120 个并发请求全部成功", burst.every(Boolean), `${Date.now() - started}ms`);

  // 保活连续请求：复用同一条连接，暴露 keep-alive 竞态。
  const sequential = [];
  for (let index = 0; index < 40; index += 1) {
    const response = await fetch(`${base}/?probe=${index}`);
    await response.arrayBuffer();
    sequential.push(response.status);
  }
  check("40 次保活连续请求全部 200", sequential.every((status) => status === 200), [...new Set(sequential)].join("/"));

  // 畸形请求不应拖垮服务。
  const malformed = await new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write("GARBAGE / HTTP/9.9\r\n\r\n"));
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString()));
    socket.on("close", () => resolve(received));
    socket.on("error", () => resolve(received));
    setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 2000);
  });
  check("畸形请求被安全处理", malformed === "" || malformed.includes("400"), malformed.split("\r\n")[0] || "连接被关闭");
  const stillAlive = await fetch(`${base}/healthz`);
  check("畸形请求后服务仍然存活", stillAlive.ok);
  await stillAlive.arrayBuffer();

  const firstRun = snapshot.cases.find((item) => item.runs.length)?.runs[0];
  if (firstRun) {
    const runResponse = await fetch(`${base}/data/runs/${firstRun.id}.json?v=${version.buildId}`);
    const run = await runResponse.json();
    check("轨迹文件可解析", Array.isArray(run.turns) && run.turns.length > 0, `${run.stepCount} Steps`);
  }
} catch (error) {
  check("服务器冒烟测试", false, error.message);
} finally {
  child.kill();
}

console.log(failures ? `\n✗ ${failures} 项检查未通过` : "\n✓ 全部检查通过");
process.exit(failures ? 1 : 0);
