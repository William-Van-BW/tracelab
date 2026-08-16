import { env } from "cloudflare:workers";

export type AppEnv = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
};

export function getEnv() {
  return env as unknown as AppEnv;
}

let initialized = false;

export async function ensureSchema() {
  if (initialized) return;
  const { DB } = getEnv();
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS records_kind_updated_idx ON records(kind, updated_at DESC)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      turn_id TEXT,
      step_id TEXT,
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts(run_id, created_at DESC)"),
  ]);
  initialized = true;
}
