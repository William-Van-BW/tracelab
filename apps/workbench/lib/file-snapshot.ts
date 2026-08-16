import type { FileSnapshot } from "./types";

/** Pure comparison helper. Snapshot collection runs on the Windows TraceLab backend. */
export function diffSnapshots(previous: FileSnapshot, current: FileSnapshot) {
  const before = new Map(previous.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
  const changes: NonNullable<FileSnapshot["changes"]> = [];

  for (const [path, entry] of after) {
    const prior = before.get(path);
    if (!prior) {
      changes.push({ operation: "create", path, afterSha256: entry.sha256, afterSizeBytes: entry.sizeBytes });
    } else if (prior.sha256 !== entry.sha256 || prior.sizeBytes !== entry.sizeBytes || prior.lastModified !== entry.lastModified) {
      changes.push({ operation: "modify", path, beforeSha256: prior.sha256, afterSha256: entry.sha256, beforeSizeBytes: prior.sizeBytes, afterSizeBytes: entry.sizeBytes });
    }
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) changes.push({ operation: "delete", path, beforeSha256: entry.sha256, beforeSizeBytes: entry.sizeBytes });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}
