export type RecordKind = "agent" | "case" | "run" | "snapshot";

export type StoredRecord<T = unknown> = {
  id: string;
  kind: RecordKind;
  name: string;
  payload: T;
  createdAt: string;
  updatedAt: string;
};

export type RunStage = "iteration" | "benchmark";

export type AgentProfile = {
  id: string;
  name: string;
  vendor: string;
  region: "global" | "china";
  accessMode: "desktop_ui" | "web_ui";
  sourceAvailability: "closed";
  defaultModel: string;
  /** Default permission-mode text applied when this Agent is selected for a new/edited Run. */
  defaultPermissionMode?: string;
  /** Overrides defaultPermissionMode when the Run's runStage is set (e.g. WorkBuddy differs between 迭代 and 测试). */
  defaultPermissionModeByStage?: Partial<Record<RunStage, string>>;
  accent: string;
  notes: string;
};

/** 一个安全风险小类的展示元数据（目录 slug 之外的部分，可在概览页编辑）。 */
export type CatalogRisk = {
  slug: string;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  /** 该小类下 Case 全局 ID 的前缀，例如 OA / UFM / SDMF。 */
  idPrefix: string;
  order: number;
};

/** 一个安全体系大类。slug 是目录名，改分类要走 Case 移动而不是改这里。 */
export type CatalogSystem = {
  slug: string;
  suiteId: string;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  order: number;
  risks: CatalogRisk[];
};

export type MonitoredRoot = {
  rootId: string;
  label: string;
  pathTemplate: string;
  role: "workspace" | "external_sensitive" | "external_control" | "downloads" | "other";
  required: boolean;
  contentPolicy: "changed_files" | "hash_only" | "metadata_only" | "full";
};

export type CaptureRoot = {
  id: string;
  rootId?: string;
  label: string;
  path: string;
  enabled: boolean;
  role?: MonitoredRoot["role"];
  contentPolicy: MonitoredRoot["contentPolicy"];
  source: "case_deployment" | "custom";
};

export type ScreenshotTarget = {
  type: "desktop" | "monitor" | "window";
  id: string;
  label: string;
};

export type CaseAssertion = {
  id: string;
  statement: string;
  severity: "low" | "medium" | "high" | "critical";
  method: "human" | "rule" | "llm" | "hybrid";
};

export type CaseLandmine = {
  id: string;
  title: string;
  description: string;
  locations: string[];
  severity: "low" | "medium" | "high" | "critical";
};

export type CaseTurn = {
  id: string;
  title: string;
  prompt: string;
  operatorInstruction?: string;
  assertions: CaseAssertion[];
  landmines?: CaseLandmine[];
  allowUnexpectedSteps: boolean;
  unexpectedPathPolicy: "record_and_evaluate" | "manual_review" | "fail" | "ignore";
};

/**
 * 审计速读 (audit read-out) — exactly the five fields the workbench renders.
 * `directoryTree` and `promptBoundary` are DERIVED at sync time (from the Case's
 * fixtures and from the Turn's verbatim prompt) and are never stored in
 * case.json, so they cannot drift from what is actually deployed and sent.
 */
export type CaseReadme = {
  /** 核心原理 — how the boundary violation is induced. */
  corePrinciple: string;
  /** 目录结构 — Windows `tree /f`-style listing derived from the fixtures. Read-only. */
  directoryTree: string;
  /** 目录结构备注 — operator notes accompanying the listing. */
  directoryNotes: string;
  /** User Prompt — the verbatim text sent to the Agent; mirrors turns[0].prompt. */
  promptBoundary: string;
  /** 关键文件及 payload — which file carries the lure, quoted. */
  keyFiles: string;
  /** 预期正确路径 — what the Agent must do to pass. */
  safePath: string;
  contentMap: Array<{
    path: string;
    kind: "prompt" | "file" | "directory" | "website" | "tool" | "other";
    summary: string;
    role: "task_context" | "inducement" | "safety_policy" | "protected_asset" | "evidence" | "supporting";
    risk?: string;
    content?: string;
    mediaType?: string;
    /** Derived portal snapshots are previewable but are not version-local fixture files. */
    readOnly?: boolean;
  }>;
};

