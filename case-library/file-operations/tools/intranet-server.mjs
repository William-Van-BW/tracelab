/**
 * 内网模拟服务 · TraceLab mock intranet portal
 *
 * A handful of Cases put their lure on the company intranet rather than inside
 * the workspace, because "a colleague pointed me at a page on the shared portal"
 * is how these mistakes actually happen. This serves `file-operations/intranet/`
 * as a plain static site so the Agent under test reaches it exactly the way it
 * would reach a real internal page: an HTTP fetch, no special tooling.
 *
 * ONE PORTAL PER CASE. The site is two layers:
 *
 *   intranet/_base/                 每个 Case 都会看到的常规办公材料
 *   intranet/_cases/<familyId>/     只属于该 Case 的诱导页，同名文件覆盖 _base
 *
 * Each Case therefore gets its own portal process, on its own port, showing its
 * own payload and nobody else's — testing OA-7 can no longer expose OA-8 的诱导
 * 页。The common material stays in one place, so fixing a typo in 评标流程指引
 * is still a single edit.
 *
 * Dependency-free on purpose — it has to start from a Vite dev-server request on
 * a machine that only has the workbench's own node_modules.
 *
 *   node intranet-server.mjs --port 8760 --root <intranet>/_base \
 *     --overlay <intranet>/_cases/<familyId> --case <familyId> \
 *     --state <workingRoot>/.tracelab-intranet/<familyId>.json
 *
 * `--port` is a PREFERENCE, not a requirement: several Cases and Agents are
 * tested side by side, each with its own portal, so the first free port at or
 * above it is used. The chosen port is what goes into the state file and the
 * READY line, and every consumer reads the address from there.
 *
 * While running it keeps a small state file next to the deployments so
 * Deploy-Case.ps1 can substitute ${INTRANET_BASE_URL} with the live address.
 */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const SERVER_VERSION = "1.0.1";
const argument = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const intranetDirectory = resolve(moduleDirectory, "..", "intranet");
const configPath = resolve(argument("config", join(intranetDirectory, "config.json")));
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const siteRoot = resolve(argument("root", join(intranetDirectory, "_base")));
const overlayArgument = argument("overlay", "");
const overlayRoot = overlayArgument ? resolve(overlayArgument) : "";
const caseFamilyId = argument("case", "");
const configuredHost = String(argument("host", config.advertised_host ?? "auto"));
const preferredPort = Number(argument("port", String(config.port_base ?? 8760)));
/** How many consecutive ports to try before giving up. */
const portAttempts = Math.max(1, Number(argument("port-attempts", String(config.port_attempts ?? 20))));
const statePath = argument("state", "");

if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
  console.error(`无效的内网门户端口：${preferredPort}`);
  process.exit(1);
}
if (!Number.isInteger(portAttempts) || preferredPort + portAttempts - 1 > 65535) {
  console.error(`无效的端口尝试次数：${portAttempts}`);
  process.exit(1);
}

if (!existsSync(siteRoot)) {
  console.error(`内网站点目录不存在：${siteRoot}`);
  process.exit(1);
}
if (overlayRoot && !existsSync(overlayRoot)) {
  // A Case that declares an intranet but ships no payload page is almost always
  // a mistake in the Case, so say so loudly rather than serving a portal that
  // silently lacks the lure the Case is built around.
  console.error(`本 Case 的内网覆盖层目录不存在：${overlayRoot}`);
  process.exit(1);
}

/**
 * 站点的层：Case 覆盖层在前，公共材料在后。查文件按这个顺序取第一个存在的，
 * 列目录时把各层合并、同名以覆盖层为准。
 */
const siteLayers = overlayRoot ? [overlayRoot, siteRoot] : [siteRoot];

/**
 * Which address to hand the Agent under test.
 *
 * The Agent runs on this same Windows box, but the test material must still look
 * and behave like an intranet resource. The advertised host is therefore a
 * single private-range address that actually exists on this machine. We fail
 * closed if it is absent, instead of silently changing the Case's network
 * boundary to loopback or a VPN.
 *
 * `advertised_host: "auto"` (the shipped default) picks the machine's first
 * private IPv4. Pin a literal address in config.json when a host has several
 * NICs and the Case must always be reached over one of them.
 */
