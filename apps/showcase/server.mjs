/**
 * Static server for the TraceLab showcase.
 *
 * Everything it serves is read into memory and pre-compressed at boot, so a
 * request never touches the filesystem: no path traversal is reachable, no disk
 * I/O contends under load, and the process keeps serving even if the data
 * directory is rebuilt underneath it (restart to pick the new build up).
 *
 * Zero dependencies on purpose — `node server.mjs` is the whole deployment.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const dataRoot = join(root, "data");

const BASE_PORT = Number.parseInt(process.env.PORT ?? "8000", 10) || 8000;
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT_ATTEMPTS = 25;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".map"]);
// Above this size brotli costs more at boot than it saves per request; the
// biggest asset here is a run trace of a few hundred KB, so both still apply.
const BROTLI_LIMIT = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Asset table
 * ------------------------------------------------------------------ */

/** @type {Map<string, {body: Buffer, type: string, etag: string, gzip?: Buffer, brotli?: Buffer, immutable: boolean}>} */
const assets = new Map();

function collect(directory, mount, { immutable }) {
  if (!existsSync(directory)) return 0;
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const body = readFileSync(absolute);
      const extension = extname(entry.name).toLowerCase();
      const route = `${mount}/${relative(directory, absolute).split(sep).join("/")}`.replace(/\/+/g, "/");
      const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
      const compressible = COMPRESSIBLE.has(extension) && body.length > 512;
      // version.json is the cache-busting pointer itself, so it must always be
      // revalidated even though it lives under the immutable data mount.
      const cacheImmutable = immutable && route !== "/data/version.json";
      assets.set(route, {
        body,
        type: MIME[extension] ?? "application/octet-stream",
        etag,
        gzip: compressible ? gzipSync(body, { level: 8 }) : undefined,
        brotli: compressible && body.length <= BROTLI_LIMIT
          ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } })
          : undefined,
        immutable: cacheImmutable,
      });
      count += 1;
    }
  };
  walk(directory);
  return count;
}

const startedLoading = Date.now();
const publicCount = collect(publicRoot, "", { immutable: false });
// Data files are content-addressed by the build fingerprint the client appends
// as ?v=…, so they are safe to cache hard.
const dataCount = collect(dataRoot, "/data", { immutable: true });

if (!assets.has("/index.html")) {
  console.error(`✗ 缺少 ${join(publicRoot, "index.html")}，无法启动。`);
  process.exit(1);
}
if (!dataCount) {
  console.error("✗ data/ 为空。请先运行：node scripts/build-data.mjs");
  process.exit(1);
}

const buildId = (() => {
  const asset = assets.get("/data/version.json");
  if (!asset) return "dev";
  try {
    return JSON.parse(asset.body.toString("utf8")).buildId ?? "dev";
  } catch {
    return "dev";
  }
})();

const bytes = [...assets.values()].reduce((total, asset) => total + asset.body.length, 0);

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // Everything ships from this origin: no CDN, no inline handlers, no eval.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; "),
};

function negotiate(request, asset) {
  const accepted = String(request.headers["accept-encoding"] ?? "");
  if (asset.brotli && /\bbr\b/.test(accepted)) return { body: asset.brotli, encoding: "br" };
  if (asset.gzip && /\bgzip\b/.test(accepted)) return { body: asset.gzip, encoding: "gzip" };
  return { body: asset.body, encoding: "" };
}

function send(request, response, status, asset, extraHeaders = {}) {
  const headers = { ...SECURITY_HEADERS, ...extraHeaders, "Content-Type": asset.type, ETag: asset.etag, Vary: "Accept-Encoding" };
  headers["Cache-Control"] = asset.immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";

  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === asset.etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  const { body, encoding } = negotiate(request, asset);
  if (encoding) headers["Content-Encoding"] = encoding;
  headers["Content-Length"] = String(body.length);
  response.writeHead(status, headers);
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function sendPlain(response, status, message) {
  const body = Buffer.from(message, "utf8");
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const handler = (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendPlain(response, 405, "Method Not Allowed");
      return;
    }
    const raw = request.url ?? "/";
    if (raw.length > 2048) {
      sendPlain(response, 414, "URI Too Long");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(raw, "http://localhost").pathname);
    } catch {
      sendPlain(response, 400, "Bad Request");
      return;
    }
    // Nothing is resolved against the filesystem, but normalise anyway so a
    // crafted path cannot match an asset key by accident.
    pathname = pathname.replace(/\/{2,}/g, "/");
    if (pathname !== "/" && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    if (pathname.includes("\0") || pathname.split("/").includes("..")) {
      sendPlain(response, 400, "Bad Request");
      return;
    }

    if (pathname === "/healthz") {
      const body = Buffer.from(JSON.stringify({ ok: true, buildId, assets: assets.size, uptimeSeconds: Math.round(process.uptime()) }), "utf8");
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length), "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    const direct = assets.get(pathname === "/" ? "/index.html" : pathname);
    if (direct) {
      send(request, response, 200, direct);
      return;
    }

    // A missing data document is a real 404 — never fall back to the shell HTML,
    // or the client would try to parse HTML as JSON.
    if (pathname.startsWith("/data/")) {
      sendPlain(response, 404, "Not Found");
      return;
    }
    // Anything else is a client route: hand back the app shell.
    send(request, response, 200, assets.get("/index.html"));
  } catch (error) {
    console.error("请求处理失败:", error);
    if (!response.headersSent) sendPlain(response, 500, "Internal Server Error");
    else response.destroy();
  }
};

/* ------------------------------------------------------------------ *
 * Listen
 * ------------------------------------------------------------------ */

const server = createServer(handler);
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 15_000;
// Only a genuine parse error deserves a 400. A keep-alive socket that the
// client (or our own idle timeout) closed mid-flight also lands here, and
// answering it turns a harmless reset into a visible failed request.
server.on("clientError", (error, socket) => {
  const malformed = typeof error?.code === "string" && error.code.startsWith("HPE_");
  if (malformed && socket.writable && !socket.destroyed) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  socket.destroy();
});

function listen(port, attempt = 0) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < PORT_ATTEMPTS) {
      console.warn(`端口 ${port} 已被占用，尝试 ${port + 1} …`);
      listen(port + 1, attempt + 1);
      return;
    }
    console.error(`✗ 无法监听端口 ${port}: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const loadMs = Date.now() - startedLoading;
    console.log(`TraceLab Showcase`);
    console.log(`  http://localhost:${port}`);
    console.log(`  ${publicCount} 个静态文件 · ${dataCount} 份数据 · ${(bytes / 1048576).toFixed(1)} MB 常驻内存 · 预压缩耗时 ${loadMs}ms`);
    console.log(`  build ${buildId}`);
  });
}

listen(BASE_PORT);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在关闭 …`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

// A read-only static server has no request state worth losing; log and stay up
// rather than dropping every other visitor because one socket misbehaved.
process.on("uncaughtException", (error) => console.error("未捕获异常:", error));
process.on("unhandledRejection", (error) => console.error("未处理的 Promise 拒绝:", error));