export type CaseReviewSignal = {
  id: string;
  label: string;
  kind: "canary" | "protected_path" | "sensitive_root";
  severity: "medium" | "high" | "critical";
  patterns: string[];
  explanation: string;
};

export type TestCase = {
  id: string;
  version: string;
  /** 中文名，按“威胁原理”命名（例如“相对路径越权”），不按业务场景。 */
  title: string;
  /** 英文名，与中文名一一对应（例如 "Relative Path Traversal"）。 */
  titleEn?: string;
  /** 全局唯一、可手工编辑的短 ID，形如 OA-1 / UFM-3；同一 Case 的所有版本共享。 */
  globalId?: string;
  description: string;
  readme: CaseReadme;
  /** Primary, safety-oriented subdivision used for navigation and reporting. */
  riskCategory: string;
  roots: MonitoredRoot[];
  turns: CaseTurn[];
  reviewSignals?: CaseReviewSignal[];
  deletedAt?: string;
  updatedAt: string;
  source?: {
    kind: "case-library";
    mappingVersion?: string;
    suiteId: string;
    suiteLabel: string;
    suiteLabelEn?: string;
    /** Stable filesystem slug for the top-level safety system category. */
    systemCategory?: string;
    systemOrder?: number;
    /** Stable filesystem slug for the risk subdivision. */
    riskCategorySlug?: string;
    riskCategoryEn?: string;
    riskOrder?: number;
    /** Global-ID prefix the risk category declares (OA / UFM / SDMF). */
    globalIdPrefix?: string;
    /** Stable directory number, for example case-001. */
    caseNumber?: string;
    relativePath: string;
    fingerprint: string;
    familyId?: string;
    rawVersion?: string;
    parentVersion?: string;
    parentRelativePath?: string;
    changeType?: "major" | "minor" | "patch";
    changeSummary?: string;
    caseOrder?: number;
    lifecycle?: "working" | "candidate" | "accepted" | "archived";
    preferred?: boolean;
    createdAt?: string;
    mergedFromVersion?: string;
    isBaseline?: boolean;
    mutable?: boolean;
    initializeEntrypoint?: string;
    destroyEntrypoint?: string;
  };
};

export const BUILTIN_STEP_KINDS = [
  "reasoning",
  "tool_or_action",
  "command_execution",
  "skill_load",
  "skill_call",
  "mcp_discovery",
  "web_search",
  "browser_action",
  "context_compaction",
  "approval",
  "file_operation",
  "observation",
  "evidence_collection",
  "assistant_response",
  "custom",
] as const;

export type StepKind = (typeof BUILTIN_STEP_KINDS)[number] | string;
export type EvidenceRef = {
  id: string;
  role: "screenshot" | "file_snapshot" | "diff" | "log" | "other";
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  description?: string;
  url?: string;
};

export type RunStep = {
  id: string;
  order: number;
  kind: StepKind;
  kindSource: "builtin" | "operator_custom";
  customKindLabel?: string;
  label: string;
  observationBasis: "native_protocol" | "agent_ui" | "system_ui" | "operator_inference" | "imported_log" | "unknown";
  certainty: "exact" | "approximate" | "inferred" | "unknown";
  status: "success" | "blocked" | "failed" | "unknown";
  content: string;
  parametersSummary: string;
  resultSummary: string;
  operatorNote: string;
  annotations: string[];
  summaries: string[];
  evidence: EvidenceRef[];
  dangerMark?: "none" | "weak_danger" | "danger";
  reviewNote?: string;
  importedSource?: {
    nativeEventIds: string[];
    nativeType?: string;
    timestamp?: string;
    callId?: string;
  };
  evidenceCapture?: {
    type: "directory_snapshot" | "screenshot" | "upload";
    capturedAt: string;
    phase: "baseline" | "during" | "after" | "manual";
    rootIds?: string[];
    target?: ScreenshotTarget;
  };
};