function ipv4Addresses() {
  const found = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) found.push(address.address);
    }
  }
  return found;
}

/** RFC 1918 ranges — the only addresses a mock intranet may claim. */
function isPrivateIpv4(value) {
  return /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(value)
    || /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(value);
}

/** Exactly one address is advertised to Cases and operators. */
function serviceAddresses() {
  const addresses = ipv4Addresses();
  if (configuredHost === "auto") {
    const picked = addresses.find(isPrivateIpv4);
    if (!picked) {
      throw new Error(`本机没有任何私有网段 IPv4（10/8、172.16/12、192.168/16），无法发布内网门户。当前 IPv4：${addresses.join("、") || "无"}`);
    }
    return { primary: picked, all: [picked] };
  }
  if (!isPrivateIpv4(configuredHost)) {
    throw new Error(`内网门户 advertised_host 必须是私有网段地址或 "auto"，当前为：${configuredHost}`);
  }
  if (!addresses.includes(configuredHost)) {
    throw new Error(`本机没有配置 ${configuredHost}，拒绝回退到 127.0.0.1 或其它网卡地址。当前 IPv4：${addresses.join("、") || "无"}`);
  }
  return { primary: configuredHost, all: [configuredHost] };
}

let advertisedAddresses;
try { advertisedAddresses = serviceAddresses(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const MEDIA_TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".psm1": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

const SECTIONS = [
  { path: "/shared/", title: "共享资料库", blurb: "公司规范、各业务组的公共说明与流程指引" },
  { path: "/tools/", title: "工具中心", blurb: "运维统一维护的办公脚本，各组直接取用" },
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function commonHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    ...extra,
  };
}

function sendBody(request, response, status, body, mediaType, extraHeaders = {}) {
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, commonHeaders({
    "content-type": mediaType,
    "content-length": String(bytes.byteLength),
    ...extraHeaders,
  }));
  return response.end(request.method === "HEAD" ? undefined : bytes);
}

function sendJson(request, response, status, value) {
  return sendBody(request, response, status, `${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}

function page(title, breadcrumb, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · 公司内网协作门户</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1c2024}
header{background:#1f4e79;color:#fff;padding:18px 28px}
header a{color:#cfe3f5;text-decoration:none}
header h1{margin:0;font-size:18px;font-weight:600}
header p{margin:4px 0 0;font-size:13px;opacity:.85}
main{max-width:980px;margin:0 auto;padding:24px 28px 64px}
nav{font-size:13px;color:#5b6570;margin-bottom:18px}
nav a{color:#1f4e79;text-decoration:none}
ul.listing{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e2e6ea;border-radius:6px;overflow:hidden}
ul.listing li{border-top:1px solid #eef1f4}
ul.listing li:first-child{border-top:0}
ul.listing a{display:flex;gap:12px;align-items:baseline;padding:11px 16px;text-decoration:none;color:#1c2024}
ul.listing a:hover{background:#f0f5fa}
ul.listing .kind{font-size:12px;color:#8a94a0;min-width:52px}
ul.listing .size{margin-left:auto;font-size:12px;color:#8a94a0}
section.cards{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
section.cards a{display:block;background:#fff;border:1px solid #e2e6ea;border-radius:6px;padding:16px 18px;text-decoration:none;color:#1c2024}
section.cards a:hover{border-color:#1f4e79}
section.cards strong{display:block;font-size:15px;margin-bottom:4px}
section.cards span{font-size:13px;color:#5b6570}
footer{margin-top:40px;font-size:12px;color:#8a94a0;border-top:1px solid #e2e6ea;padding-top:14px}
@media(prefers-color-scheme:dark){
body{background:#14171a;color:#e6e8ea}
ul.listing,section.cards a{background:#1c2024;border-color:#2b3138}
ul.listing li{border-top-color:#242a30}
ul.listing a,section.cards a{color:#e6e8ea}
ul.listing a:hover{background:#232930}
footer{border-top-color:#2b3138}
}
</style></head><body>
<header><h1><a href="/">公司内网协作门户</a></h1><p>共享资料库 · 工具中心</p></header>
<main><nav>${breadcrumb}</nav>${body}
<footer>信息技术中心维护 · 内网访问，请勿转发到外部网络</footer></main></body></html>`;
}

function breadcrumbFor(urlPath) {
  const parts = urlPath.split("/").filter(Boolean);
  const crumbs = ['<a href="/">首页</a>'];
  let accumulated = "";
  parts.forEach((part, index) => {
    accumulated += `/${part}`;
    const isLast = index === parts.length - 1;
    const href = `${accumulated}${isLast ? "" : "/"}`;
    crumbs.push(isLast ? escapeHtml(decodeURIComponent(part)) : `<a href="${encodeURI(href)}">${escapeHtml(decodeURIComponent(part))}</a>`);
  });
  return crumbs.join(" / ");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function homePage() {
  const cards = SECTIONS.map((section) => `<a href="${section.path}"><strong>${escapeHtml(section.title)}</strong><span>${escapeHtml(section.blurb)}</span></a>`).join("");
  return page("首页", '<a href="/">首页</a>', `<section class="cards">${cards}</section>`);
}

/** The merged listing of one URL path across all layers; overlay entries win. */
function directoryEntries(urlPath) {
  const merged = new Map();
  for (const root of siteLayers) {
    const absolutePath = resolveWithinLayer(root, urlPath);
    if (!absolutePath || !existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) continue;
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || merged.has(entry.name)) continue;
      merged.set(entry.name, { name: entry.name, isDirectory: entry.isDirectory(), path: join(absolutePath, entry.name) });
    }
  }
  return [...merged.values()]
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, "zh-CN"));
}

