/**
 * Assembles `dist/` — the exact directory a static host (GitHub Pages, Netlify,
 * nginx, an S3 bucket) should serve.
 *
 * `node server.mjs` is only needed for local preview; the site itself is plain
 * files. Everything is referenced with relative URLs and hash routes, so the
 * same `dist/` works at a domain root and at user.github.io/<repo>/ without a
 * rebuild or any server-side rewrite rules.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const showcaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = join(showcaseRoot, "public");
const dataRoot = join(showcaseRoot, "data");
const distRoot = join(showcaseRoot, "dist");

if (!existsSync(join(dataRoot, "snapshot.json"))) {
  console.error("✗ data/ 还没生成。请先运行：node scripts/build-data.mjs");
  process.exit(1);
}

// Clear the previous build but keep dist/.git: the publish flow makes dist its
// own repository pointed at the public site, and blowing that away every
// rebuild would orphan the deployment history.
mkdirSync(distRoot, { recursive: true });
for (const entry of readdirSync(distRoot)) {
  if (entry === ".git") continue;
  rmSync(join(distRoot, entry), { recursive: true, force: true });
}
cpSync(publicRoot, distRoot, { recursive: true });
cpSync(dataRoot, join(distRoot, "data"), { recursive: true });

// GitHub Pages runs Jekyll by default, which silently drops files and folders
// whose names start with "_" or ".". This opts the whole site out.
writeFileSync(join(distRoot, ".nojekyll"), "", "utf8");

// Hash routing means every deep link is served by index.html anyway, but Pages
// serves this for any stray 404 so a mistyped path still lands on the site.
cpSync(join(distRoot, "index.html"), join(distRoot, "404.html"));

/** An absolute-rooted URL would 404 under a project subpath — catch it here. */
function auditAbsoluteRefs() {
  const offenders = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "data" && entry.name !== ".git") walk(absolute);
        continue;
      }
      if (!/\.(html|js|css)$/.test(entry.name)) continue;
      const text = readFileSync(absolute, "utf8");
      for (const match of text.matchAll(/(?:src|href)\s*=\s*"\/[^"]*"|fetchJson\(\s*[`"]\/[^`"]*/g)) {
        offenders.push(`${entry.name}: ${match[0].slice(0, 60)}`);
      }
    }
  };
  walk(distRoot);
  return offenders;
}

const offenders = auditAbsoluteRefs();

let files = 0;
let bytes = 0;
const measure = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.name === ".git") continue; // deployment metadata, not site content
    if (entry.isDirectory()) measure(absolute);
    else {
      files += 1;
      bytes += statSync(absolute).size;
    }
  }
};
measure(distRoot);

console.log(`✓ dist/ 已生成：${files} 个文件 · ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  本地预览：node server.mjs（或任意静态服务器指向 dist/）`);
if (offenders.length) {
  console.warn("! 发现以 / 开头的绝对路径引用，部署到子路径时会 404：");
  for (const offender of offenders) console.warn(`    ${offender}`);
  process.exitCode = 1;
} else {
  console.log("  路径检查：全部为相对引用，可部署到任意子路径");
}
