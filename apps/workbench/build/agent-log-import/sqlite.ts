import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlRow = Record<string, unknown>;

export function withSqliteSnapshot<T>(sourcePath: string, callback: (database: DatabaseSync) => T): T {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "aetf-import-"));
  const snapshotPath = join(temporaryRoot, basename(sourcePath));
  try {
    copyFileSync(sourcePath, snapshotPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, snapshotPath + suffix);
    }
    const database = new DatabaseSync(snapshotPath, { readOnly: true, timeout: 2000 });
    try { return callback(database); } finally { database.close(); }
  } finally {
    const resolvedTemp = resolve(temporaryRoot);
    const allowedRoot = resolve(tmpdir());
    if (resolvedTemp.startsWith(allowedRoot) && basename(resolvedTemp).startsWith("aetf-import-")) rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

export function rows(database: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return database.prepare(sql).all(...params) as SqlRow[];
}
