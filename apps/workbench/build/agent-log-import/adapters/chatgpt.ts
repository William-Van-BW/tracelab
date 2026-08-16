import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLogAdapter, CanonicalEvent, DiscoveredAgentSession } from "../types";
import { arrayOf, collectFiles, event, fileDescriptor, fileHash, firstText, latestFirst, objectOf, readJsonLines, safeStat, safeStringify, stableKey, textFrom, toIso } from "../utils";

const id = "chatgpt_codex";
const agentId = "agent_chatgpt";
const appName = "ChatGPT / OpenAI Codex";

function contentText(payload: Record<string, unknown>) {
  return arrayOf(payload.content).map((item) => textFrom(item)).filter(Boolean).join("\n");
}

function mapRecord(value: unknown, sequence: number): CanonicalEvent[] {
  const row = objectOf(value);
  const payload = objectOf(row.payload);
  const nativeType = String(payload.type ?? row.type ?? "unknown");
  const timestamp = toIso(row.timestamp ?? payload.timestamp);
  const nativeId = String(payload.id ?? payload.event_id ?? payload.call_id ?? `event_${sequence}`);
  const result: CanonicalEvent[] = [];
  const push = (kind: CanonicalEvent["kind"], patch: Partial<CanonicalEvent>) => result.push(event(nativeId, sequence, kind, { timestamp, nativeType, ...patch }));

  if (nativeType === "user_message") push("user_message", { role: "user", text: firstText(payload.message, payload.text, payload.content) });
  else if (nativeType === "agent_message") push("assistant_message", { role: "assistant", text: firstText(payload.message, payload.text, payload.content), status: "success" });
  else if (["agent_reasoning", "reasoning"].includes(nativeType)) push("reasoning", { role: "assistant", text: firstText(payload.text, payload.message, payload.content, payload.summary) });
  else if (["context_compacted", "compaction"].includes(nativeType)) push("context_compaction", { text: firstText(payload.message, payload.content, payload.summary) });
  else if (["custom_tool_call", "function_call", "mcp_tool_call"].includes(nativeType)) push("tool_call", {
    role: "assistant", name: String(payload.name ?? payload.tool_name ?? payload.server ?? "tool"), callId: String(payload.call_id ?? payload.id ?? nativeId),
    input: payload.arguments ?? payload.input ?? payload.params,
  });
  else if (["custom_tool_call_output", "function_call_output", "mcp_tool_call_end"].includes(nativeType)) push("tool_result", {
    role: "tool", name: String(payload.name ?? payload.tool_name ?? "tool"), callId: String(payload.call_id ?? payload.id ?? nativeId),
    output: payload.output ?? payload.result ?? payload.message, status: payload.error ? "failed" : "success",
  });
  else if (nativeType === "message") {
    const role = String(payload.role ?? "");
    const text = contentText(payload) || textFrom(payload.text);
    if (role === "user" && text) push("user_message", { role: "user", text });
    else if (role === "assistant" && text) push("assistant_message", { role: "assistant", text, status: "success" });
  } else if (/approval|permission/i.test(nativeType)) push("approval", { text: safeStringify(payload), status: "unknown" });
  return result;
}

function chatGptExports() {
  const roots = [join(homedir(), "Downloads"), join(homedir(), "Documents"), join(homedir(), "Desktop")];
  return roots.flatMap((root) => collectFiles(root, (_path, name) => name.toLocaleLowerCase() === "conversations.json", 3, 100));
}

function parseChatGptExport(path: string) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return arrayOf(value).filter((item) => {
      const row = objectOf(item);
      return Boolean(row.mapping || row.conversation_id);
    });
  } catch { return []; }
}

export const chatgptAdapter: AgentLogAdapter = {
  id, agentId, appName,
  async discover() {
    const root = join(homedir(), ".codex", "sessions");
    const sessions: DiscoveredAgentSession[] = [];
    const files = existsSync(root) ? collectFiles(root, (_path, name) => /^rollout-.*\.jsonl$/i.test(name), 5, 3000) : [];
    sessions.push(...files.map((path) => ({
      ...fileDescriptor(id, agentId, appName, path),
      title: `Codex 会话 · ${path.split(/[\\/]/).at(-1)?.replace(/^rollout-|\.jsonl$/g, "")}`,
      sourceKind: "jsonl" as const,
      completeness: "full" as const,
      warnings: ["本机发现的是 OpenAI Codex rollout 日志；如需消费者版 ChatGPT Desktop，需使用其导出文件。"],
    })));
    for (const path of chatGptExports()) {
      const stat = safeStat(path);
      if (!stat || stat.size > 1024 * 1024 * 1024) continue;
      for (const [index, value] of parseChatGptExport(path).entries()) {
        const row = objectOf(value);
        const nativeSessionId = String(row.conversation_id ?? row.id ?? `conversation_${index + 1}`);
        sessions.push({
          key: stableKey(id, path, nativeSessionId), adapterId: id, agentId, appName, nativeSessionId,
          title: String(row.title ?? `ChatGPT 导出会话 ${index + 1}`), sourceKind: "export", sourcePath: path,
          startedAt: toIso(row.create_time), updatedAt: toIso(row.update_time) ?? stat.mtime.toISOString(), sizeBytes: stat.size,
          completeness: "partial", warnings: ["ChatGPT 导出保留对话消息，但通常不包含桌面 Agent 的全部内部工具事件。"],
          locator: { path, nativeSessionId, index: String(index) },
        });
      }
    }
    return latestFirst(sessions);
  },
  async extract(session: DiscoveredAgentSession) {
    if (session.sourceKind === "export") {
      const conversation = objectOf(parseChatGptExport(session.locator.path)[Number(session.locator.index ?? 0)]);
      const nodes = Object.values(objectOf(conversation.mapping)).map(objectOf).map((node) => objectOf(node.message)).filter((message) => Object.keys(message).length);
      nodes.sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
      const events: CanonicalEvent[] = [];
      let model: string | undefined;
      for (const [index, message] of nodes.entries()) {
        const role = String(objectOf(message.author).role ?? "");
        const content = objectOf(message.content);
        const text = arrayOf(content.parts).map(textFrom).filter(Boolean).join("\n") || textFrom(content.text);
        model ||= String(objectOf(message.metadata).model_slug ?? "") || undefined;
        if (!text || !["user", "assistant"].includes(role)) continue;
        events.push(event(String(message.id ?? `message_${index + 1}`), index + 1, role === "user" ? "user_message" : "assistant_message", {
          role: role as "user" | "assistant", text, timestamp: toIso(message.create_time), nativeType: String(content.content_type ?? "chatgpt_export_message"),
          status: role === "assistant" ? "success" : "unknown",
        }));
      }
      return { session, events, model, warnings: [...session.warnings], sourceFiles: [fileHash(session.locator.path)], nativeEventCount: nodes.length };
    }
    const rows = await readJsonLines(session.locator.path);
    const events = rows.flatMap((row, index) => mapRecord(row, index + 1)).filter((item) => item.text || item.input || item.output);
    const metadata = rows.map(objectOf).find((row) => row.type === "session_meta");
    const payload = objectOf(metadata?.payload);
    return {
      session,
      events,
      model: String(payload.model ?? payload.model_name ?? "") || undefined,
      cwd: String(payload.cwd ?? "") || undefined,
      warnings: [...session.warnings],
      sourceFiles: [fileHash(session.locator.path)],
      nativeEventCount: rows.length,
    };
  },
};