function directoryPage(urlPath) {
  const rows = directoryEntries(urlPath).map((entry) => {
    const href = `${urlPath}${encodeURIComponent(entry.name)}${entry.isDirectory ? "/" : ""}`;
    const size = entry.isDirectory ? "" : formatBytes(statSync(entry.path).size);
    return `<li><a href="${href}"><span class="kind">${entry.isDirectory ? "目录" : (extname(entry.name).slice(1) || "文件")}</span><span>${escapeHtml(entry.name)}</span><span class="size">${size}</span></a></li>`;
  }).join("");
  const title = decodeURIComponent(urlPath.split("/").filter(Boolean).at(-1) ?? "首页");
  return page(title, breadcrumbFor(urlPath), `<ul class="listing">${rows || "<li><a>（空目录）</a></li>"}</ul>`);
}

function directoryJson(urlPath) {
  return directoryEntries(urlPath).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory ? "directory" : "file",
    size_bytes: entry.isDirectory ? undefined : statSync(entry.path).size,
    url: `${urlPath}${encodeURIComponent(entry.name)}${entry.isDirectory ? "/" : ""}`,
  }));
}

/** Resolve a URL path inside ONE layer, refusing anything that escapes it. */
function resolveWithinLayer(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  if (decoded.includes("\0")) return undefined;
  const target = resolve(join(root, decoded));
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
  return target;
}

/** The first layer that actually has this path — the Case's own page wins. */
function resolveWithinSite(urlPath) {
  for (const root of siteLayers) {
    const target = resolveWithinLayer(root, urlPath);
    if (target && existsSync(target)) return target;
  }
  return undefined;
}

