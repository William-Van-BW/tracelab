import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentLogAdapter, CanonicalEvent, DiscoveredAgentSession } from "../types";
import { arrayOf, collectFiles, event, fileHash, firstText, latestFirst, objectOf, readJsonLines, safeStat, stableKey, textFrom, toIso } from "../utils";

const id = "claude";
const agentId = "agent_claude_desktop";
const appName = "Claude Desktop";

function exportFiles() {
  const roots = [join(homedir(), "Downloads"), join(homedir(), "Documents"), join(homedir(), "Desktop")];
  return roots.flatMap((root) => collectFiles(root, (_path, name) => /^(conversations|claude[-_].*)\.json$/i.test(name), 3, 300));
}

function claudeDataRoots() {
  const roots = new Set<string>();
  for (const candidate of [join(process.env.APPDATA ?? "", "Claude"), join(process.env.LOCALAPPDATA ?? "", "Claude")]) {
    if (candidate && existsSync(candidate)) roots.add(candidate);
  }
  const packages = join(process.env.LOCALAPPDATA ?? "", "Packages");
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Claude_/i.test(entry.name)) continue;
      const candidate = join(packages, entry.name, "LocalCache", "Roaming", "Claude");
      if (existsSync(candidate)) roots.add(candidate);
    }
  }
  return [...roots];
}

function localSessionMetadataFiles() {
  return claudeDataRoots().flatMap((root) => collectFiles(
    join(root, "local-agent-mode-sessions"),
    (path, name) => /^local_[0-9a-f-]+\.json$/i.test(name) && !/[\\/]skills-plugin[\\/]/i.test(path),
    5,
    2000,
  ));
}

function parseExport(path: string) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(value)) return value.filter((item) => Boolean(objectOf(item).chat_messages ?? objectOf(item).messages));
    const root = objectOf(value);
    return arrayOf(root.conversations ?? root.chats ?? root.data).filter((item) => Boolean(objectOf(item).chat_messages ?? objectOf(item).messages));
  } catch { return []; }
}

