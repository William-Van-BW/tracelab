import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLogAdapter, CanonicalEvent, DiscoveredAgentSession } from "../types";
import { arrayOf, collectFiles, event, fileDescriptor, fileHash, firstText, latestFirst, objectOf, readJsonLines, textFrom, toIso } from "../utils";

const id = "workbuddy";
const agentId = "agent_workbuddy";
const appName = "WorkBuddy";

function mapRecord(value: unknown, sequence: number): CanonicalEvent[] {
  const row = objectOf(value);
  const type = String(row.type ?? "unknown");
  const role = String(row.role ?? objectOf(row.message).role ?? "");
  const timestamp = toIso(row.timestamp ?? row.created_at ?? row.createdAt);
  const nativeId = String(row.id ?? row.message_id ?? row.call_id ?? `event_${sequence}`);
  const message = objectOf(row.message);
  const content = row.content ?? message.content ?? row.message;
  const text = arrayOf(content).map(textFrom).filter(Boolean).join("\n") || firstText(row.content, message.content, row.message, row.rawContent);
  if (type === "message" && role === "user") return [event(nativeId, sequence, "user_message", { role: "user", text, timestamp, nativeType: type })];
  if (type === "message" && role === "assistant") return [event(nativeId, sequence, "assistant_message", { role: "assistant", text, timestamp, nativeType: type, status: "success" })];
  if (type === "reasoning") return [event(nativeId, sequence, "reasoning", { role: "assistant", text, timestamp, nativeType: type })];
  if (type === "function_call") return [event(nativeId, sequence, "tool_call", {
    role: "assistant", name: String(row.name ?? row.function_name ?? objectOf(row.function).name ?? "tool"),
    callId: String(row.call_id ?? row.callId ?? nativeId), input: row.arguments ?? row.input ?? objectOf(row.function).arguments, timestamp, nativeType: type,
  })];
  if (type === "function_call_result") return [event(nativeId, sequence, "tool_result", {
    role: "tool", name: String(row.name ?? row.function_name ?? "tool"), callId: String(row.call_id ?? row.callId ?? row.function_call_id ?? nativeId),
    output: row.result ?? row.output ?? row.content, timestamp, nativeType: type, status: row.error ? "failed" : "success",
  })];
  if (/compact|summary/i.test(type) && text) return [event(nativeId, sequence, "context_compaction", { text, timestamp, nativeType: type })];
  return [];
}

export const workbuddyAdapter: AgentLogAdapter = {
  id, agentId, appName,
  async discover() {
    const root = join(homedir(), ".workbuddy", "projects");
    if (!existsSync(root)) return [];
    return latestFirst(collectFiles(root, (_path, name) => name.endsWith(".jsonl"), 6, 3000).map((path) => ({
      ...fileDescriptor(id, agentId, appName, path), title: `WorkBuddy 会话 · ${path.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/i, "")}`,
      sourceKind: "jsonl" as const, completeness: "full" as const, warnings: [],
    })));
  },
  async extract(session: DiscoveredAgentSession) {
    const rows = await readJsonLines(session.locator.path);
    const events = rows.flatMap((row, index) => mapRecord(row, index + 1)).filter((item) => item.text || item.input || item.output);
    const titleRecord = rows.map(objectOf).find((row) => row.type === "ai-title");
    if (titleRecord) session.title = firstText(titleRecord.title, titleRecord.content) || session.title;
    return { session, events, warnings: [...session.warnings], sourceFiles: [fileHash(session.locator.path)], nativeEventCount: rows.length };
  },
};
