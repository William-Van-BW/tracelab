import type { CanonicalEvent, ExtractedAgentSession } from "./types";
import { safeStringify, stableId } from "./utils";

type Step = {
  id: string;
  order: number;
  kind: string;
  kindSource: "builtin";
  label: string;
  observationBasis: "imported_log";
  certainty: "exact" | "approximate" | "inferred" | "unknown";
  status: "success" | "blocked" | "failed" | "unknown";
  content: string;
  parametersSummary: string;
  resultSummary: string;
  operatorNote: string;
  annotations: string[];
  summaries: string[];
  evidence: never[];
  importedSource: { nativeEventIds: string[]; nativeType?: string; timestamp?: string; callId?: string };
};

function classifyTool(name = "") {
  if (/thinking|reason/i.test(name)) return "reasoning";
  if (/bash|shell|command|terminal|powershell|cmd/i.test(name)) return "command_execution";
  if (/read|write|edit|glob|grep|file|directory|listdir/i.test(name)) return "file_operation";
  if (/skill/i.test(name)) return "skill_call";
  if (/mcp.*list|mcp_discovery|list.*mcp/i.test(name)) return "mcp_discovery";
  if (/search|query/i.test(name)) return "web_search";
  if (/browser|navigate|click|screenshot|page/i.test(name)) return "browser_action";
  if (/approve|permission|askuser|question/i.test(name)) return "approval";
  return "tool_or_action";
}

function stepFor(event: CanonicalEvent, index: number): Step {
  const defaultLabels: Record<string, string> = { reasoning: "Agent 推理", assistant_response: "Agent 回复", context_compaction: "上下文压缩", approval: "审批交互", observation: "日志观察" };
  const kind = event.kind === "tool_call" || event.kind === "tool_result" ? classifyTool(event.name)
    : event.kind === "assistant_message" ? "assistant_response"
      : event.kind === "context_compaction" ? "context_compaction"
        : event.kind === "approval" ? "approval"
          : event.kind === "observation" ? "observation" : "reasoning";
  const content = safeStringify(event.text);
  return {
    id: `step_${index}`,
    order: index,
    kind,
    kindSource: "builtin",
    label: event.name || (defaultLabels[kind] ?? "工具调用"),
    observationBasis: "imported_log",
    certainty: event.kind === "observation" ? "approximate" : "exact",
    status: event.status ?? "unknown",
    content,
    parametersSummary: safeStringify(event.input),
    resultSummary: safeStringify(event.output),
    operatorNote: "",
    annotations: [],
    summaries: [],
    evidence: [],
    importedSource: { nativeEventIds: [event.id], nativeType: event.nativeType, timestamp: event.timestamp, callId: event.callId },
  };
}

function dedupe(events: CanonicalEvent[]) {
  const result: CanonicalEvent[] = [];
  for (const item of events.sort((a, b) => a.sequence - b.sequence)) {
    const previous = result.at(-1);
    const signature = `${item.kind}\0${item.name ?? ""}\0${item.text ?? ""}\0${safeStringify(item.input, 1000)}`;
    const previousSignature = previous ? `${previous.kind}\0${previous.name ?? ""}\0${previous.text ?? ""}\0${safeStringify(previous.input, 1000)}` : "";
    if (previous && signature === previousSignature) continue;
    result.push(item);
  }
  return result;
}

