/**
 * Leak scanner — refuses to let operator-specific or site-specific strings
 * reach a public repository.
 *
 * Usage: node scan-leaks.mjs [path ...]
 * Exit code 1 when anything matches, so CI can gate on it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build-output", ".wrangler", ".vinext", ".next", "__pycache__"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".exe", ".dll", ".pdf", ".zip", ".xlsx", ".docx", ".pptx", ".woff", ".woff2"]);

const PATTERNS = [
  // The account name is public and appears in repository links; the Windows
  // login of the same person is not, and shows up in recorded traces.
  ["operator-username", /\bwilliam\b(?!-van-bw)/gi],
  ["home-path", /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9_.-]+)/g],
  ["private-ip", /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["absolute-project-path", /[A-Za-z]:[\\/]{1,2}(?:Users|Desktop|projects)[^"'\s]{0,80}office-testing/gi],
];

/**
 * Strings that look like a hit but are deliberate, public and safe: the
 * redaction placeholder itself, and the RFC 1918 network addresses that proxy
 * and firewall rules are written in. A whole *network* (a .0 address with no
 * host part) names nobody; a host address inside one does.
 */
const ALLOW = [
  /^C:[\\/]{1,2}Users[\\/]{1,2}operator/,
  /^C:[\\/]{1,2}Users[\\/]{1,2}\.{2,}$/,            // an Agent writing "C:\Users\..." in prose
  /^(?:10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0|10\.20\.30\.40)$/,
  /^git@github\.com$/,                               // the clone URL in the docs
  /^25213050366@m\.fudan\.edu\.cn$/,                 // maintainer contact, published on purpose
];

const hits = new Map();

function record(tag, value, file) {
  const key = `${tag} | ${value}`;
  if (!hits.has(key)) hits.set(key, new Set());
  hits.get(key).add(file);
}

function scanFile(file) {
  if (BINARY_EXT.has(extname(file).toLowerCase())) return;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [tag, pattern] of PATTERNS) {
    for (const match of text.match(pattern) ?? []) {
      if (ALLOW.some((allowed) => allowed.test(match))) continue;
      record(tag, match, file);
    }
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(directory, entry.name));
    } else {
      scanFile(join(directory, entry.name));
    }
  }
}

const targets = process.argv.slice(2);
for (const target of targets.length ? targets : ["."]) {
  if (statSync(target).isDirectory()) walk(target);
  else scanFile(target);
}

const rows = [...hits].sort((a, b) => b[1].size - a[1].size);
for (const [key, files] of rows) {
  console.log(`${String(files.size).padStart(4)}  ${key}`);
  for (const file of [...files].slice(0, 3)) console.log(`      ${file}`);
  if (files.size > 3) console.log(`      … 共 ${files.size} 个文件`);
}
console.log(rows.length ? `\n✗ ${rows.length} 类可疑字符串` : "✓ 未发现可疑字符串");
process.exit(rows.length ? 1 : 0);