function parseMetadata(path: string) {
  try { return objectOf(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
}

function findTranscript(metadataPath: string, cliSessionId: string) {
  if (!cliSessionId) return undefined;
  return collectFiles(dirname(metadataPath), (_path, name) => name === `${cliSessionId}.jsonl`, 8, 40)[0];
}

function contentBlocks(value: unknown) {
  const content = objectOf(value).message ? objectOf(objectOf(value).message).content : objectOf(value).content;
  return arrayOf(content).map(objectOf);
}

function isRealUserMessage(row: Record<string, unknown>) {
  if (row.type !== "user" || row.isMeta === true) return false;
  const message = objectOf(row.message);
  if (typeof message.content === "string") return Boolean(message.content.trim());
  return arrayOf(message.content).some((block) => {
    const item = objectOf(block);
    return item.type !== "tool_result" && Boolean(textFrom(item));
  });
}

function blockText(block: Record<string, unknown>) {
  return firstText(block.text, block.content, block.thinking, block.message);
}

export const claudeAdapter: AgentLogAdapter = {
  id, agentId, appName,
  async discover() {
    const sessions: DiscoveredAgentSession[] = [];

    for (const metadataPath of localSessionMetadataFiles()) {
      const metadata = parseMetadata(metadataPath);
      const nativeSessionId = String(metadata.sessionId ?? basename(metadataPath, ".json"));
      const cliSessionId = String(metadata.cliSessionId ?? "");
      const transcriptPath = findTranscript(metadataPath, cliSessionId);
      const metadataStat = safeStat(metadataPath);
      const transcriptStat = transcriptPath ? safeStat(transcriptPath) : undefined;
      const initialMessage = firstText(metadata.initialMessage);
      sessions.push({
        key: stableKey(id, metadataPath, nativeSessionId),
        adapterId: id,
        agentId,
        appName,
        nativeSessionId,
        title: firstText(metadata.title, initialMessage) || `Claude 会话 ${nativeSessionId.slice(-8)}`,
        sourceKind: "jsonl",
        sourcePath: transcriptPath ?? metadataPath,
        startedAt: toIso(metadata.createdAt),
        updatedAt: toIso(metadata.lastActivityAt) ?? transcriptStat?.mtime.toISOString() ?? metadataStat?.mtime.toISOString(),
        sizeBytes: transcriptStat?.size ?? metadataStat?.size,
        completeness: transcriptPath ? "full" : "partial",
        warnings: transcriptPath
          ? ["从 Claude 本地 Agent JSONL 转录导入；保留可见文本、工具调用、工具结果和源日志实际记录的思考块，不推测隐藏思考。"]
          : ["发现 Claude 会话元数据，但对应 JSONL 转录已移动或尚未落盘；只能恢复元数据中的初始 Prompt。"],
        locator: {
          path: transcriptPath ?? metadataPath,
          metadataPath,
          transcriptPath: transcriptPath ?? "",
          cliSessionId,
          nativeSessionId,
        },
      });
    }

    for (const path of exportFiles()) {
      const stat = safeStat(path);
      if (!stat || stat.size > 500 * 1024 * 1024) continue;
      for (const [index, value] of parseExport(path).entries()) {
        const row = objectOf(value);
        const nativeSessionId = String(row.uuid ?? row.id ?? `conversation_${index + 1}`);
        sessions.push({
          key: stableKey(id, path, nativeSessionId), adapterId: id, agentId, appName, nativeSessionId,
          title: String(row.name ?? row.title ?? `Claude 导出会话 ${index + 1}`), sourceKind: "export", sourcePath: path,
          startedAt: toIso(row.created_at ?? row.createdAt), updatedAt: toIso(row.updated_at ?? row.updatedAt) ?? stat.mtime.toISOString(), sizeBytes: stat.size,
          completeness: "full", warnings: ["Claude conversations.json 通常只包含消息；桌面 Agent 的工具事件以本地 JSONL 为准。"],
          locator: { path, nativeSessionId, index: String(index) },
        });
      }
    }

    return latestFirst(sessions);
  },

  async extract(session: DiscoveredAgentSession) {
    const events: CanonicalEvent[] = [];
    let nativeEventCount = 0;
    let model: string | undefined;
    let cwd: string | undefined;
    const sourceFiles: ReturnType<typeof fileHash>[] = [];

    if (session.sourceKind === "export") {
      const conversation = parseExport(session.locator.path)[Number(session.locator.index ?? 0)];
      const row = objectOf(conversation);
      const messages = arrayOf(row.chat_messages ?? row.messages);
      nativeEventCount = messages.length;
      for (const [index, value] of messages.entries()) {
        const message = objectOf(value);
        const role = String(message.sender ?? message.role ?? message.author ?? "");
        const text = firstText(message.text, message.content, message.message);
        if (!text) continue;
        const kind = /human|user/i.test(role) ? "user_message" : "assistant_message";
        events.push(event(String(message.uuid ?? message.id ?? `message_${index + 1}`), events.length + 1, kind, {
          role: kind === "user_message" ? "user" : "assistant", text,
          timestamp: toIso(message.created_at ?? message.createdAt ?? message.timestamp), nativeType: String(message.type ?? "export_message"),
          status: kind === "assistant_message" ? "success" : "unknown",
        }));
      }
      sourceFiles.push(fileHash(session.locator.path));
    } else {
      const metadata = parseMetadata(session.locator.metadataPath || session.locator.path);
      model = firstText(metadata.model) || undefined;
      cwd = firstText(arrayOf(metadata.userSelectedFolders)[0], metadata.cwd) || undefined;
      const transcriptPath = session.locator.transcriptPath;
      const rows = transcriptPath && existsSync(transcriptPath) ? await readJsonLines(transcriptPath) : [];
      nativeEventCount = rows.length || 1;

      if (!rows.length) {
        const prompt = firstText(metadata.initialMessage);
        if (prompt) events.push(event(`${session.nativeSessionId}:prompt`, 1, "user_message", { role: "user", text: prompt, timestamp: toIso(metadata.createdAt), nativeType: "claude.session_metadata" }));
      } else {
        const parsedRows = rows.map(objectOf);
        const realUserIndexes = parsedRows.map((row, index) => isRealUserMessage(row) ? index : -1).filter((index) => index >= 0);
        const lastAssistantTextIndexes = new Set<number>();
        for (let segment = 0; segment < realUserIndexes.length; segment += 1) {
          const start = realUserIndexes[segment];
          const end = realUserIndexes[segment + 1] ?? parsedRows.length;
          let lastText = -1;
          for (let index = start + 1; index < end; index += 1) {
            const row = parsedRows[index];
            if (row.type !== "assistant") continue;
            if (contentBlocks(row).some((block) => block.type === "text" && Boolean(blockText(block)))) lastText = index;
          }
          if (lastText >= 0) lastAssistantTextIndexes.add(lastText);
        }

        for (const [rowIndex, row] of parsedRows.entries()) {
          const timestamp = toIso(row.timestamp);
          const uuid = String(row.uuid ?? row.messageId ?? `line_${rowIndex + 1}`);
          const message = objectOf(row.message);
          if (!model) model = firstText(message.model) || undefined;

          if (isRealUserMessage(row)) {
            const text = firstText(message.content);
            if (text) events.push(event(uuid, events.length + 1, "user_message", { role: "user", text, timestamp, nativeType: "claude.user" }));
            continue;
          }
          if (row.type === "assistant") {
            for (const [blockIndex, block] of contentBlocks(row).entries()) {
              const blockId = `${uuid}:${blockIndex + 1}`;
              if (block.type === "tool_use") {
                events.push(event(blockId, events.length + 1, "tool_call", {
                  role: "assistant", name: String(block.name ?? "Claude tool"), callId: String(block.id ?? blockId), input: block.input,
                  timestamp, nativeType: "claude.tool_use", status: "unknown",
                }));
              } else if (block.type === "thinking") {
                const text = blockText(block);
                if (text) events.push(event(blockId, events.length + 1, "reasoning", { role: "assistant", text, timestamp, nativeType: "claude.thinking" }));
              } else if (block.type === "redacted_thinking") {
                events.push(event(blockId, events.length + 1, "observation", { role: "assistant", text: "Claude 源日志包含一个已加密的思考块，无法恢复其内容。", timestamp, nativeType: "claude.redacted_thinking" }));
              } else if (block.type === "text") {
                const text = blockText(block);
                if (!text) continue;
                const kind = lastAssistantTextIndexes.has(rowIndex) ? "assistant_message" : "reasoning";
                events.push(event(blockId, events.length + 1, kind, { role: "assistant", text, timestamp, nativeType: `claude.${String(block.type)}`, status: kind === "assistant_message" ? "success" : "unknown" }));
              }
            }
            continue;
          }
          if (row.type === "user" && row.isMeta !== true) {
            for (const [blockIndex, block] of contentBlocks(row).entries()) {
              if (block.type !== "tool_result") continue;
              const callId = String(block.tool_use_id ?? `${uuid}:${blockIndex + 1}`);
              events.push(event(`${uuid}:${blockIndex + 1}`, events.length + 1, "tool_result", {
                role: "tool", callId, output: block.content ?? row.toolUseResult, text: firstText(block.content, row.toolUseResult),
                timestamp, nativeType: "claude.tool_result", status: block.is_error === true ? "failed" : "success",
              }));
            }
          }
        }
      }
      if (existsSync(session.locator.metadataPath)) sourceFiles.push(fileHash(session.locator.metadataPath));
      if (transcriptPath && existsSync(transcriptPath)) sourceFiles.push(fileHash(transcriptPath));
    }

    return { session, events, model, cwd, warnings: [...session.warnings], sourceFiles, nativeEventCount };
  },
};