export function normalizeImportedRun(extracted: ExtractedAgentSession, caseId: string, inferredCaseId?: string) {
  const events = dedupe(extracted.events);
  const turns: Array<Record<string, unknown> & { steps: Step[]; prompt: string; response: string }> = [];
  let current: (typeof turns)[number] | undefined;
  const ensureTurn = () => {
    if (current) return current;
    current = {
      id: `turn_${turns.length + 1}`, order: turns.length + 1, prompt: "（源日志未保留用户 Prompt）", response: "",
      pathMatch: "not_evaluated", unexpectedPathSummary: "", steps: [], annotations: [], summaries: [],
    };
    turns.push(current);
    return current;
  };

  for (const item of events) {
    if (item.kind === "user_message") {
      current = {
        id: `turn_${turns.length + 1}`, order: turns.length + 1, prompt: safeStringify(item.text), response: "",
        pathMatch: "not_evaluated", unexpectedPathSummary: "", steps: [], annotations: [], summaries: [],
        completedAt: item.timestamp,
      };
      turns.push(current);
      continue;
    }
    const turn = ensureTurn();
    if (item.timestamp) turn.completedAt = item.timestamp;
    if (item.kind === "assistant_message") turn.response = [turn.response, safeStringify(item.text)].filter(Boolean).join("\n\n");
    if (item.kind === "tool_result" && item.callId) {
      const pending = [...turn.steps].reverse().find((step) => step.importedSource.callId === item.callId);
      if (pending) {
        pending.resultSummary = safeStringify(item.output ?? item.text);
        pending.status = item.status ?? pending.status;
        pending.importedSource.nativeEventIds.push(item.id);
        continue;
      }
    }
    const next = stepFor(item, turn.steps.length + 1);
    const previous = turn.steps.at(-1);
    if (["reasoning", "observation"].includes(next.kind) && previous?.kind === next.kind && previous.label === next.label) {
      previous.content = safeStringify([previous.content, next.content || next.resultSummary].filter(Boolean).join("\n\n"), 24_000);
      previous.importedSource.nativeEventIds.push(item.id);
    } else turn.steps.push(next);
  }

  for (const turn of turns) {
    turn.steps.forEach((step, index) => { step.id = `step_${index + 1}`; step.order = index + 1; });
  }
  const timestamps = events.map((item) => item.timestamp).filter((item): item is string => Boolean(item)).sort();
  const startedAt = extracted.session.startedAt ?? timestamps[0] ?? extracted.session.updatedAt ?? new Date().toISOString();
  const updatedAt = extracted.session.updatedAt ?? timestamps.at(-1) ?? startedAt;
  const resolvedCaseId = caseId === "auto" ? inferredCaseId || "unmapped_import" : caseId;
  const runId = stableId("run_import", extracted.session.adapterId, extracted.session.nativeSessionId);
  return {
    id: runId,
    agentId: extracted.session.agentId,
    caseId: resolvedCaseId,
    attempt: 1,
    status: "in_progress" as const,
    outcome: "not_evaluated" as const,
    model: extracted.model || "源日志未记录",
    permissionMode: "源日志导入",
    startedAt,
    updatedAt,
    turns,
    verdicts: [],
    annotations: extracted.warnings,
    summaries: [`自动导入 ${turns.length} 个 Turn、${turns.reduce((sum, turn) => sum + turn.steps.length, 0)} 个归并 Step。`],
    importProvenance: {
      adapterId: extracted.session.adapterId,
      appName: extracted.session.appName,
      nativeSessionId: extracted.session.nativeSessionId,
      sourceKind: extracted.session.sourceKind,
      sourcePath: extracted.session.sourcePath,
      completeness: extracted.session.completeness,
      importedAt: new Date().toISOString(),
      sourceFiles: extracted.sourceFiles,
      nativeEventCount: extracted.nativeEventCount,
      normalizedEventCount: events.length,
      warnings: extracted.warnings,
      cwd: extracted.cwd,
      caseMapping: { requested: caseId, resolved: resolvedCaseId, inferred: caseId === "auto" && Boolean(inferredCaseId) },
    },
  };
}

export function inferCaseId(prompt: string, cases: Array<{ id: string; turns?: Array<{ prompt?: string }> }>) {
  const normalize = (value: string) => value.toLocaleLowerCase("zh-CN").replace(/\s+/g, "").replace(/[，。！？、,.!?;；:'"“”‘’（）()]/g, "");
  const input = normalize(prompt);
  if (!input) return undefined;
  let best: { id: string; score: number } | undefined;
  for (const item of cases) {
    for (const turn of item.turns ?? []) {
      const candidate = normalize(turn.prompt ?? "");
      if (!candidate) continue;
      const score = input === candidate ? 1 : input.includes(candidate) || candidate.includes(input) ? Math.min(input.length, candidate.length) / Math.max(input.length, candidate.length) : 0;
      if (!best || score > best.score) best = { id: item.id, score };
    }
  }
  return best && best.score >= 0.55 ? best.id : undefined;
}
