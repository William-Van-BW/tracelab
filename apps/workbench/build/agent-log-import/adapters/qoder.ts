import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rows, withSqliteSnapshot } from "../sqlite";
import type { AgentLogAdapter, CanonicalEvent, DiscoveredAgentSession } from "../types";
import { arrayOf, collectFiles, event, fileDescriptor, fileHash, firstText, latestFirst, objectOf, parseJson, readJsonLines, safeStringify, stableKey, textFrom, toIso } from "../utils";

const agentId = "agent_qoder";

/**
 * QoderWork ships an international build and a mainland China build ("QoderWork
 * CN"). They are the same product with the same on-disk shape — an `agents.db`
 * with identical `chats` / `sub_chats` / `messages` tables, plus per-project
 * JSONL transcripts under a dotted home directory — so both are the same
 * adapter with different roots, and both map to the single `agent_qoder`
 * profile the way Trae's two builds share one profile.
 */
type QoderVariant = { id: string; appName: string; appDataDirectory: string; homeDirectory: string };

function toolKind(name: string) {
  if (/thinking/i.test(name)) return "reasoning";
  if (/askuserquestion/i.test(name)) return "approval";
  return "tool_call";
}

function qoderMessageEvents(row: Record<string, unknown>, baseSequence: number) {
  const result: CanonicalEvent[] = [];
  const role = String(row.role ?? "");
  const parts = arrayOf(parseJson(row.parts));
  const timestamp = toIso(row.created_at ?? row.updated_at);
  const messageId = String(row.message_id ?? row.id ?? `message_${baseSequence}`);
  let offset = 0;
  if (role === "user") {
    const text = parts.map(textFrom).filter(Boolean).join("\n");
    if (text) result.push(event(messageId, baseSequence * 1000, "user_message", { role: "user", text, timestamp, nativeType: "qoder.message" }));
    return result;
  }
  for (const value of parts) {
    const part = objectOf(value);
    const type = String(part.type ?? "");
    const sequence = baseSequence * 1000 + ++offset;
    if (type === "text") {
      const text = textFrom(part.text);
      if (text) result.push(event(String(part.id ?? `${messageId}:text:${offset}`), sequence, "assistant_message", { role: "assistant", text, timestamp, nativeType: type, status: "success" }));
      continue;
    }
    if (!type.startsWith("tool-")) continue;
    const name = String(part.toolName ?? type.slice(5));
    const kind = toolKind(name);
    const callId = String(part.toolCallId ?? `${messageId}:tool:${offset}`);
    const output = part.output ?? part.result ?? part.errorText;
    if (kind === "reasoning") result.push(event(callId, sequence, "reasoning", { role: "assistant", name, text: firstText(part.input, output, part.result), timestamp, nativeType: type }));
    else if (kind === "approval") result.push(event(callId, sequence, "approval", { role: "assistant", name, text: safeStringify(part.input), output, timestamp, nativeType: type, status: part.errorText ? "failed" : "unknown" }));
    else result.push(event(callId, sequence, "tool_call", {
      role: "assistant", name, callId, input: part.input, output, timestamp, nativeType: type,
      status: part.errorText ? "failed" : output === undefined ? "unknown" : "success",
    }));
  }
  return result;
}

async function jsonlEvents(path: string) {
  const input = await readJsonLines(path);
  const events: CanonicalEvent[] = [];
  for (const [index, value] of input.entries()) {
    const row = objectOf(value);
    const type = String(row.type ?? row.role ?? "");
    const message = objectOf(row.message);
    const role = String(row.role ?? message.role ?? type);
    const content = row.content ?? message.content ?? row.text;
    const text = arrayOf(content).map(textFrom).filter(Boolean).join("\n") || textFrom(content);
    const timestamp = toIso(row.timestamp ?? row.created_at);
    if (/user|last-prompt/i.test(role) && text) events.push(event(String(row.id ?? `event_${index + 1}`), index + 1, "user_message", { role: "user", text, timestamp, nativeType: type }));
    else if (/assistant/i.test(role)) {
      if (text) events.push(event(String(row.id ?? `event_${index + 1}`), index + 1, "assistant_message", { role: "assistant", text, timestamp, nativeType: type, status: "success" }));
      for (const [partIndex, part] of arrayOf(content).entries()) {
        const item = objectOf(part);
        if (String(item.type ?? "").startsWith("tool-")) events.push(...qoderMessageEvents({ role: "assistant", parts: [item], id: `${index}:${partIndex}` }, index + 1));
      }
    }
  }
  return { input, events };
}

