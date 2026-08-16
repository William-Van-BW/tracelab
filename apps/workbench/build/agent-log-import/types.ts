export type ImportCompleteness = "full" | "partial" | "summary" | "unknown";

export type CanonicalEventKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "context_compaction"
  | "observation";

export type CanonicalEvent = {
  id: string;
  sequence: number;
  timestamp?: string;
  kind: CanonicalEventKind;
  role?: "user" | "assistant" | "system" | "tool";
  text?: string;
  name?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  status?: "success" | "blocked" | "failed" | "unknown";
  nativeType?: string;
};

export type DiscoveredAgentSession = {
  key: string;
  adapterId: string;
  agentId: string;
  appName: string;
  nativeSessionId: string;
  title: string;
  sourceKind: "jsonl" | "sqlite" | "export" | "memory_summary" | "diagnostic_log" | "agent_trace";
  sourcePath: string;
  startedAt?: string;
  updatedAt?: string;
  sizeBytes?: number;
  completeness: ImportCompleteness;
  warnings: string[];
  locator: Record<string, string>;
};

export type ExtractedAgentSession = {
  session: DiscoveredAgentSession;
  events: CanonicalEvent[];
  model?: string;
  cwd?: string;
  warnings: string[];
  sourceFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
  nativeEventCount: number;
};

export type AgentLogAdapter = {
  id: string;
  agentId: string;
  appName: string;
  discover(): Promise<DiscoveredAgentSession[]>;
  extract(session: DiscoveredAgentSession): Promise<ExtractedAgentSession>;
};

export type ImportDiscovery = {
  adapters: Array<{
    id: string;
    agentId: string;
    appName: string;
    sessionCount: number;
    status: "ready" | "fallback" | "not_found" | "error";
    message: string;
    /** How long this adapter's own scan took, so a slow source is identifiable. */
    durationMs: number;
  }>;
  sessions: DiscoveredAgentSession[];
  discoveredAt: string;
  /** True when served from the in-process cache rather than a fresh disk scan. */
  cached: boolean;
  /** Set when a background rescan is running; the next open will be newer. */
  refreshing?: boolean;
};
