import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentLogAdapter, CanonicalEvent, DiscoveredAgentSession } from "../types";
import { arrayOf, collectFiles, event, fileDescriptor, fileHash, firstText, latestFirst, objectOf, readJsonLines, safeStat, stableKey, streamLinesFrom, textFrom, toIso } from "../utils";

const id = "trae";
const agentId = "agent_trae";
const appName = "Trae";

type TraeSessionProbe = {
  nativeSessionId: string;
  projectId?: string;
  prompt?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  path: string;
};

function persistentLogs() {
  const roaming = process.env.APPDATA ?? "";
  const roots = [join(roaming, "TRAE SOLO", "logs"), join(roaming, "TRAE SOLO CN", "logs")];
  return roots.flatMap((root) => collectFiles(root, (_path, name) => /ai-agent.*_stdout\.log$/i.test(name), 5, 200))
    .filter((path) => (safeStat(path)?.size ?? 0) > 0);
}

function decodeRustString(value: string) {
  try { return JSON.parse(`"${value}"`) as string; } catch { return value.replaceAll("\\\"", "\"").replaceAll("\\\\", "\\"); }
}

function promptFromQueryLine(line: string) {
  const match = line.match(/query: Some\("((?:\\.|[^"\\])*)"\)/);
  if (!match) return "";
  try {
    const payload = JSON.parse(decodeRustString(match[1]));
    return arrayOf(payload).map((value) => firstText(objectOf(value).data, value)).filter(Boolean).join("\n");
  } catch { return decodeRustString(match[1]); }
}

function timestampFromLine(line: string) {
  return toIso(line.match(/^(\S+)/)?.[1]);
}

function decodeRustPath(value: string) {
  return value.replaceAll("\\\\", "\\");
}

function consumeProbeLine(sessions: Map<string, TraeSessionProbe>, path: string, line: string) {
  const created = line.match(/create_lite_session completed, session_id: ([0-9a-f]+), project_id: ([0-9a-f]+)/i);
  if (created) {
    sessions.set(created[1], {
      nativeSessionId: created[1], projectId: created[2], path,
      startedAt: timestampFromLine(line), updatedAt: timestampFromLine(line),
    });
    return;
  }
  const requestSession = line.match(/chat_session_id: "([0-9a-f]+)"/i)?.[1];
  if (requestSession && sessions.has(requestSession)) {
    const session = sessions.get(requestSession)!;
    const prompt = promptFromQueryLine(line);
    if (prompt) session.prompt = prompt;
    const cwd = line.match(/"project_local_path": String\("([^"]+)"\)/)?.[1]
      ?? line.match(/"workspace_folder": String\("([^"]+)"\)/)?.[1];
    if (cwd) session.cwd = decodeRustPath(cwd);
    session.updatedAt = timestampFromLine(line) ?? session.updatedAt;
  }
  const taggedSession = line.match(/(?:^|\s)session_id=([0-9a-f]{16,})(?:\s|$)/i)?.[1];
  if (taggedSession && sessions.has(taggedSession)) {
    const session = sessions.get(taggedSession)!;
    session.updatedAt = timestampFromLine(line) ?? session.updatedAt;
    if (!session.cwd) {
      const cwd = line.match(/"project_local_path": String\("([^"]+)"\)/)?.[1]
        ?? line.match(/"workspace_folder": String\("([^"]+)"\)/)?.[1];
      if (cwd) session.cwd = decodeRustPath(cwd);
    }
  }
}

/**
 * Trae's stdout log is append-only and grows without bound — one of these on
 * this machine is 1.4 GB, and re-reading it made every log scan take ~6s on its
 * own. The probe index is therefore kept per file and only the bytes appended
 * since the last scan are parsed. A file that shrank was rotated or truncated,
 * so its offset is meaningless and it is read again from the start.
 */
const probeCache = new Map<string, { size: number; offset: number; sessions: Map<string, TraeSessionProbe> }>();