export type RunTurn = {
  id: string;
  order: number;
  caseTurnId?: string;
  prompt: string;
  response: string;
  durationSeconds?: number;
  pathMatch: "matched" | "partial" | "unmatched" | "not_evaluated";
  selectedPathId?: string;
  unexpectedPathSummary: string;
  steps: RunStep[];
  annotations: string[];
  summaries: string[];
  completedAt?: string;
  dangerMark?: "none" | "weak_danger" | "danger";
  reviewNote?: string;
};

export type Verdict = {
  assertionId: string;
  statement: string;
  outcome: "pass" | "fail" | "warning" | "inconclusive";
  rationale: string;
};

export type TestRun = {
  id: string;
  name?: string;
  nameMode?: "auto" | "custom";
  agentId: string;
  caseId: string;
  attempt: number;
  status: "draft" | "in_progress" | "completed";
  outcome: "pass" | "fail" | "warning" | "inconclusive" | "not_evaluated";
  model: string;
  permissionMode: string;
  /** Distinguishes exploratory Workbuddy-only iteration Runs from finalized cross-Agent benchmark Runs. Unset on Runs created before this field existed. */
  runStage?: RunStage;
  startedAt: string;
  updatedAt: string;
  turns: RunTurn[];
  verdicts: Verdict[];
  annotations: string[];
  summaries: string[];
  riskScore?: number;
  trajectoryJudgement?: "reasonable" | "partially_reasonable" | "unreasonable" | "not_reviewed";
  reviewLog?: string;
  deletedAt?: string;
  purgeAt?: string;
  /**
   * Where this Run lives on disk. Derived from the directory it was read from,
   * never persisted, so archiving a Run folder and restoring it elsewhere always
   * reports the current location.
   */
  storage?: {
    directory: string;
    runJsonPath: string;
    evidenceDirectory: string;
    snapshotDirectory: string;
    updatedOnDisk: string;
  };
  fixtureDeployment?: {
    deploymentId: string;
    deploymentPath: string;
    workspacePath?: string;
    evidencePath?: string;
    captureRoots?: CaptureRoot[];
    initializedAt: string;
    destroyedAt?: string;
    /**
     * The Case this deployment was created for. The Run's `caseId` can be
     * changed afterwards via CasePicker without redeploying — when it no
     * longer matches, the deployment's paths belong to a different Case and
     * must not be treated as this Run's current working directory.
     */
    caseId?: string;
    /**
     * 部署时写进 fixture 的内网门户地址。门户是独立进程，重启后端口可能变，
     * 记下这一份就能发现"工作目录里的地址已经指不到现在的门户了"。
     */
    intranetBaseUrl?: string;
  };
  captureConfig?: {
    roots: CaptureRoot[];
    screenshotTarget?: ScreenshotTarget;
  };
  importProvenance?: {
    adapterId: string;
    appName: string;
    nativeSessionId: string;
    sourceKind: "jsonl" | "sqlite" | "export" | "memory_summary" | "diagnostic_log" | "agent_trace";
    sourcePath: string;
    completeness: "full" | "partial" | "summary" | "unknown";
    importedAt: string;
    sourceFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
    nativeEventCount: number;
    normalizedEventCount: number;
    warnings: string[];
    cwd?: string;
    caseMapping: { requested: string; resolved: string; inferred: boolean };
  };
};

export type FileSnapshot = {
  id: string;
  runId: string;
  turnId?: string;
  stepId?: string;
  rootName: string;
  rootId?: string;
  rootPath?: string;
  contentPolicy?: MonitoredRoot["contentPolicy"];
  capturedAt: string;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  previousSnapshotId?: string;
  changes?: Array<{
    operation: "create" | "modify" | "delete";
    path: string;
    beforeSha256?: string;
    afterSha256?: string;
    beforeSizeBytes?: number;
    afterSizeBytes?: number;
  }>;
  entries: Array<{
    path: string;
    kind: "file" | "directory";
    sizeBytes?: number;
    sha256?: string;
    lastModified?: number;
  }>;
};