function createQoderAdapter(variant: QoderVariant): AgentLogAdapter {
  const { id, appName } = variant;
  const databasePath = join(process.env.APPDATA ?? "", variant.appDataDirectory, "data", "agents.db");
  return {
    id, agentId, appName,
    async discover() {
      const sessions: DiscoveredAgentSession[] = [];
      if (existsSync(databasePath)) {
        try {
          withSqliteSnapshot(databasePath, (database) => {
            const chats = new Map(rows(database, "SELECT * FROM chats").map((chat) => [String(chat.id), chat]));
            for (const subChat of rows(database, "SELECT * FROM sub_chats ORDER BY updated_at DESC")) {
              const chat = chats.get(String(subChat.chat_id));
              const nativeSessionId = String(subChat.session_id ?? subChat.id);
              sessions.push({
                key: stableKey(id, databasePath, nativeSessionId), adapterId: id, agentId, appName, nativeSessionId,
                title: String(subChat.name ?? chat?.name ?? `${appName} 会话 ${nativeSessionId.slice(0, 8)}`), sourceKind: "sqlite", sourcePath: databasePath,
                startedAt: toIso(subChat.created_at ?? chat?.created_at), updatedAt: toIso(subChat.updated_at ?? chat?.updated_at),
                completeness: "full", warnings: [`SQLite 数据通过临时只读快照读取，不修改 ${appName} 数据库。`],
                locator: { path: databasePath, subChatId: String(subChat.id), chatId: String(subChat.chat_id), nativeSessionId },
              });
            }
          });
        } catch { /* JSONL fallback below */ }
      }
      if (!sessions.length) {
        const root = join(homedir(), variant.homeDirectory, "projects");
        sessions.push(...collectFiles(root, (_path, name) => name.endsWith(".jsonl"), 7, 3000).map((path) => ({
          ...fileDescriptor(id, agentId, appName, path), title: `${appName} JSONL · ${path.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/i, "")}`,
          sourceKind: "jsonl" as const, completeness: "partial" as const, warnings: [`agents.db 不可用，已降级为 ${appName} 项目 JSONL。`],
        })));
      }
      return latestFirst(sessions);
    },
    async extract(session: DiscoveredAgentSession) {
      if (session.sourceKind === "jsonl") {
        const { input, events } = await jsonlEvents(session.locator.path);
        return { session, events, warnings: [...session.warnings], sourceFiles: [fileHash(session.locator.path)], nativeEventCount: input.length };
      }
      const messages = withSqliteSnapshot(session.locator.path, (database) => rows(database, "SELECT * FROM messages WHERE sub_chat_id = ? ORDER BY sequence, created_at", session.locator.subChatId));
      const events = messages.flatMap((row, index) => qoderMessageEvents(row, Number(row.sequence ?? index + 1)));
      const nativePartCount = messages.reduce((sum, row) => sum + arrayOf(parseJson(row.parts)).length, 0);
      const assistantMetadata = messages.map((row) => objectOf(row.metadata)).find((metadata) => metadata.model || metadata.modelName);
      return {
        session, events, model: String(assistantMetadata?.model ?? assistantMetadata?.modelName ?? "") || undefined,
        warnings: [...session.warnings], sourceFiles: [fileHash(session.locator.path)], nativeEventCount: messages.length + nativePartCount,
      };
    },
  };
}

export const qoderAdapter = createQoderAdapter({
  id: "qoder", appName: "Qoder", appDataDirectory: "QoderWork", homeDirectory: ".qoderwork",
});

export const qoderCnAdapter = createQoderAdapter({
  id: "qodercn", appName: "QoderWorkCN", appDataDirectory: "QoderWork CN", homeDirectory: ".qoderworkcn",
});