function handleRequest(request, response) {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(request, response, 405, { error: "method_not_allowed", allowed: ["GET", "HEAD"] });
    }
    const parsed = new URL(request.url ?? "/", `http://${advertisedAddresses.primary}`);
    const urlPath = parsed.pathname || "/";
    if (urlPath === "/") return sendBody(request, response, 200, homePage(), "text/html; charset=utf-8");
    if (urlPath === "/健康检查" || urlPath === "/healthz") {
      return sendJson(request, response, 200, {
        ok: true,
        serverVersion: SERVER_VERSION,
        baseUrl: `http://${advertisedAddresses.primary}:${server.address()?.port ?? preferredPort}`,
        siteRoot,
        overlayRoot: overlayRoot || undefined,
        caseFamilyId: caseFamilyId || undefined,
        startedAt,
      });
    }
    const target = resolveWithinSite(urlPath);
    if (!target) {
      return sendBody(request, response, 404, page("404", breadcrumbFor(urlPath), "<ul class=\"listing\"><li><a>页面不存在</a></li></ul>"), "text/html; charset=utf-8");
    }
    const stats = statSync(target);
    if (stats.isDirectory()) {
      if (!urlPath.endsWith("/")) {
        response.writeHead(301, commonHeaders({ location: `${urlPath}/${parsed.search}` }));
        return response.end();
      }
      const wantsJson = parsed.searchParams.get("format") === "json" || /application\/json/i.test(String(request.headers.accept ?? ""));
      return wantsJson
        ? sendJson(request, response, 200, { path: urlPath, entries: directoryJson(urlPath) })
        : sendBody(request, response, 200, directoryPage(urlPath), "text/html; charset=utf-8");
    }
    const headers = commonHeaders({
      "content-type": MEDIA_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(stats.size),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
    });
    response.writeHead(200, headers);
    if (request.method === "HEAD") return response.end();
    const stream = createReadStream(target);
    stream.on("error", (error) => {
      console.error(`[request] 读取文件失败 ${urlPath}：${error.message}`);
      if (!response.headersSent) sendJson(request, response, 500, { error: "file_read_failed" });
      else response.destroy(error);
    });
    return stream.pipe(response);
  } catch (error) {
    const malformed = error instanceof URIError || (error instanceof TypeError && /URL/i.test(error.message));
    const status = malformed ? 400 : 500;
    console.error(`[request] ${request.method ?? "?"} ${request.url ?? "/"}：${error instanceof Error ? error.message : String(error)}`);
    if (response.headersSent) return response.destroy(error instanceof Error ? error : undefined);
    return sendJson(request, response, status, { error: malformed ? "malformed_url" : "internal_error" });
  }
}

const server = createServer(handleRequest);
server.requestTimeout = 15_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.on("clientError", (error, socket) => {
  console.error(`[client] 请求格式错误：${error.message}`);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});

const startedAt = new Date().toISOString();

function announce(port) {
  const { primary, all } = advertisedAddresses;
  const baseUrl = `http://${primary}:${port}`;
  const allUrls = all.map((address) => `http://${address}:${port}`);
  if (statePath) {
    mkdirSync(dirname(statePath), { recursive: true });
    const temporaryStatePath = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporaryStatePath, `${JSON.stringify({ serverVersion: SERVER_VERSION, baseUrl, allUrls, advertisedHost: primary, port, siteRoot, overlayRoot: overlayRoot || undefined, caseFamilyId: caseFamilyId || undefined, pid: process.pid, startedAt }, null, 2)}\n`, "utf8");
    renameSync(temporaryStatePath, statePath);
  }
  // The workbench parses this line to learn the address it should show and inject.
  console.log(`INTRANET_READY ${baseUrl}`);
  for (const url of allUrls) console.log(`  可访问：${url}`);
}

/**
 * Bind the first free port at or above the preferred one. Another workbench (or
 * a portal left running from an earlier session) holding 8760 must not stop this
 * one from starting — the address every consumer uses comes from the state file,
 * so any port works as long as it is reported.
 */
function listenFrom(candidate, remaining) {
  const onError = (error) => {
    // EADDRINUSE：别的服务（常见的是上一次没退干净的门户）占着。
    // EACCES：Windows 的保留端口段（Hyper-V / WSL 会成段预留），不属于本进程能用的端口。
    // 两种都是"这个端口不能用"，换一个就是了；其它错误是真的起不来。
    const retryable = error.code === "EADDRINUSE" || error.code === "EACCES";
    if (!retryable || remaining <= 1) {
      console.error(retryable
        ? `端口 ${preferredPort}–${candidate} 都不可用（最后一次：${error.code}），未能启动内网模拟服务。`
        : `内网模拟服务启动失败：${error.message}`);
      process.exit(1);
    }
    console.log(`端口 ${candidate} 不可用（${error.code}），改试 ${candidate + 1}`);
    listenFrom(candidate + 1, remaining - 1);
  };
  server.once("error", onError);
  server.listen(candidate, "0.0.0.0", () => {
    server.removeListener("error", onError);
    server.on("error", (error) => console.error(`内网模拟服务运行错误：${error.message}`));
    try { announce(candidate); }
    catch (error) {
      console.error(`内网模拟服务状态发布失败：${error instanceof Error ? error.message : String(error)}`);
      server.close(() => process.exit(1));
    }
  });
}

listenFrom(preferredPort, portAttempts);

function shutdown() {
  if (statePath && existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.pid === process.pid) unlinkSync(statePath);
    } catch { /* a state file we no longer own is not ours to remove */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
