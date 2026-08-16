import { existsSync } from "node:fs";
import { join } from "node:path";
import { rows, withSqliteSnapshot } from "../sqlite";
import type { AgentLogAdapter, CanonicalEvent, DiscoveredAgentSession } from "../types";
import { collectFiles, event, fileHash, latestFirst, objectOf, parseJson, stableKey, textFrom, toIso } from "../utils";

const id = "dumate";
const agentId = "agent_dumate";
const appName = "DuMate";

function databaseFiles() {
  const root = join(process.env.APPDATA ?? "", "qianfan-desktop-app", "qianfan_desk_xdg");
  if (!existsSync(root)) return [];
  return collectFiles(root, (path, name) => name === "opencode.db" && !/[\\/]cloudsync[\\/]/i.test(path), 7, 30);
}

function sourceFiles(path: string) {
  return [path, `${path}-wal`].filter(existsSync).map(fileHash);
}

export const dumateAdapter: AgentLogAdapter = {
  id, agentId, appName,
  async discover() {
    const sessions: DiscoveredAgentSession[] = [];
    for (const path of databaseFiles()) {
      try {
        withSqliteSnapshot(path, (database) => {
          for (const row of rows(database, "SELECT * FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC")) {
            const nativeSessionId = String(row.id);
            sessions.push({
              key: stableKey(id, path, nativeSessionId), adapterId: id, agentId, appName, nativeSessionId,
              title: String(row.title ?? row.slug ?? `DuMate 会话 ${nativeSessionId.slice(0, 8)}`), sourceKind: "sqlite", sourcePath: path,
              startedAt: toIso(row.time_created), updatedAt: toIso(row.time_updated), completeness: "full",
              warnings: ["opencode.db 通过包含 WAL 的临时只读快照读取，不修改 DuMate 数据库。"],
              locator: { path, nativeSessionId, directory: String(row.directory ?? "") },
            });
          }
        });
      } catch { /* report as not found through adapter status */ }
    }
    return latestFirst(sessions);
  },
  async extract(session: DiscoveredAgentSession) {
    const extracted = withSqliteSnapshot(session.locator.path, (database) => {
      const messages = rows(database, "SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id", session.nativeSessionId);
      const parts = rows(database, "SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id", session.nativeSessionId);
      const partsByMessage = new Map<string, typeof parts>();
      for (const part of parts) {
        const list = partsByMessage.get(String(part.message_id)) ?? [];
        list.push(part); partsByMessage.set(String(part.message_id), list);
      }
      const events: CanonicalEvent[] = [];
      let sequence = 0;
      let model: string | undefined;
      for (const messageRow of messages) {
        const message = objectOf(parseJson(messageRow.data));
        const role = String(message.role ?? "");
        model ||= String(message.modelID ?? objectOf(message.model).id ?? "") || undefined;
        const messageParts = partsByMessage.get(String(messageRow.id)) ?? [];
        const timestamp = toIso(messageRow.time_created ?? objectOf(message.time).created);
        if (role === "user") {
          const text = messageParts.map((part) => textFrom(objectOf(parseJson(part.data)).text)).filter(Boolean).join("\n");
          if (text) events.push(event(String(messageRow.id), ++sequence, "user_message", { role: "user", text, timestamp, nativeType: "dumate.message" }));
          continue;
        }
        for (const partRow of messageParts) {
          const part = objectOf(parseJson(partRow.data));
          const type = String(part.type ?? "");
          const partTimestamp = toIso(partRow.time_created ?? objectOf(part.time).start) ?? timestamp;
          if (type === "text") {
            const text = textFrom(part.text);
            if (text) events.push(event(String(partRow.id), ++sequence, "assistant_message", { role: "assistant", text, timestamp: partTimestamp, nativeType: type, status: "success" }));
          } else if (type === "reasoning") {
            events.push(event(String(partRow.id), ++sequence, "reasoning", { role: "assistant", text: textFrom(part.text), timestamp: partTimestamp, nativeType: type }));
          } else if (type === "tool") {
            const state = objectOf(part.state);
            events.push(event(String(partRow.id), ++sequence, "tool_call", {
              role: "assistant", name: String(part.tool ?? "tool"), callId: String(part.callID ?? partRow.id), input: state.input,
              output: state.output ?? state.error, timestamp: partTimestamp, nativeType: type,
              status: state.status === "completed" ? "success" : state.status === "error" ? "failed" : "unknown",
            }));
          }
        }
      }
      return { messages, parts, events, model };
    });
    return {
      session, events: extracted.events, model: extracted.model, cwd: session.locator.directory || undefined,
      warnings: [...session.warnings], sourceFiles: sourceFiles(session.locator.path),
      nativeEventCount: extracted.messages.length + extracted.parts.length,
    };
  },
};
