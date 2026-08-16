import type { DiscoveredAgentSession, ImportDiscovery } from "./types";
import { agentLogAdapters } from "./adapters";

/* ---------------------------------------------------------------- 发现结果缓存
 *
 * A full scan walks seven Agents' log roots and copies two SQLite databases to
 * temporary snapshots — several seconds of disk work. It used to run on every
 * dialog open AND a second time inside extract(), so "从日志导入一个 Turn" sat
 * spinning before it showed anything.
 *
 * The result is now cached in the dev server process and served stale-while-
 * revalidate: a warm cache answers instantly and a rescan runs in the
 * background, so the list is at most one open behind. Nothing here is
 * authoritative — the real logs are on disk, and 重新扫描 forces a fresh scan
 * whenever the operator knows an Agent just finished a session.
 * ------------------------------------------------------------------------- */

/** Below this age the cache is served with no rescan at all. */
const FRESH_MS = 30_000;

type CacheEntry = { value: ImportDiscovery; at: number };

let cache: CacheEntry | undefined;
let inFlight: Promise<ImportDiscovery> | undefined;

async function scanAllAdapters(): Promise<ImportDiscovery> {
  // Adapters touch different directories, so scanning them concurrently costs
  // the slowest one rather than the sum of all seven.
  const results = await Promise.all(agentLogAdapters.map(async (adapter) => {
    const startedAt = Date.now();
    const identity = { id: adapter.id, agentId: adapter.agentId, appName: adapter.appName };
    try {
      const found = await adapter.discover();
      const fallback = found.length > 0 && found.every((session) => session.completeness !== "full");
      return {
        sessions: found,
        status: {
          ...identity, sessionCount: found.length, durationMs: Date.now() - startedAt,
          status: found.length ? fallback ? "fallback" as const : "ready" as const : "not_found" as const,
          message: found.length ? fallback ? "已发现降级数据源" : "已发现可导入会话" : "未发现本地会话或导出文件",
        },
      };
    } catch (error) {
      return {
        sessions: [] as DiscoveredAgentSession[],
        status: {
          ...identity, sessionCount: 0, durationMs: Date.now() - startedAt, status: "error" as const,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }));
  const sessions = results.flatMap((result) => result.sessions);
  sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { adapters: results.map((result) => result.status), sessions, discoveredAt: new Date().toISOString(), cached: false };
}

/** Run a scan, collapsing concurrent callers onto one in-flight promise. */
function refresh() {
  if (!inFlight) {
    inFlight = scanAllAdapters()
      .then((value) => { cache = { value, at: Date.now() }; return value; })
      .finally(() => { inFlight = undefined; });
  }
  return inFlight;
}

export async function discoverAgentLogs(options: { force?: boolean } = {}): Promise<ImportDiscovery> {
  if (options.force) return refresh();
  if (!cache) return refresh();
  if (Date.now() - cache.at < FRESH_MS) return { ...cache.value, cached: true };
  // Stale: answer now from the cache and rescan behind the operator's back. The
  // rejection is swallowed because the cached answer is already on its way out;
  // a genuinely broken source surfaces as that adapter's "error" status instead.
  const pending = refresh();
  pending.catch(() => undefined);
  return { ...cache.value, cached: true, refreshing: true };
}

/** Warm the cache at startup so the first dialog open does not pay for the scan. */
export function warmAgentLogDiscovery() {
  refresh().catch(() => undefined);
}

export async function extractAgentLogSession(adapterId: string, sessionKey: string) {
  const adapter = agentLogAdapters.find((item) => item.id === adapterId);
  if (!adapter) throw new Error(`未知日志适配器：${adapterId}`);
  // Look in the cache first — extract used to re-run the adapter's own scan, so
  // choosing a session paid the discovery cost a second time.
  const cached = (await discoverAgentLogs()).sessions.find((item) => item.key === sessionKey && item.adapterId === adapterId);
  const session = cached ?? (await discoverAgentLogs({ force: true })).sessions.find((item) => item.key === sessionKey && item.adapterId === adapterId);
  if (!session) throw new Error("会话已经移动、删除或不再属于该适配器，请重新扫描");
  return adapter.extract(session);
}