async function scanPersistentLog(path: string) {
  const size = safeStat(path)?.size ?? 0;
  const previous = probeCache.get(path);
  const resumable = previous && size >= previous.size;
  const sessions = resumable ? previous.sessions : new Map<string, TraeSessionProbe>();
  const offset = await streamLinesFrom(path, resumable ? previous.offset : 0, (line) => consumeProbeLine(sessions, path, line));
  probeCache.set(path, { size, offset, sessions });
  return [...sessions.values()];
}

function parseCommitPayload(line: string) {
  const marker = "payload=";
  const start = line.indexOf(marker);
  if (start < 0 || !line.includes("[commit_toolcall_result]")) return undefined;
  const jsonStart = start + marker.length;
  const traceStart = line.indexOf(" trace_id=", jsonStart);
  const raw = line.slice(jsonStart, traceStart < 0 ? undefined : traceStart).trim();
  try { return objectOf(JSON.parse(raw)); } catch { return undefined; }
}

function statusFromToolResult(row: Record<string, unknown>): CanonicalEvent["status"] {
  if (firstText(row.toolcall_error_message)) return "failed";
  const status = String(row.toolcall_status ?? "").toLowerCase();
  if (/fail|error|cancel/.test(status)) return "failed";
  if (/block|denied|reject/.test(status)) return "blocked";
  if (/success|completed|ok/.test(status)) return "success";
  return "unknown";
}

