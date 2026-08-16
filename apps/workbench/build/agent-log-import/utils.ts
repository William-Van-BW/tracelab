import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { CanonicalEvent, DiscoveredAgentSession } from "./types";

export function stableKey(adapterId: string, ...parts: string[]) {
  return `${adapterId}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

export function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20)}`;
}

export function safeStat(path: string) {
  try { return statSync(path); } catch { return undefined; }
}

export function collectFiles(root: string, accept: (path: string, name: string) => boolean, maxDepth = 8, maxFiles = 5000) {
  const result: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > maxDepth || result.length >= maxFiles || !existsSync(directory)) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (result.length >= maxFiles) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && accept(path, entry.name)) result.push(path);
    }
  };
  walk(root, 0);
  return result;
}

/**
 * Stream complete lines starting at byte `start`, returning the offset just past
 * the last newline consumed. Callers persist that offset and resume from it, so
 * an append-only log (Trae's stdout log reaches gigabytes) is read once and then
 * only its new tail. Stopping at a line boundary is what makes resuming safe —
 * resuming at a raw file size would split a line and corrupt the first match.
 */
export async function streamLinesFrom(path: string, start: number, onLine: (line: string) => void) {
  const input = createReadStream(path, { start });
  const decoder = new StringDecoder("utf8");
  let consumed = start;
  let pending = "";
  try {
    for await (const chunk of input) {
      pending += decoder.write(chunk as Buffer);
      for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
        const line = pending.slice(0, index);
        consumed += Buffer.byteLength(line, "utf8") + 1;
        onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        pending = pending.slice(index + 1);
      }
    }
  } finally { input.destroy(); }
  return consumed;
}

export async function readJsonLines(path: string, maxLines = 250_000) {
  const values: unknown[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (values.length >= maxLines) break;
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); } catch { /* preserve malformed lines as a warning at adapter level */ }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return values;
}

export function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

export function objectOf(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export function textFrom(value: unknown): string {
  const parsed = parseJson(value);
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
  if (Array.isArray(parsed)) return parsed.map(textFrom).filter(Boolean).join("\n");
  if (!parsed || typeof parsed !== "object") return "";
  const item = parsed as Record<string, unknown>;
  for (const key of ["text", "content", "message", "output_text", "input_text", "result", "summary", "thought", "analysis", "reasoning", "description"]) {
    if (item[key] !== undefined) {
      const text = textFrom(item[key]);
      if (text) return text;
    }
  }
  return "";
}

export function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = textFrom(value).trim();
    if (text) return text;
  }
  return "";
}

export function safeStringify(value: unknown, maxLength = 12_000) {
  if (value === undefined || value === null || value === "") return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const redacted = raw
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:password|passwd|access_token|refresh_token|api_key)["']?\s*[:=]\s*["'])[^"'\r\n]+/gi, "$1[REDACTED]");
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}\n…[已截断 ${redacted.length - maxLength} 字符]`;
}

export function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let date: Date;
  if (typeof value === "number") date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  else if (/^\d+$/.test(String(value))) {
    const number = Number(value);
    date = new Date(number < 10_000_000_000 ? number * 1000 : number);
  } else date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function fileDescriptor(adapterId: string, agentId: string, appName: string, path: string, nativeSessionId?: string): Pick<DiscoveredAgentSession, "key" | "adapterId" | "agentId" | "appName" | "nativeSessionId" | "sourcePath" | "updatedAt" | "sizeBytes" | "locator"> {
  const stat = safeStat(path);
  const id = nativeSessionId || basename(path).replace(/\.(jsonl?|log)$/i, "");
  return {
    key: stableKey(adapterId, path, id), adapterId, agentId, appName, nativeSessionId: id, sourcePath: path,
    updatedAt: stat?.mtime.toISOString(), sizeBytes: stat?.size, locator: { path, nativeSessionId: id },
  };
}

export function fileHash(path: string) {
  const bytes = readFileSync(path);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
}

export function event(id: string, sequence: number, kind: CanonicalEvent["kind"], patch: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return { id, sequence, kind, status: "unknown", ...patch };
}

export function latestFirst<T extends { updatedAt?: string }>(items: T[]) {
  return items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