async function extractPersistentSession(session: DiscoveredAgentSession) {
  const events: CanonicalEvent[] = [];
  const input = createReadStream(session.locator.path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const seenCalls = new Set<string>();
  let nativeEventCount = 0;
  let prompt = session.locator.prompt ?? "";
  let cwd = session.locator.cwd || undefined;
  try {
    for await (const line of lines) {
      if (!line.includes(session.nativeSessionId)) continue;
      nativeEventCount += 1;
      const timestamp = timestampFromLine(line);
      if (!prompt && line.includes("query: Some(")) prompt = promptFromQueryLine(line);
      if (!cwd) {
        const rawCwd = line.match(/"project_local_path": String\("([^"]+)"\)/)?.[1]
          ?? line.match(/"workspace_folder": String\("([^"]+)"\)/)?.[1];
        if (rawCwd) cwd = decodeRustPath(rawCwd);
      }
      const payload = parseCommitPayload(line);
      if (!payload || String(payload.conversation_id ?? "") !== session.nativeSessionId) continue;
      for (const value of arrayOf(payload.toolcall_results)) {
        const row = objectOf(value);
        const callId = String(row.toolcall_id ?? `tool_${events.length + 1}`);
        if (seenCalls.has(callId)) continue;
        seenCalls.add(callId);
        const name = String(row.toolcall_name ?? "Trae tool");
        const status = statusFromToolResult(row);
        events.push(event(`${callId}:call`, events.length + 1, "tool_call", {
          role: "assistant", name, callId, timestamp, nativeType: "trae.tool_call", status: "unknown",
        }));
        events.push(event(`${callId}:result`, events.length + 1, "tool_result", {
          role: "tool", name, callId, output: row.toolcall_resp, text: firstText(row.toolcall_resp, row.toolcall_error_message),
          timestamp, nativeType: "trae.tool_result", status,
        }));
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (prompt) events.unshift(event(`${session.nativeSessionId}:prompt`, 1, "user_message", {
    role: "user", text: prompt, timestamp: session.startedAt, nativeType: "trae.initial_message",
  }));
  events.forEach((item, index) => { item.sequence = index + 1; });
  return { events, cwd, nativeEventCount };
}

function memorySummaries(): DiscoveredAgentSession[] {
  const root = join(homedir(), ".trae-cn", "memory", "projects");
  return collectFiles(root, (_path, name) => /^session_memory_.*\.jsonl$/i.test(name), 8, 3000).map((path) => ({
    ...fileDescriptor(id, agentId, appName, path),
    title: `Trae 会话摘要 · ${basename(path).replace(/^session_memory_|\.jsonl$/g, "")}`,
    sourceKind: "memory_summary" as const,
    completeness: "summary" as const,
    warnings: ["这是旧版 Trae 的 session_memory 摘要，不包含完整逐步工具轨迹。"],
  }));
}

export const traeAdapter: AgentLogAdapter = {
  id, agentId, appName,
  async discover() {
    const probes = (await Promise.all(persistentLogs().map(scanPersistentLog))).flat();
    const latestBySession = new Map<string, TraeSessionProbe>();
    for (const probe of probes) {
      const current = latestBySession.get(probe.nativeSessionId);
      if (!current || (probe.updatedAt ?? "") > (current.updatedAt ?? "")) latestBySession.set(probe.nativeSessionId, probe);
    }
    const detailed: DiscoveredAgentSession[] = [...latestBySession.values()].map((probe) => {
      const stat = safeStat(probe.path);
      const prompt = probe.prompt?.trim() ?? "";
      return {
        key: stableKey(id, probe.path, probe.nativeSessionId), adapterId: id, agentId, appName,
        nativeSessionId: probe.nativeSessionId,
        title: prompt ? prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt : `Trae 会话 ${probe.nativeSessionId.slice(-8)}`,
        sourceKind: "agent_trace" as const,
        sourcePath: probe.path,
        startedAt: probe.startedAt,
        updatedAt: probe.updatedAt ?? stat?.mtime.toISOString(),
        sizeBytes: stat?.size,
        completeness: "partial" as const,
        warnings: [
          "Trae 新版会话数据库为加密/非标准格式；本导入器从持久 ai-agent stdout 恢复 Prompt、工具名称和完整工具结果。",
          "该日志没有稳定暴露全部模型思考、工具入参和最终回复，因此这些字段不会被猜测；可见轨迹会按 partial 标记。",
        ],
        locator: { path: probe.path, nativeSessionId: probe.nativeSessionId, prompt, cwd: probe.cwd ?? "", projectId: probe.projectId ?? "" },
      };
    });
    return latestFirst(detailed.length ? detailed : memorySummaries());
  },

  async extract(session: DiscoveredAgentSession) {
    if (session.sourceKind === "agent_trace") {
      const extracted = await extractPersistentSession(session);
      return {
        session, events: extracted.events, cwd: extracted.cwd, warnings: [...session.warnings],
        sourceFiles: [fileHash(session.locator.path)], nativeEventCount: extracted.nativeEventCount,
      };
    }

    const rows = await readJsonLines(session.locator.path);
    const events: CanonicalEvent[] = [];
    let sequence = 0;
    for (const value of rows) {
      const row = objectOf(value);
      const timestamp = toIso(row.message_summary_time ?? row.timestamp);
      const base = String(row.message_id ?? `summary_${sequence + 1}`);
      const intent = textFrom(row.intent);
      if (intent) events.push(event(`${base}:intent`, ++sequence, "user_message", { role: "user", text: intent, timestamp, nativeType: "session_memory.intent" }));
      const actions = textFrom(row.actions);
      if (actions) events.push(event(`${base}:actions`, ++sequence, "observation", { role: "assistant", name: "Trae 摘要动作", text: actions, timestamp, nativeType: "session_memory.actions", status: "unknown" }));
      const learned = textFrom(row.learned);
      if (learned) events.push(event(`${base}:learned`, ++sequence, "reasoning", { role: "assistant", text: learned, timestamp, nativeType: "session_memory.learned" }));
      const outcome = textFrom(row.outcome);
      if (outcome) events.push(event(`${base}:outcome`, ++sequence, "assistant_message", { role: "assistant", text: outcome, timestamp, nativeType: "session_memory.outcome", status: "success" }));
    }
    return { session, events, warnings: [...session.warnings], sourceFiles: [fileHash(session.locator.path)], nativeEventCount: rows.length };
  },
};
