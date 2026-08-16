"use client";

import {
  Activity,
  Archive,
  Bot,
  Camera,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  Code2,
  Database,
  Download,
  Copy,
  FileClock,
  FileJson,
  FileSearch,
  FolderGit2,
  FolderPlus,
  Globe2,
  HardDrive,
  GripVertical,
  ImagePlus,
  LayoutDashboard,
  ListPlus,
  Loader2,
  Menu,
  Plus,
  Save,
  Search,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { CASE_LIBRARY_CASES, CASE_LIBRARY_CATALOG, CASE_LIBRARY_SUMMARY, DEFAULT_AGENTS, DEFAULT_CASES, STEP_KIND_LABELS } from "../../lib/defaults";
import { diffSnapshots } from "../../lib/file-snapshot";
import { openRunSync, readScoped, TAB_ID, writeScoped, type RunSyncMessage, type StorageScope } from "../../lib/tab-session";
import { downloadJson, newRunId, nextSequentialId } from "../../lib/ids";
import type {
  AgentProfile,
  CaptureRoot,
  CatalogRisk,
  CatalogSystem,
  EvidenceRef,
  FileSnapshot,
  RunStage,
  RunStep,
  RunTurn,
  ScreenshotTarget,
  StoredRecord,
  TestCase,
  TestRun,
} from "../../lib/types";

type View = "dashboard" | "cases" | "entry" | "review" | "results";
type Toast = { tone: "success" | "error" | "info"; text: string } | null;
type FontScale = "standard" | "comfortable" | "large";
type WorkbenchConfigState = {
  schemaVersion: string;
  caseLibraryPath: string;
  workingRoot: string;
  runsRoot?: string;
  resolvedCaseLibraryPath?: string;
  resolvedWorkingRoot?: string;
  resolvedRunsRoot?: string;
  configPath?: string;
};
type AgentLogSession = {
  key: string; adapterId: string; agentId: string; appName: string; nativeSessionId: string; title: string;
  sourceKind: "jsonl" | "sqlite" | "export" | "memory_summary" | "diagnostic_log" | "agent_trace"; sourcePath: string;
  startedAt?: string; updatedAt?: string; sizeBytes?: number; completeness: "full" | "partial" | "summary" | "unknown"; warnings: string[];
};
type AgentLogDiscovery = {
  adapters: Array<{ id: string; agentId: string; appName: string; sessionCount: number; status: "ready" | "fallback" | "not_found" | "error"; message: string; durationMs: number }>;
  sessions: AgentLogSession[];
  discoveredAt: string;
  cached: boolean;
  refreshing?: boolean;
};
/** One reversible action. `restore` puts the workbench back the way it was. */
type UndoEntry = { id: string; label: string; at: string; restore: () => void | Promise<void> };
const UNDO_STACK_LIMIT = 25;

type CaseTrashEntry = {
  id: string;
  /**
   * "custom" entries are hand-made Cases that never had a Case Library directory;
   * they are soft-deleted in the record store instead of moved on disk, but they
   * share the same 垃圾箱 so there is only one place to restore anything from.
   */
  storageKind?: "library" | "custom";
  scope: "family" | "version";
  deletedAt: string;
  familyId: string;
  title: string;
  version?: string;
  caseNumber?: string;
  systemCategory?: string;
  riskCategorySlug?: string;
  originalRelativePath: string;
  sourceCaseId: string;
  runCount: number;
  affectedVersions: number;
  wasPreferred: boolean;
};

async function responseError(response: Response) {
  try { return String((await response.json() as { error?: string }).error || response.statusText); }
  catch { return response.statusText || "请求失败"; }
}

async function apiRecords() {
  const response = await fetch("/api/records", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取数据");
  return (await response.json()) as { records: StoredRecord[] };
}

async function apiCaseTrash() {
  const response = await fetch("/api/local/cases/trash", { cache: "no-store" });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json() as { entries: CaseTrashEntry[] }).entries;
}

type RawCatalogRisk = string | { label?: string; labelEn?: string; description?: string; descriptionEn?: string; idPrefix?: string; order?: number };
type RawCatalog = { systems?: Record<string, { suiteId?: string; label?: string; labelEn?: string; description?: string; descriptionEn?: string; order?: number; risks?: Record<string, RawCatalogRisk> }> };

/** Read catalog.json live, in the same normalized shape the build index carries. */
async function apiCatalog(): Promise<CatalogSystem[]> {
  const response = await fetch("/api/local/catalog", { cache: "no-store" });
  if (!response.ok) throw new Error(await responseError(response));
  const raw = await response.json() as RawCatalog;
  return Object.entries(raw.systems ?? {}).map(([slug, system]) => ({
    slug,
    suiteId: system.suiteId ?? slug,
    label: system.label ?? slug,
    labelEn: system.labelEn ?? "",
    description: system.description ?? "",
    descriptionEn: system.descriptionEn ?? "",
    order: system.order ?? 9999,
    risks: Object.entries(system.risks ?? {}).map(([riskSlug, risk], index) => (typeof risk === "string"
      ? { slug: riskSlug, label: risk, labelEn: "", description: "", descriptionEn: "", idPrefix: "", order: index + 1 }
      : { slug: riskSlug, label: risk.label ?? riskSlug, labelEn: risk.labelEn ?? "", description: risk.description ?? "", descriptionEn: risk.descriptionEn ?? "", idPrefix: risk.idPrefix ?? "", order: risk.order ?? index + 1 })),
  })).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug, "en"));
}

/**
 * Live status of ONE Case's mock intranet portal.
 *
 * 每个 Case 一个门户：站点由公共材料加该 Case 自己的诱导页叠成，端口各自独立，所以
 * 同时测多个 Case 不会互相看见对方的页面。同一个 Case 的多个 Run 共用一个门户——
 * 站点是只读的，每个 Run 看到的内容逐字节相同。
 *
 * `baseUrl` is the address written into the fixtures and the Prompt — a private
 * LAN address whenever the machine has one, so the local Agent stays on the local
 * link. `allUrls` follows the same configured 10.x address policy. `proxyRisk`
 * is set when the machine's
 * proxy environment would hijack that address before the Agent ever reaches it.
 */
type IntranetProxyRisk = { host: string; sources: string[] };
type IntranetStatus = {
  running: boolean; baseUrl?: string; allUrls?: string[]; port: number; startedAt?: string;
  caseFamilyId?: string; proxyRisk?: IntranetProxyRisk;
};

// No portal is running yet, so there is no address to show. The server resolves
// the real one (config.json, or the machine's first private IPv4) when it starts.
const IDLE_INTRANET: IntranetStatus = { running: false, port: 8760 };

async function apiIntranetStatus(caseId: string): Promise<IntranetStatus> {
  if (!caseId) return IDLE_INTRANET;
  const response = await fetch(`/api/local/intranet?caseId=${encodeURIComponent(caseId)}`, { cache: "no-store" });
  if (!response.ok) return IDLE_INTRANET;
  return await response.json() as IntranetStatus;
}

/**
 * Cases whose lure lives on the intranet keep `${INTRANET_BASE_URL}` and
 * `${INTRANET_HOST}` in their Prompt. The deployer substitutes them inside the
 * deployed files; the workbench substitutes them here so the text the operator
 * copies matches what the Agent will actually be able to reach. Nothing is
 * written back to case.json.
 *
 * With no portal running there is nothing to substitute — leaving the token
 * visible is honest, and beats inventing an address the Agent cannot reach.
 */
function withIntranetBaseUrl(text: string, intranet: IntranetStatus) {
  if (!intranet.baseUrl) return text;
  let host = "";
  try { host = new URL(intranet.baseUrl).hostname; } catch { host = ""; }
  const replaced = text.replaceAll("${INTRANET_BASE_URL}", intranet.baseUrl);
  return host ? replaced.replaceAll("${INTRANET_HOST}", host) : replaced;
}

/**
 * Cases whose Prompt names a deployed root (e.g. `${EXTERNAL_CONTROL_NATIVE}`)
 * keep that placeholder in case.json — Deploy-Case.ps1 substitutes it inside
 * the deployed fixture files, but the Prompt text itself lives in the Case
 * record, not on disk. The workbench mirrors the same substitution here from
 * the root paths "一键创建工作目录" already resolved, so the text the operator
 * copies matches the real U 盘 / workspace path instead of a bare token.
 */
function withRootNativePaths(text: string, roots: CaptureRoot[]) {
  let result = text;
  for (const root of roots) {
    if (!root.path || !root.rootId) continue;
    const key = root.rootId.toUpperCase();
    result = result.replaceAll('${' + key + '_NATIVE}', root.path);
    result = result.replaceAll('${' + key + '_NATIVE_JSON}', root.path.replaceAll("\\", "\\\\"));
  }
  return result;
}

/**
 * CasePicker lets an operator swap a Run's Case without redeploying. When
 * that happens, `fixtureDeployment.captureRoots` still points at the OLD
 * Case's directories — substituting from it would silently print a stranger
 * Case's path into this Prompt (or worse, the same stale path across several
 * Cases that all got their token left unsubstituted before this field
 * existed). Deployments made before this field shipped have no `caseId`
 * recorded; treat those as still matching rather than losing substitution
 * for every already-deployed Run.
 */
function deploymentRootsForCase(run: TestRun): CaptureRoot[] {
  const deployment = run.fixtureDeployment;
  if (!deployment || (deployment.caseId && deployment.caseId !== run.caseId)) return [];
  return deployment.captureRoots ?? [];
}

function needsIntranet(item: TestCase | undefined) {
  if (!item) return false;
  return [effectiveCasePrompt(item), item.readme?.keyFiles ?? "", item.readme?.directoryNotes ?? ""].some((text) => text.includes("${INTRANET_BASE_URL}"));
}

async function putRecord<T>(kind: StoredRecord<T>["kind"], id: string, name: string, payload: T, createdAt?: string) {
  const response = await fetch("/api/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, kind, name, payload, createdAt, updatedAt: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error("保存失败");
}

/* --------------------------------------------------------------------------
 * Run storage — one directory per Run on the local filesystem
 *
 * Runs are AETF JSON files under <runsRoot>/<runId>/run.json, together with the
 * Run's directory snapshots and evidence. Moving a Run directory away hides it
 * from the workbench; moving it back and rescanning brings it (and its evidence)
 * back exactly as it was. Agents and Cases still live in the local record store.
 * -------------------------------------------------------------------------- */

type RunScan = { runs: TestRun[]; skipped: string[]; runsRoot: string };

async function apiScanRuns(): Promise<RunScan> {
  const response = await fetch("/api/local/runs", { cache: "no-store" });
  if (!response.ok) throw new Error(await responseError(response));
  const scan = await response.json() as RunScan;
  for (const run of scan.runs) {
    if (run.storage?.updatedOnDisk) runVersions.set(run.id, run.storage.updatedOnDisk);
  }
  return scan;
}

/** Thrown when another tab wrote this Run after we loaded our copy. */
class RunConflictError extends Error {
  readonly runId: string;
  constructor(runId: string, message: string) {
    super(message);
    this.name = "RunConflictError";
    this.runId = runId;
  }
}

/**
 * The newest run.json mtime this tab knows for each Run, updated on every load
 * and every successful write.
 *
 * Reading it from `run.storage` instead does not work: a long operation such as
 * deploying a fixture captures the Run first and saves it seconds later, by
 * which time the autosave has written the file and moved the mtime on. The
 * captured copy would then carry an mtime from before our own write and look
 * like a conflict.
 */
const runVersions = new Map<string, string>();

/** In-flight write per Run, so two saves for the same Run never interleave. */
const runWriteQueue = new Map<string, Promise<unknown>>();

async function postRun(run: TestRun) {
  const response = await fetch("/api/local/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run,
      expectedUpdatedOnDisk: runVersions.get(run.id) ?? run.storage?.updatedOnDisk ?? null,
      writerTabId: TAB_ID,
    }),
  });
  if (response.status === 409) throw new RunConflictError(run.id, await responseError(response));
  if (!response.ok) throw new Error(await responseError(response));
  const storage = (await response.json() as { storage: NonNullable<TestRun["storage"]> }).storage;
  if (storage?.updatedOnDisk) runVersions.set(run.id, storage.updatedOnDisk);
  return storage;
}

/**
 * Write a Run, serialized per Run id. Chaining rather than firing in parallel is
 * what keeps `runVersions` truthful — two concurrent POSTs would both send the
 * same "expected" mtime and the second would look stale even though both came
 * from this tab.
 */
async function apiWriteRun(run: TestRun) {
  const previous = runWriteQueue.get(run.id) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => postRun(run));
  runWriteQueue.set(run.id, task);
  try {
    return await task;
  } finally {
    if (runWriteQueue.get(run.id) === task) runWriteQueue.delete(run.id);
  }
}

/** Re-read one Run from disk — used to recover after a write conflict. */
async function apiReadRun(runId: string): Promise<TestRun | undefined> {
  const response = await fetch(`/api/local/runs/read?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (!response.ok) return undefined;
  const run = (await response.json() as { run: TestRun }).run;
  if (run?.storage?.updatedOnDisk) runVersions.set(run.id, run.storage.updatedOnDisk);
  return run;
}

async function apiDeleteRunDirectory(runId: string) {
  const response = await fetch("/api/local/runs/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, confirmation: `PERMANENT ${runId}` }) });
  if (!response.ok) throw new Error(await responseError(response));
}

async function apiRunSnapshots(runId: string): Promise<FileSnapshot[]> {
  const response = await fetch(`/api/local/runs/snapshots?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (!response.ok) return [];
  return (await response.json() as { snapshots: FileSnapshot[] }).snapshots;
}

async function apiSaveRunSnapshots(runId: string, snapshots: FileSnapshot[]) {
  const response = await fetch("/api/local/runs/snapshots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, snapshots }) });
  if (!response.ok) throw new Error(await responseError(response));
}

function toBase64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked so a multi-megabyte screenshot cannot blow the argument limit.
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Store an evidence file inside the Run's own directory and return its ref. */
async function apiSaveRunEvidence(runId: string, file: File, role: EvidenceRef["role"]): Promise<EvidenceRef> {
  const response = await fetch("/api/local/runs/evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, fileName: file.name, mediaType: file.type || "application/octet-stream", role, base64: toBase64(await file.arrayBuffer()) }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json() as { artifact: EvidenceRef }).artifact;
}

const LEGACY_RUN_MIGRATION_KEY = "aetf:runs-migrated-to-files";

/**
 * One-time lift of Runs (and their directory snapshots) out of the old D1 record
 * store into per-Run directories. The D1 rows are left untouched as a fallback,
 * and the marker below stops this from re-importing Runs the operator has since
 * archived on purpose.
 */
async function migrateLegacyRuns(existingIds: Set<string>) {
  if (readStored(LEGACY_RUN_MIGRATION_KEY) === "done") return 0;
  const { records } = await apiRecords();
  const legacyRuns = records.filter((record) => record.kind === "run").map((record) => record.payload as TestRun).filter((run) => run?.id && !existingIds.has(run.id));
  if (legacyRuns.length) {
    const response = await fetch("/api/local/runs/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: legacyRuns }) });
    if (!response.ok) throw new Error(await responseError(response));
    const byRun = new Map<string, FileSnapshot[]>();
    for (const record of records) {
      if (record.kind !== "snapshot") continue;
      const snapshot = record.payload as FileSnapshot;
      if (!snapshot?.runId) continue;
      byRun.set(snapshot.runId, [...(byRun.get(snapshot.runId) ?? []), snapshot]);
    }
    await Promise.all([...byRun.entries()].map(([runId, snapshots]) => apiSaveRunSnapshots(runId, snapshots).catch(() => undefined)));
  }
  writeStored(LEGACY_RUN_MIGRATION_KEY, "done");
  return legacyRuns.length;
}

/**
 * Copy text to the clipboard with a legacy fallback. The Async Clipboard API is
 * only available in secure contexts (HTTPS or localhost); when TraceLab is opened
 * over plain HTTP on a LAN IP (common on Mac Safari/Chrome), `navigator.clipboard`
 * is undefined, so we fall back to a hidden textarea + execCommand("copy").
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy execCommand path */ }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Tiny localStorage helpers. This workbench is single-user on a LAN, so per-tab
 * UI state (active view, selected Case/Run, list filters) is persisted verbatim
 * and restored after tab switches and page reloads. All reads are guarded so SSR
 * and privacy-mode failures degrade to the in-memory default.
 */
function readStored(key: string, scope: StorageScope = "device"): string | null {
  return readScoped(key, scope);
}
function writeStored(key: string, value: string, scope: StorageScope = "device") {
  writeScoped(key, value, scope);
}

/**
 * Client-only persistent state for sub-panels that unmount when a tab loses
 * focus. Safe because these components only ever mount after the loading gate
 * clears (never during SSR), so a lazy read of storage cannot desync hydration.
 * Values are JSON-encoded.
 *
 * Pass scope "tab" for anything that describes what THIS window is looking at
 * (selection, filters, search boxes). Those must not be shared, or opening a
 * second tab to record another Agent drags the first one along with it.
 */
function usePersistentState<T>(key: string, fallback: T, scope: StorageScope = "device") {
  const [value, setValue] = useState<T>(() => {
    const stored = readStored(key, scope);
    if (stored === null) return fallback;
    try { return JSON.parse(stored) as T; } catch { return fallback; }
  });
  useEffect(() => { writeStored(key, JSON.stringify(value), scope); }, [key, value, scope]);
  return [value, setValue] as const;
}

function blankStep(id: string, order: number, kind = "tool_or_action"): RunStep {
  return {
    id,
    order,
    kind,
    kindSource: kind === "custom" ? "operator_custom" : "builtin",
    customKindLabel: "",
    label: STEP_KIND_LABELS[kind] ?? kind,
    observationBasis: "agent_ui",
    certainty: "approximate",
    status: "unknown",
    content: "",
    parametersSummary: "",
    resultSummary: "",
    operatorNote: "",
    annotations: [],
    summaries: [],
    evidence: [],
    dangerMark: "none",
    reviewNote: "",
  };
}

function formatRunTimestamp(iso: string) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function buildRunName(agentName: string, caseTitle: string, startedAt: string) {
  return `${agentName} · ${caseTitle} · ${formatRunTimestamp(startedAt)}`;
}

/**
 * The display name of an auto-named Run is recomputed from the current Agent and
 * Case rather than read back from disk. The stored string was generated once at
 * creation, so renaming a Case used to leave every existing Run advertising the
 * old title — a name that looks authored but is really a stale derivation. Runs
 * the operator named by hand (`nameMode: "custom"`) are never recomputed.
 */
function runDisplayName(run: TestRun, agents: AgentProfile[], cases: TestCase[]) {
  if (run.nameMode === "custom") return run.name || run.id;
  const agent = agents.find((item) => item.id === run.agentId);
  const caseItem = cases.find((item) => item.id === run.caseId);
  if (!agent && !caseItem) return run.name || run.id;
  return buildRunName(agent?.name ?? "Agent", caseItem?.title ?? "Case", run.startedAt);
}

/** WorkBuddy's permission default depends on 迭代/测试; other Agents fall back to a single defaultPermissionMode (if any). */
function resolvePermissionDefault(agent: AgentProfile | undefined, stage: RunStage | undefined, fallback: string) {
  return (stage && agent?.defaultPermissionModeByStage?.[stage]) ?? agent?.defaultPermissionMode ?? fallback;
}

const RUN_STAGE_LABELS: Record<RunStage, string> = { iteration: "迭代", benchmark: "测试" };

/**
 * Case 库定版后，日常录入的是拉多个 Agent 横向跑同一个 Case 的正式测评，不再是
 * 单人打磨 Case 的探索性 Run。所以新 Run 默认落在“测试”，权限模式也跟着按测试
 * 档取 Agent 的默认值；要录迭代 Run 仍可在 run-config-bar 里改回来。
 */
const DEFAULT_RUN_STAGE: RunStage = "benchmark";

function blankRun(agent: AgentProfile, caseItem: TestCase, runs: TestRun[]): TestRun {
  const now = new Date().toISOString();
  const attempt = runs.filter((run) => run.agentId === agent.id && run.caseId === caseItem.id).length + 1;
  return {
    id: newRunId(),
    name: buildRunName(agent.name, caseItem.title, now),
    nameMode: "auto",
    agentId: agent.id,
    caseId: caseItem.id,
    attempt,
    status: "in_progress",
    outcome: "not_evaluated",
    model: "界面显示为准",
    permissionMode: resolvePermissionDefault(agent, DEFAULT_RUN_STAGE, "自动审批 / 完全自主"),
    runStage: DEFAULT_RUN_STAGE,
    startedAt: now,
    updatedAt: now,
    turns: [],
    verdicts: [],
    annotations: [],
    summaries: [],
    riskScore: 0,
    trajectoryJudgement: "not_reviewed",
    reviewLog: "",
  };
}

function blankCaseReadme() {
  return {
    corePrinciple: "",
    directoryTree: "",
    directoryNotes: "",
    keyFiles: "",
    overview: "",
    designLogic: "",
    promptBoundary: "",
    inducement: "",
    riskPath: "",
    safePath: "",
    promptNotes: [],
    contentMap: [],
  };
}

/**
 * The "Prompt 如何限制 / 引导" (readme.promptBoundary) and the verbatim turn prompt
 * are the same thing. Older edits went only to promptBoundary, leaving the turn
 * prompt — the text that seeds a new Run — stale. Every Case is single-turn, so
 * treat a non-empty promptBoundary as the authoritative prompt and reconcile it
 * back into turn[0] wherever it drifted. Pure and idempotent.
 */
function effectiveCasePrompt(item: TestCase): string {
  const boundary = item.readme?.promptBoundary?.trim();
  if (item.turns.length === 1 && boundary) return boundary;
  return item.turns[0]?.prompt ?? "";
}
function reconcileCasePrompt(item: TestCase): TestCase {
  const boundary = item.readme?.promptBoundary?.trim();
  if (item.turns.length === 1 && boundary && (item.turns[0].prompt ?? "").trim() !== boundary) {
    return { ...item, turns: [{ ...item.turns[0], prompt: boundary }] };
  }
  return item;
}

function caseGroup(item: TestCase) {
  return item.source?.suiteLabel ?? "自建 Case";
}

function caseRiskCategory(item: TestCase) {
  return item.riskCategory || "未分类安全风险";
}

/** Stable identity of the Case a version belongs to. */
function caseFamilyKey(item: TestCase) {
  return item.source?.familyId ?? item.id;
}

/** Counts Cases, not versions — a Case with four Forks still counts as one. */
function caseFamilyCount(items: TestCase[]) {
  return new Set(items.map(caseFamilyKey)).size;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * 手工判定只保留一个总体结论。三个档位复用 Run 已有的 outcome 取值，所以历史
 * Run、筛选器和存盘格式都不用动，只是每一档在界面上说的是“Agent 做了什么”，
 * 而不是抽象的通过 / 失败。`inconclusive` 不再作为可选项，仅为兼容旧数据保留。
 */
const OUTCOME_CHOICES: Array<{ value: TestRun["outcome"]; label: string }> = [
  { value: "not_evaluated", label: "未判定" },
  { value: "pass", label: "Agent 无危险操作" },
  { value: "warning", label: "Agent 有一定程度危险操作" },
  { value: "fail", label: "Agent 有危险操作" },
];

function outcomeLabel(outcome: TestRun["outcome"]) {
  return { pass: "无危险操作", fail: "有危险操作", warning: "一定程度危险", inconclusive: "证据不足", not_evaluated: "未判定" }[outcome];
}

/**
 * Flatten a Case family's versions into a depth-annotated tree by parentVersion,
 * so non-linear forks (two branches off the same parent, e.g. a prompt branch and
 * a file branch) render as siblings rather than a misleading linear chain.
 */
function lineageRows(versions: TestCase[]) {
  const byVersion = new Map(versions.map((item) => [item.version, item]));
  const children = new Map<string, TestCase[]>();
  const roots: TestCase[] = [];
  for (const item of versions) {
    const parent = item.source?.parentVersion;
    if (parent && byVersion.has(parent) && byVersion.get(parent) !== item) children.set(parent, [...(children.get(parent) ?? []), item]);
    else roots.push(item);
  }
  const rows: Array<{ item: TestCase; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (item: TestCase, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    rows.push({ item, depth });
    (children.get(item.version) ?? []).sort((a, b) => compareVersions(a.version, b.version)).forEach((child) => walk(child, depth + 1));
  };
  roots.sort((a, b) => compareVersions(a.version, b.version)).forEach((root) => walk(root, 0));
  // Any versions whose parent is missing still get shown at the root level.
  versions.forEach((item) => { if (!seen.has(item.id)) rows.push({ item, depth: 0 }); });
  return rows;
}

export function TraceWorkbench() {
  const [view, setView] = useState<View>("dashboard");
  const [agents, setAgents] = useState<AgentProfile[]>(DEFAULT_AGENTS);
  const [cases, setCases] = useState<TestCase[]>(DEFAULT_CASES);
  const [runs, setRuns] = useState<TestRun[]>([]);
  /**
   * Content fingerprint of each Run as it currently exists on disk. `updatedAt`
   * and `storage` are excluded because both are stamped by the save itself, so
   * a Run that came straight off disk compares equal to its own file and the
   * autosave below skips it. Without this every tab rewrote its selected Run on
   * load — identical bytes, fresh mtime — which churned the last-writer record
   * and made the cross-tab conflict guard fire on edits nobody had made.
   */
  const runSignature = (run: TestRun) => JSON.stringify({ ...run, updatedAt: undefined, storage: undefined });
  const savedSignatures = useRef(new Map<string, string>());
  const rememberSaved = (run: TestRun) => savedSignatures.current.set(run.id, runSignature(run));
  const [runsRoot, setRunsRoot] = useState("");
  // Directories under the Runs root that don't hold a readable run.json — usually
  // a half-restored archive. Surfacing them beats silently ignoring them.
  const [unreadableRunDirs, setUnreadableRunDirs] = useState<string[]>([]);
  const [caseTrash, setCaseTrash] = useState<CaseTrashEntry[]>([]);
  /** Soft-deleted hand-made Cases, shown alongside the on-disk Case trash. */
  const [customTrash, setCustomTrash] = useState<TestCase[]>([]);
  const [catalog, setCatalog] = useState<CatalogSystem[]>(CASE_LIBRARY_CATALOG);
  // Status of the portal belonging to the selected Run's Case — not a global one.
  const [intranet, setIntranet] = useState<IntranetStatus>(IDLE_INTRANET);
  const [selectedCaseId, setSelectedCaseId] = useState(DEFAULT_CASES[0].id);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  // One Run filter shared by 手工录入 / 手工判定 / 结果展示 and the sidebar's Agent
  // list, so narrowing the focus once applies everywhere the operator looks.
  const [runFilters, setRunFilters] = usePersistentState<RunFilterValue>("aetf:run-filters", EMPTY_RUN_FILTER, "tab");
  const [selectedTurnId, setSelectedTurnId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [screenCaptureIntent, setScreenCaptureIntent] = useState<{ step?: RunStep }>();
  const [autoSave, setAutoSave] = useState(true);
  const [fontScale, setFontScale] = useState<FontScale>("comfortable");
  const [settings, setSettings] = useState<WorkbenchConfigState>({
    schemaVersion: "0.4.0",
    caseLibraryPath: CASE_LIBRARY_SUMMARY.caseLibraryPath,
    workingRoot: CASE_LIBRARY_SUMMARY.workingRoot,
    resolvedCaseLibraryPath: CASE_LIBRARY_SUMMARY.caseLibraryPath,
    resolvedWorkingRoot: CASE_LIBRARY_SUMMARY.workingRoot,
    configPath: CASE_LIBRARY_SUMMARY.configPath,
  });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);
  const [undoAction, setUndoAction] = useState<UndoEntry | null>(null);
  // A stack, not just the last action: the transient bar disappears after a few
  // seconds, but 撤回 in the top bar stays available for the whole session so an
  // accidental delete noticed a minute later is still recoverable.
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (text: string, tone: NonNullable<Toast>["tone"] = "success") => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  };

  const pushUndo = (label: string, restore: () => void | Promise<void>) => {
    const entry: UndoEntry = { id: `undo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, label, at: new Date().toISOString(), restore };
    setUndoStack((items) => [entry, ...items].slice(0, UNDO_STACK_LIMIT));
    setUndoAction(entry);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoAction(null), 8000);
  };

  const runUndo = async (entry?: UndoEntry) => {
    const target = entry ?? undoStack[0];
    if (!target) return;
    setUndoStack((items) => items.filter((item) => item.id !== target.id));
    if (undoAction?.id === target.id) setUndoAction(null);
    try {
      await target.restore();
      notify(`已撤回：${target.label}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "撤回失败", "error");
    }
  };

  // Ctrl/Cmd+Z anywhere except inside a text field, where the browser's own
  // text undo is what the operator expects.
  const undoHotkey = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.key === "z" || event.key === "Z") || !(event.ctrlKey || event.metaKey) || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
    if (!undoStack.length) return;
    event.preventDefault();
    void runUndo();
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => undoHotkey(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Restore the last active tab on mount, before the loading gate clears, so a
  // reload (including the reloads triggered by fork / lifecycle / delete /
  // promote) returns to the same page instead of dropping back to the overview.
  useEffect(() => {
    const storedView = readStored("aetf:view", "tab");
    const timer = window.setTimeout(() => {
      if (storedView && (["dashboard", "cases", "entry", "review", "results"] as const).includes(storedView as View)) setView(storedView as View);
      hydrated.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { if (hydrated.current) writeStored("aetf:view", view, "tab"); }, [view]);
  // Only persist selections after the initial load resolves, so mounting with the
  // default ids never overwrites the persisted values the load effect restores.
  useEffect(() => { if (hydrated.current && !loading && selectedCaseId) writeStored("aetf:selected-case", selectedCaseId, "tab"); }, [selectedCaseId, loading]);
  useEffect(() => { if (hydrated.current && !loading && selectedRunId) writeStored("aetf:selected-run", selectedRunId, "tab"); }, [selectedRunId, loading]);

  useEffect(() => {
    (async () => {
      try {
        const [{ records }, trashEntries, liveCatalog] = await Promise.all([
          apiRecords(),
          apiCaseTrash().catch(() => [] as CaseTrashEntry[]),
          apiCatalog().catch(() => CASE_LIBRARY_CATALOG),
        ]);
        setCaseTrash(trashEntries);
        if (liveCatalog.length) setCatalog(liveCatalog);
        const storedAgents = records.filter((record) => record.kind === "agent").map((record) => record.payload as AgentProfile);
        const storedCases = records.filter((record) => record.kind === "case").map((record) => {
          const item = record.payload as TestCase;
          return { ...item, readme: item.readme ?? blankCaseReadme() };
        });
        const now = Date.now();
        const baselineByFamily = new Map(CASE_LIBRARY_CASES.filter((item) => item.source?.isBaseline).map((item) => [item.source?.familyId, item]));
        // Runs come from disk. Import any Run still living only in the legacy record
        // store on the first load, then rescan so both sets appear together.
        let scan = await apiScanRuns();
        const migrated = await migrateLegacyRuns(new Set(scan.runs.map((run) => run.id))).catch(() => 0);
        if (migrated) scan = await apiScanRuns();
        setRunsRoot(scan.runsRoot);
        setUnreadableRunDirs(scan.skipped);
        const allStoredRuns = scan.runs.map((run) => {
          if (CASE_LIBRARY_CASES.some((item) => item.id === run.caseId)) return run;
          const baseline = baselineByFamily.get(run.caseId) ?? CASE_LIBRARY_CASES.find((item) => item.source?.familyId === run.caseId);
          return baseline ? { ...run, caseId: baseline.id } : run;
        });
        const expiredRuns = allStoredRuns.filter((run) => run.purgeAt && new Date(run.purgeAt).getTime() <= now);
        await Promise.all(expiredRuns.map((run) => apiDeleteRunDirectory(run.id).catch(() => undefined)));
        const storedRuns = allStoredRuns.filter((run) => !expiredRuns.some((expired) => expired.id === run.id));
        if (migrated) notify(`已把 ${migrated} 个历史 Run 从数据库迁移到 ${scan.runsRoot}`, "info");
        if (storedAgents.length) setAgents(storedAgents);
        else await Promise.all(DEFAULT_AGENTS.map((agent) => putRecord("agent", agent.id, agent.name, agent)));
        if (CASE_LIBRARY_CASES.length) {
          const libraryIds = new Set(CASE_LIBRARY_CASES.map((item) => item.id));
          const storedById = new Map(storedCases.map((item) => [item.id, item]));
          const libraryCases = CASE_LIBRARY_CASES.map((sourceCase) => {
            const stored = storedById.get(sourceCase.id);
            return stored && stored.source?.fingerprint === sourceCase.source?.fingerprint && stored.source?.mappingVersion === sourceCase.source?.mappingVersion ? stored : sourceCase;
          });
          const customCases = storedCases.filter((item) => !item.source && !libraryIds.has(item.id) && !["case_fs_external_read", "case_browser_search"].includes(item.id));
          setCustomTrash(customCases.filter((item) => Boolean(item.deletedAt)));
          const connectedCases = [...libraryCases, ...customCases].filter((item) => !item.deletedAt);
          const changedCases = libraryCases.filter((item) => storedById.get(item.id) !== item);
          if (changedCases.length) await Promise.all(changedCases.map((item) => putRecord("case", item.id, item.title, item)));
          setCases(connectedCases);
          const requestedCaseId = window.localStorage.getItem("aetf:select-case-after-reload");
          const persistedCaseId = readStored("aetf:selected-case", "tab");
          const initialCaseId = [requestedCaseId, persistedCaseId].find((id) => id && connectedCases.some((item) => item.id === id)) ?? connectedCases[0].id;
          window.localStorage.removeItem("aetf:select-case-after-reload");
          setSelectedCaseId(initialCaseId);
        } else if (storedCases.length) {
          setCases(storedCases);
          setSelectedCaseId(storedCases[0].id);
        } else await Promise.all(DEFAULT_CASES.map((item) => putRecord("case", item.id, item.title, item)));
        storedRuns.forEach(rememberSaved);
        setRuns(storedRuns);
        if (storedRuns.length) {
          const persistedRunId = readStored("aetf:selected-run", "tab");
          const initialRun = storedRuns.find((run) => run.id === persistedRunId && !run.deletedAt) ?? storedRuns[0];
          setSelectedRunId(initialRun.id);
          setSelectedTurnId(initialRun.turns[0]?.id ?? "");
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "初始化失败", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("aetf:auto-save");
    const timer = window.setTimeout(() => { if (stored !== null) setAutoSave(stored !== "false"); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("aetf:font-scale") as FontScale | null;
    const next = stored && ["standard", "comfortable", "large"].includes(stored) ? stored : "comfortable";
    document.documentElement.style.setProperty("--font-scale", next === "standard" ? "1" : next === "large" ? "1.32" : "1.16");
    const timer = window.setTimeout(() => setFontScale(next), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setFontScalePreference = (next: FontScale) => {
    setFontScale(next);
    window.localStorage.setItem("aetf:font-scale", next);
    document.documentElement.style.setProperty("--font-scale", next === "standard" ? "1" : next === "large" ? "1.32" : "1.16");
  };

  const setAutoSavePreference = (enabled: boolean) => {
    setAutoSave(enabled);
    window.localStorage.setItem("aetf:auto-save", String(enabled));
  };

  useEffect(() => {
    fetch("/api/local/config", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const loaded = await response.json() as { config: WorkbenchConfigState; configPath: string; resolvedCaseLibraryPath: string; resolvedWorkingRoot: string; resolvedRunsRoot: string };
        setSettings({ ...loaded.config, configPath: loaded.configPath, resolvedCaseLibraryPath: loaded.resolvedCaseLibraryPath, resolvedWorkingRoot: loaded.resolvedWorkingRoot, resolvedRunsRoot: loaded.resolvedRunsRoot });
      })
      .catch(() => undefined);
  }, []);

  const selectedCase = cases.find((item) => item.id === selectedCaseId) ?? cases[0];
  const selectedRun = runs.find((item) => item.id === selectedRunId);
  const selectedTurn = selectedRun?.turns.find((item) => item.id === selectedTurnId) ?? selectedRun?.turns[0];

  const saveCase = async (next: TestCase) => {
    setSaving(true);
    try {
      const updated = { ...next, updatedAt: new Date().toISOString() };
      if (updated.source) {
        if (!updated.source.mutable) throw new Error("该版本已冻结为候选版或已归档；请先“重新编辑”，或 Fork 新版本");
        const response = await fetch("/api/local/cases/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ case: updated }) });
        if (!response.ok) throw new Error(await responseError(response));
        await putRecord("case", updated.id, updated.title, updated);
        setCases((items) => items.map((item) => item.id === updated.id ? updated : item));
        notify(`Case v${updated.version} 已写回版本目录；旧版本未改变`);
        return;
      }
      await putRecord("case", updated.id, updated.title, updated);
      setCases((items) => items.map((item) => item.id === updated.id ? updated : item));
      notify("Case 已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    } finally { setSaving(false); }
  };

  const forkCase = async (item: TestCase, changeType: "major" | "minor" | "patch", changeSummary: string) => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, changeType, changeSummary }) });
      if (!response.ok) throw new Error(await responseError(response));
      const created = await response.json() as { caseId: string; version: string };
      window.localStorage.setItem("aetf:select-case-after-reload", created.caseId);
      notify(`已创建可编辑版本 v${created.version}，旧版本保持不变`);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Fork Case 失败", "error");
    } finally { setSaving(false); }
  };

  const editForkNote = async (item: TestCase, changeSummary: string) => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/fork-note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, changeSummary }) });
      if (!response.ok) throw new Error(await responseError(response));
      setCases((items) => items.map((candidate) => candidate.id === item.id && candidate.source ? { ...candidate, source: { ...candidate.source, changeSummary } } : candidate));
      notify("Fork 备注已更新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "更新备注失败", "error");
    } finally { setSaving(false); }
  };

  const promoteCase = async (item: TestCase, title: string, target: { systemCategory: string; riskCategorySlug: string }) => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, title, systemCategory: target.systemCategory, riskCategorySlug: target.riskCategorySlug }) });
      if (!response.ok) throw new Error(await responseError(response));
      const created = await response.json() as { caseId: string; caseNumber: string };
      window.localStorage.setItem("aetf:select-case-after-reload", created.caseId);
      notify(`已独立为新 Case ${created.caseNumber}（v1.0.0 基线）；原版本与全部 Run 保持不变`);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      notify(error instanceof Error ? error.message : "独立为新 Case 失败", "error");
    } finally { setSaving(false); }
  };

  const moveCase = async (item: TestCase, target: { systemCategory: string; riskCategorySlug: string }) => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, ...target }) });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { moved: boolean; versions?: number; caseNumber?: string; renumbered?: boolean; reason?: string };
      if (!result.moved) { notify(result.reason ?? "分类未变化"); return; }
      window.localStorage.setItem("aetf:select-case-after-reload", item.id);
      notify(`分类已保存：${result.versions} 个版本已迁到 ${result.caseNumber}${result.renumbered ? "（目标目录下编号已顺延）" : ""}；全部 Run 保持绑定`);
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存分类失败", "error");
    } finally { setSaving(false); }
  };

  const renameCase = async (item: TestCase, title: string, scope: "family" | "version") => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, title, scope }) });
      if (!response.ok) throw new Error(await responseError(response));
      window.localStorage.setItem("aetf:select-case-after-reload", item.id);
      notify(scope === "family" ? "整个 Case 已重命名；全部版本与 Run 保持不变" : `版本 v${item.version} 已重命名`);
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error) {
      notify(error instanceof Error ? error.message : "重命名失败", "error");
    } finally { setSaving(false); }
  };

  const changeCaseLifecycle = async (item: TestCase, lifecycle: "working" | "candidate" | "accepted" | "archived") => {
    const verb = lifecycle === "accepted" ? "设为当前默认版" : lifecycle === "candidate" ? "冻结为候选版" : lifecycle === "working" ? "重新打开编辑" : "归档";
    if ((lifecycle === "accepted" || lifecycle === "archived") && !window.confirm(`${verb} v${item.version}？其它分支、旧版本与全部 Run 都会完整保留，不会被删除或合并。`)) return;
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, lifecycle }) });
      if (!response.ok) throw new Error(await responseError(response));
      window.localStorage.setItem("aetf:select-case-after-reload", item.id);
      notify(`${verb}完成，正在刷新版本谱系`);
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error) {
      notify(error instanceof Error ? error.message : `${verb}失败`, "error");
    } finally { setSaving(false); }
  };

  const runSync = useRef<ReturnType<typeof openRunSync> | null>(null);
  const foreignFocus = useRef(new Map<string, string>());
  /**
   * The Run list as it stands right now. Operations that await something slow —
   * deploying or destroying a fixture takes seconds of PowerShell — must save
   * from this rather than from the copy their closure captured, or they write
   * back a snapshot from before whatever the operator typed while waiting.
   */
  const runsRef = useRef<TestRun[]>(runs);
  useEffect(() => { runsRef.current = runs; }, [runs]);
  /** Runs currently open in other tabs, so this tab can flag an accidental overlap. */
  const [runsOpenElsewhere, setRunsOpenElsewhere] = useState<Set<string>>(new Set());

  /**
   * Another tab won the race for this Run. Pull the newer copy back in rather
   * than leaving a stale one in memory that the next keystroke would try to
   * write again, and tell the operator which Run needs a second look.
   */
  const recoverConflictedRun = async (runId: string, detail: string) => {
    const fresh = await apiReadRun(runId).catch(() => undefined);
    if (fresh) { rememberSaved(fresh); setRuns((items) => items.map((item) => item.id === runId ? fresh : item)); }
    notify(`${detail}${fresh ? "已载入对方保存的最新内容。" : ""}`, "error");
  };

  const saveRun = async (next: TestRun, message = "Run 已保存") => {
    setSaving(true);
    try {
      const safeName = next.name?.trim() || buildRunName(agents.find((agent) => agent.id === next.agentId)?.name ?? "Agent", cases.find((item) => item.id === next.caseId)?.title ?? "Case", next.startedAt);
      const updated = { ...next, name: safeName, nameMode: next.name?.trim() ? next.nameMode : "auto" as const, updatedAt: new Date().toISOString() };
      const stored = { ...updated, storage: await apiWriteRun(updated) };
      rememberSaved(stored);
      setRuns((items) => items.some((item) => item.id === stored.id) ? items.map((item) => item.id === stored.id ? stored : item) : [stored, ...items]);
      runSync.current?.post({ kind: "run-saved", tabId: TAB_ID, runId: stored.id, updatedOnDisk: stored.storage?.updatedOnDisk });
      notify(message);
    } catch (error) {
      if (error instanceof RunConflictError) await recoverConflictedRun(error.runId, error.message);
      else notify(error instanceof Error ? error.message : "保存失败", "error");
    } finally { setSaving(false); }
  };

  // Only the Run's CONTENT may retrigger autosave. `updatedAt` and `storage`
  // are both stamped by the save itself (`storage.updatedOnDisk` is the file's
  // mtime), so including either makes every save schedule the next one — an
  // endless write loop that pinned "保存中" on and remounted the review pane.
  const selectedRunSignature = selectedRun ? runSignature(selectedRun) : "";

  /** Write one Run to disk. Shared by the debounce and by the flush-on-leave path. */
  const persistRun = useEffectEvent(async (captured: TestRun) => {
      // Write what state holds right now, not the snapshot the debounce captured.
      // The flush-on-leave and pagehide paths can fire with a copy taken before a
      // concurrent 保存, and writing that back is a silent revert.
      const target = runs.find((item) => item.id === captured.id) ?? captured;
      if (!target || target.deletedAt) return;
      const safeName = target.name?.trim() || buildRunName(agents.find((agent) => agent.id === target.agentId)?.name ?? "Agent", cases.find((item) => item.id === target.caseId)?.title ?? "Case", target.startedAt);
      const updated = { ...target, name: safeName, nameMode: target.name?.trim() ? target.nameMode : "auto" as const, updatedAt: new Date().toISOString() };
      setSaving(true);
      try {
        const storage = await apiWriteRun(updated);
        rememberSaved(updated);
        setRuns((items) => items.map((item) => item.id === updated.id ? { ...updated, storage } : item));
        runSync.current?.post({ kind: "run-saved", tabId: TAB_ID, runId: updated.id, updatedOnDisk: storage?.updatedOnDisk });
      } catch (error) {
        if (error instanceof RunConflictError) await recoverConflictedRun(error.runId, error.message);
        else notify(error instanceof Error ? error.message : "实时保存失败", "error");
      } finally { setSaving(false); }
  });

  /**
   * The Run whose edits are sitting in the debounce window. Switching Runs used
   * to just clear the timer, so the last <900ms of typing on the Run being left
   * never reached disk — it lived only in memory and vanished on reload. Now the
   * pending Run is flushed when focus moves off it, and again when the tab goes
   * away.
   */
  const pendingRun = useRef<TestRun | null>(null);
  /**
   * The Run object itself is read through a ref, never a dependency.
   *
   * `selectedRunSignature` deliberately ignores `updatedAt` and `storage` so a
   * save cannot schedule the next save — but listing `selectedRun` in the deps
   * put that loop straight back, because every write replaces the Run in state
   * with a fresh object. The identity change re-armed the debounce, that write
   * replaced the object again, and each tab rewrote its selected Run to disk
   * roughly once a second, forever. Two tabs racing that loop is what silently
   * reverted 手工判定 结果: a tick carrying the pre-judgement copy landed after
   * the explicit 保存.
   */
  const selectedRunRef = useRef(selectedRun);
  selectedRunRef.current = selectedRun;
  useEffect(() => {
    if (!autoSave || !selectedRunSignature || loading) return;
    const target = selectedRunRef.current;
    if (!target) return;
    // Already identical to what is on disk — arming a write here would only bump
    // the mtime and wake every other tab's sync listener for nothing.
    if (savedSignatures.current.get(target.id) === selectedRunSignature) return;
    pendingRun.current = target;
    const timer = window.setTimeout(() => { pendingRun.current = null; void persistRun(target); }, 900);
    return () => window.clearTimeout(timer);
  }, [selectedRunSignature, autoSave, loading]);

  useEffect(() => {
    // Cleanup fires when the selected Run changes or the workbench unmounts.
    return () => {
      const leaving = pendingRun.current;
      if (!leaving) return;
      pendingRun.current = null;
      void persistRun(leaving);
    };
  }, [selectedRun?.id]);

  useEffect(() => {
    const flush = () => {
      const leaving = pendingRun.current;
      if (!leaving) return;
      pendingRun.current = null;
      void persistRun(leaving);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  /* ---------------------------------------------------------------- 多标签页同步
   * Each tab loads the Run list once. Without this, a Run created or edited while
   * recording another Agent in a second tab stays invisible here — and this tab's
   * stale copy could later be written back over the newer one.
   */

  const applyRunSyncMessage = useEffectEvent(async (message: RunSyncMessage) => {
    if (message.kind === "run-saved") {
      // Skip the Run this tab is actively editing: pulling the file in mid-edit
      // would discard keystrokes. The 409 guard already stops us overwriting it.
      if (message.runId === pendingRun.current?.id) return;
      const fresh = await apiReadRun(message.runId).catch(() => undefined);
      if (!fresh) return;
      rememberSaved(fresh);
      setRuns((items) => items.some((item) => item.id === fresh.id) ? items.map((item) => item.id === fresh.id ? fresh : item) : [fresh, ...items]);
      return;
    }
    if (message.kind === "run-removed") {
      setRuns((items) => items.filter((item) => item.id !== message.runId));
      return;
    }
    if (message.kind === "run-focus") {
      if (message.runId) foreignFocus.current.set(message.tabId, message.runId);
      else foreignFocus.current.delete(message.tabId);
      setRunsOpenElsewhere(new Set(foreignFocus.current.values()));
      return;
    }
    if (message.kind === "who-has-what") {
      runSync.current?.post({ kind: "run-focus", tabId: TAB_ID, runId: selectedRunId || null });
    }
  });

  useEffect(() => {
    const channel = openRunSync((message) => { void applyRunSyncMessage(message); });
    runSync.current = channel;
    channel.post({ kind: "who-has-what", tabId: TAB_ID });
    return () => { channel.close(); runSync.current = null; };
  }, []);

  useEffect(() => {
    runSync.current?.post({ kind: "run-focus", tabId: TAB_ID, runId: selectedRunId || null });
  }, [selectedRunId]);

  /**
   * 让选中的 Run 跟磁盘保持一致。
   *
   * 上面的跨标签页同步走 BroadcastChannel，只在同一个浏览器里有效。同时测几个
   * Agent 时，另一个窗口（或局域网里另一台机器上的工作台）刚写回的 Turn，这边
   * 要等到手工"重新扫描"才看得见——点开是旧的，再点一次才是新的。切到某个 Run、
   * 或切回这个标签页时顺手重读一次 run.json，就不用再手工刷新。
   *
   * 本地只要有没写盘的改动就跳过：那份内存副本才是操作员正在录的东西，重读会把
   * 它冲掉。真出现两边同时改，保存时的 409 冲突守卫仍然会拦下来。
   */
  const refreshSelectedRun = useEffectEvent(async () => {
    const target = selectedRunRef.current;
    if (!target || loading || pendingRun.current) return;
    const baseline = runSignature(target);
    if (savedSignatures.current.get(target.id) !== baseline) return;
    const fresh = await apiReadRun(target.id).catch(() => undefined);
    if (!fresh || runSignature(fresh) === baseline) return;
    // 读盘期间操作员已经改动或换走了这个 Run，这次结果就作废。
    const current = selectedRunRef.current;
    if (!current || current.id !== fresh.id || runSignature(current) !== baseline) return;
    rememberSaved(fresh);
    setRuns((items) => items.map((item) => item.id === fresh.id ? fresh : item));
  });

  useEffect(() => { void refreshSelectedRun(); }, [selectedRunId, loading]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === "visible") void refreshSelectedRun(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => { window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", recheck); };
  }, []);

  const mutateRun = (updater: (run: TestRun) => TestRun) => {
    if (!selectedRun) return;
    setRuns((items) => items.map((item) => item.id === selectedRun.id ? updater(item) : item));
  };

  const mutateTurn = (updater: (turn: RunTurn) => RunTurn) => {
    if (!selectedRun || !selectedTurn) return;
    mutateRun((run) => ({ ...run, turns: run.turns.map((turn) => turn.id === selectedTurn.id ? updater(turn) : turn) }));
  };

  // WorkBuddy is the default subject for iterating on Cases; fall back if absent.
  const defaultRunAgentId = (agents.find((item) => item.id === "agent_workbuddy") ?? agents[0])?.id ?? "";
  // Default the new Run to the Case/version currently in focus (Case 管理 selection),
  // not a global first-preferred Case — so "新建 Run" while viewing a Fork attaches
  // the Run to that exact version instead of an unrelated Case.
  const defaultRunCaseId = (cases.find((item) => item.id === selectedCaseId) ?? cases.find((item) => item.source?.preferred) ?? cases[0])?.id ?? "";

  /** "+" 只是打开确认对话框，真正的创建在 createRun 里。 */
  const openCreateRun = () => { if (agents.length && cases.length) setNewRunOpen(true); };

  const createRun = async (draft: { agentId: string; caseId: string; runStage: RunStage }) => {
    const agent = agents.find((item) => item.id === draft.agentId) ?? agents[0];
    const caseItem = cases.find((item) => item.id === draft.caseId) ?? cases[0];
    if (!agent || !caseItem) return;
    const run: TestRun = {
      ...blankRun(agent, caseItem, runs),
      runStage: draft.runStage,
      permissionMode: resolvePermissionDefault(agent, draft.runStage, "自动审批 / 完全自主"),
    };
    setNewRunOpen(false);
    // 先按"已存"登记，免得插入状态后自动保存的防抖又排一次完全相同的写盘；下面
    // 的 saveRun 才是真正落盘的那一次，失败会提示，之后任何一次编辑仍会重试。
    rememberSaved(run);
    setRuns((items) => [run, ...items]);
    setSelectedRunId(run.id);
    setSelectedTurnId("");
    setView("entry");
    // 确认创建就立刻写盘，不再等自动保存：这个 Run 是操作员明确要的。
    await saveRun(run, `已创建 Run：${run.name}`);
  };

  const trashRun = async (run: TestRun) => {
    const deletedAt = new Date();
    const next = { ...run, deletedAt: deletedAt.toISOString(), purgeAt: new Date(deletedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), updatedAt: deletedAt.toISOString() };
    await apiWriteRun(next);
    setRuns((items) => items.map((item) => item.id === next.id ? next : item));
    const fallback = runs.find((item) => item.id !== next.id && !item.deletedAt);
    setSelectedRunId(fallback?.id ?? "");
    setSelectedTurnId(fallback?.turns[0]?.id ?? "");
    notify("Run 已移入回收站，7 天后自动删除");
    pushUndo(`删除 Run「${run.name || run.id}」`, async () => {
      await apiWriteRun(run);
      setRuns((items) => items.map((item) => item.id === run.id ? run : item));
      setSelectedRunId(run.id);
      setSelectedTurnId(run.turns[0]?.id ?? "");
    });
  };

  const batchTrashRuns = async (ids: string[]) => {
    const targets = runs.filter((run) => ids.includes(run.id) && !run.deletedAt);
    if (!targets.length) return;
    const now = new Date();
    const purgeAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const patched = targets.map((run) => ({ ...run, deletedAt: now.toISOString(), purgeAt, updatedAt: now.toISOString() }));
    try {
      await Promise.all(patched.map((run) => apiWriteRun(run)));
      const patchedById = new Map(patched.map((run) => [run.id, run]));
      setRuns((items) => items.map((item) => patchedById.get(item.id) ?? item));
      if (ids.includes(selectedRunId)) {
        const fallback = runs.find((item) => !ids.includes(item.id) && !item.deletedAt);
        setSelectedRunId(fallback?.id ?? "");
        setSelectedTurnId(fallback?.turns[0]?.id ?? "");
      }
      notify(`${targets.length} 个 Run 已移入回收站，7 天后自动删除`);
      pushUndo(`删除 ${targets.length} 个 Run`, async () => {
        await Promise.all(targets.map((run) => apiWriteRun(run)));
        const originals = new Map(targets.map((run) => [run.id, run]));
        setRuns((items) => items.map((item) => originals.get(item.id) ?? item));
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "批量删除失败", "error");
    }
  };

  const restoreRun = async (run: TestRun) => {
    const next = { ...run, deletedAt: undefined, purgeAt: undefined, updatedAt: new Date().toISOString() };
    await apiWriteRun(next);
    setRuns((items) => items.map((item) => item.id === next.id ? next : item));
    notify("Run 已恢复");
  };

  const permanentlyDeleteRun = async (run: TestRun) => {
    if (!window.confirm(`永久删除 ${run.name || run.id}？将删除磁盘上的整个 Run 目录${run.storage ? `\n${run.storage.directory}` : ""}，包含其快照与证据，且无法恢复。`)) return;
    try {
      await apiDeleteRunDirectory(run.id);
      setRuns((items) => items.filter((item) => item.id !== run.id));
      notify("Run 目录已从磁盘删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "永久删除失败", "error");
    }
  };

  /**
   * Re-read the Runs root. This is how a Run that was archived elsewhere (or
   * dropped back in) becomes visible again without restarting the workbench.
   */
  const rescanRuns = async () => {
    setSaving(true);
    try {
      const scan = await apiScanRuns();
      setRunsRoot(scan.runsRoot);
      setUnreadableRunDirs(scan.skipped);
      setRuns(scan.runs);
      if (!scan.runs.some((run) => run.id === selectedRunId)) {
        const fallback = scan.runs.find((run) => !run.deletedAt);
        setSelectedRunId(fallback?.id ?? "");
        setSelectedTurnId(fallback?.turns[0]?.id ?? "");
      }
      notify(`已重新扫描 ${scan.runsRoot}：${scan.runs.length} 个 Run${scan.skipped.length ? `，${scan.skipped.length} 个目录无法识别` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "扫描 Run 目录失败", "error");
    } finally { setSaving(false); }
  };

  /** A hand-made Case has no directory, so "delete" is a recoverable soft flag. */
  const deleteCustomCase = async (item: TestCase) => {
    const deleted = { ...item, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await putRecord("case", deleted.id, deleted.title, deleted);
    setCases((items) => items.filter((candidate) => candidate.id !== item.id));
    setCustomTrash((items) => [deleted, ...items.filter((candidate) => candidate.id !== item.id)]);
    if (selectedCaseId === item.id) {
      const fallback = cases.find((candidate) => candidate.id !== item.id);
      if (fallback) setSelectedCaseId(fallback.id);
    }
    notify("自建 Case 已移入 Case 垃圾箱，可随时恢复");
    pushUndo(`删除自建 Case「${item.title}」`, () => restoreCustomCase(item));
  };

  const deleteCase = async (item: TestCase, scope: "family" | "version") => {
    if (!item.source?.familyId) return deleteCustomCase(item);
    const familyIds = new Set(cases.filter((candidate) => candidate.source?.familyId === item.source?.familyId).map((candidate) => candidate.id));
    const runCount = runs.filter((run) => !run.deletedAt && (scope === "family" ? familyIds.has(run.caseId) : run.caseId === item.id)).length;
    const confirmation = scope === "family" ? `DELETE FAMILY ${item.source.familyId}` : `DELETE VERSION ${item.id}`;
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, scope, runCount, confirmation }) });
      if (!response.ok) throw new Error(await responseError(response));
      if (scope === "version") {
        const fallback = cases.find((candidate) => candidate.source?.familyId === item.source?.familyId && candidate.id !== item.id && candidate.source?.preferred)
          ?? cases.find((candidate) => candidate.source?.familyId === item.source?.familyId && candidate.id !== item.id);
        if (fallback) window.localStorage.setItem("aetf:select-case-after-reload", fallback.id);
      }
      notify(scope === "family" ? "整个 Case 已移入垃圾箱，可随时恢复" : `Fork 版本 v${item.version} 已移入垃圾箱，可随时恢复`);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除 Case 失败", "error");
      throw error;
    } finally { setSaving(false); }
  };

  /** Move several Cases into the trash in one pass; failures are reported, not silent. */
  const batchDeleteCases = async (items: TestCase[]) => {
    const failures: string[] = [];
    for (const item of items) {
      try { await deleteCase(item, "family"); }
      catch { failures.push(item.title); }
    }
    if (failures.length) notify(`${failures.length} 个 Case 删除失败：${failures.join("、")}`, "error");
    else notify(`${items.length} 个 Case 已移入 Case 垃圾箱`);
    // A library delete reloads the page on its own; a pure custom-Case batch does not.
    if (items.every((item) => !item.source)) return;
  };

  const emptyCaseTrash = async () => {
    setSaving(true);
    try {
      if (caseTrash.length) {
        const response = await fetch("/api/local/cases/trash/purge-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: `EMPTY TRASH ${caseTrash.length}` }) });
        if (!response.ok) throw new Error(await responseError(response));
      }
      await Promise.all(customTrash.map((item) => fetch(`/api/records?id=${encodeURIComponent(item.id)}`, { method: "DELETE" })));
      const purged = caseTrash.length + customTrash.length;
      setCaseTrash([]);
      setCustomTrash([]);
      notify(`Case 垃圾箱已清空：永久删除 ${purged} 个条目`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "清空垃圾箱失败", "error");
      throw error;
    } finally { setSaving(false); }
  };

  const restoreCustomCase = async (item: TestCase) => {
    const restored = { ...item, deletedAt: undefined, updatedAt: new Date().toISOString() };
    await putRecord("case", restored.id, restored.title, restored);
    setCustomTrash((items) => items.filter((candidate) => candidate.id !== item.id));
    setCases((items) => [restored, ...items]);
    setSelectedCaseId(restored.id);
    notify("自建 Case 已恢复");
  };

  const purgeCustomCase = async (item: TestCase) => {
    const response = await fetch(`/api/records?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("永久删除失败");
    setCustomTrash((items) => items.filter((candidate) => candidate.id !== item.id));
    notify("自建 Case 已永久删除");
  };

  const restoreCaseTrash = async (entry: CaseTrashEntry) => {
    if (entry.storageKind === "custom") {
      const item = customTrash.find((candidate) => candidate.id === entry.sourceCaseId);
      if (item) await restoreCustomCase(item);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/trash/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashId: entry.id }) });
      if (!response.ok) throw new Error(await responseError(response));
      window.localStorage.setItem("aetf:select-case-after-reload", entry.sourceCaseId);
      notify(entry.scope === "family" ? "Case 家族已恢复到原目录" : `版本 v${entry.version} 已恢复到原目录`);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      notify(error instanceof Error ? error.message : "恢复 Case 失败", "error");
    } finally { setSaving(false); }
  };

  const purgeCaseTrash = async (entry: CaseTrashEntry) => {
    if (entry.storageKind === "custom") {
      const item = customTrash.find((candidate) => candidate.id === entry.sourceCaseId);
      if (item) await purgeCustomCase(item);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/trash/purge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashId: entry.id, confirmation: `PERMANENT ${entry.id}` }) });
      if (!response.ok) throw new Error(await responseError(response));
      setCaseTrash((items) => items.filter((item) => item.id !== entry.id));
      notify("垃圾箱条目已永久删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "永久删除失败", "error");
      throw error;
    } finally { setSaving(false); }
  };

  const addTurn = () => {
    if (!selectedRun) return;
    const caseItem = cases.find((item) => item.id === selectedRun.caseId);
    const id = nextSequentialId("turn", selectedRun.turns.map((turn) => turn.id));
    const order = selectedRun.turns.length + 1;
    const planned = caseItem?.turns[order - 1];
    // Seed turn 1 from the Case's effective prompt (promptBoundary is authoritative
    // and kept in sync with turn[0]); later turns fall back to their planned text.
    // The intranet placeholder is resolved here rather than left in the record: a
    // Run has to preserve the text that was actually sent, and the mock portal's
    // address changes between machines and restarts.
    const seededPrompt = withRootNativePaths(withIntranetBaseUrl(order === 1 && caseItem ? effectiveCasePrompt(caseItem) : (planned?.prompt ?? ""), intranet), deploymentRootsForCase(selectedRun));
    const turn: RunTurn = {
      id,
      order,
      caseTurnId: planned?.id,
      prompt: seededPrompt,
      response: "",
      pathMatch: "not_evaluated",
      unexpectedPathSummary: "",
      steps: [],
      annotations: [],
      summaries: [],
    };
    mutateRun((run) => ({ ...run, turns: [...run.turns, turn] }));
    setSelectedTurnId(id);
  };

  const deleteTurn = (turnId: string) => {
    if (!selectedRun) return;
    const target = selectedRun.turns.find((turn) => turn.id === turnId);
    // No confirm dialog: manual entry is high-frequency editing, and the undo bar
    // below restores the whole Run snapshot including the Turn's Steps.
    if (!target) return;
    const snapshot = selectedRun;
    const previousTurnId = selectedTurnId;
    const remaining = selectedRun.turns
      .filter((turn) => turn.id !== turnId)
      .map((turn, index) => ({ ...turn, order: index + 1 }));
    mutateRun((run) => ({ ...run, turns: remaining }));
    setSelectedTurnId(remaining[Math.min(target.order - 1, remaining.length - 1)]?.id ?? "");
    notify("Turn 已删除");
    pushUndo(`已删除 ${target.id}`, () => { setRuns((items) => items.map((item) => item.id === snapshot.id ? snapshot : item)); setSelectedTurnId(previousTurnId); });
  };

  const deleteTurns = (turnIds: string[]) => {
    if (!selectedRun || !turnIds.length) return;
    const snapshot = selectedRun;
    const previousTurnId = selectedTurnId;
    const remaining = selectedRun.turns.filter((turn) => !turnIds.includes(turn.id)).map((turn, index) => ({ ...turn, order: index + 1 }));
    mutateRun((run) => ({ ...run, turns: remaining }));
    if (turnIds.includes(selectedTurnId)) setSelectedTurnId(remaining[0]?.id ?? "");
    notify(`${turnIds.length} 个 Turn 已删除`);
    pushUndo(`已删除 ${turnIds.length} 个 Turn`, () => { setRuns((items) => items.map((item) => item.id === snapshot.id ? snapshot : item)); setSelectedTurnId(previousTurnId); });
  };

  const addStep = (kind: string) => {
    if (!selectedTurn) return;
    const id = nextSequentialId("step", selectedTurn.steps.map((step) => step.id));
    mutateTurn((turn) => ({ ...turn, steps: [...turn.steps, blankStep(id, turn.steps.length + 1, kind)] }));
  };

  const insertStep = (kind: string, index: number) => {
    if (!selectedTurn) return;
    const id = nextSequentialId("step", selectedTurn.steps.map((step) => step.id));
    mutateTurn((turn) => {
      const next = [...turn.steps];
      next.splice(index, 0, blankStep(id, index + 1, kind));
      return { ...turn, steps: next.map((step, stepIndex) => ({ ...step, order: stepIndex + 1 })) };
    });
  };

  const moveStep = (stepId: string, targetIndex: number) => {
    const snapshot = selectedRun;
    if (snapshot) pushUndo("调整 Step 顺序", () => setRuns((items) => items.map((item) => item.id === snapshot.id ? snapshot : item)));
    mutateTurn((turn) => {
      const currentIndex = turn.steps.findIndex((step) => step.id === stepId);
      if (currentIndex < 0) return turn;
      const next = [...turn.steps];
      const [moving] = next.splice(currentIndex, 1);
      const adjustedTarget = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
      next.splice(Math.max(0, Math.min(adjustedTarget, next.length)), 0, moving);
      return { ...turn, steps: next.map((step, index) => ({ ...step, order: index + 1 })) };
    });
  };

  const updateStep = (stepId: string, patch: Partial<RunStep>) => {
    mutateTurn((turn) => ({ ...turn, steps: turn.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step) }));
  };

  const deleteStep = (stepId: string) => {
    if (!selectedRun) return;
    const snapshot = selectedRun;
    const target = selectedTurn?.steps.find((step) => step.id === stepId);
    mutateTurn((turn) => ({ ...turn, steps: turn.steps.filter((step) => step.id !== stepId).map((step, index) => ({ ...step, order: index + 1 })) }));
    notify("Step 已删除");
    pushUndo(`已删除 ${target?.label || target?.id || "Step"}`, () => setRuns((items) => items.map((item) => item.id === snapshot.id ? snapshot : item)));
  };

  const deleteSteps = (stepIds: string[]) => {
    if (!selectedRun || !stepIds.length) return;
    const snapshot = selectedRun;
    mutateTurn((turn) => ({ ...turn, steps: turn.steps.filter((step) => !stepIds.includes(step.id)).map((step, index) => ({ ...step, order: index + 1 })) }));
    notify(`${stepIds.length} 个 Step 已删除`);
    pushUndo(`已删除 ${stepIds.length} 个 Step`, () => setRuns((items) => items.map((item) => item.id === snapshot.id ? snapshot : item)));
  };

  const uploadArtifact = async (file: File, step: RunStep, role: EvidenceRef["role"] = "screenshot") => {
    if (!selectedRun || !selectedTurn) return;
    // Evidence is written into the Run's own directory so archiving that folder
    // takes the screenshots and snapshots with it.
    const artifact = await apiSaveRunEvidence(selectedRun.id, file, role);
    mutateTurn((turn) => ({
      ...turn,
      steps: turn.steps.some((item) => item.id === step.id)
        ? turn.steps.map((item) => item.id === step.id ? { ...item, evidence: [...item.evidence, artifact] } : item)
        : [...turn.steps, { ...step, evidence: [...step.evidence, artifact] }],
    }));
    notify("证据已关联到当前 Step");
  };

  const captureScreen = async (step: RunStep, target: ScreenshotTarget) => {
    try {
      notify(`正在由 Windows 后端截取：${target.label}`, "info");
      const response = await fetch("/api/local/evidence/screenshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetType: target.type, targetId: target.id }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      const capturedLabel = decodeURIComponent(response.headers.get("x-tracelab-target") ?? encodeURIComponent(target.label));
      await uploadArtifact(new File([blob], `screenshot_${Date.now()}.png`, { type: "image/png" }), step);
      updateStep(step.id, {
        status: "success",
        content: `Windows 后端截取 ${capturedLabel}`,
        resultSummary: `${capturedLabel} · ${Math.ceil(blob.size / 1024)} KB`,
        evidenceCapture: { type: "screenshot", capturedAt: new Date().toISOString(), phase: "manual", target: { ...target, label: capturedLabel } },
      });
    } catch (error) {
      updateStep(step.id, { status: "failed", resultSummary: error instanceof Error ? error.message : "截屏失败" });
      notify(error instanceof Error ? error.message : "截屏失败", "error");
    }
  };


  const captureSnapshot = async (step: RunStep, requestedRoots?: CaptureRoot[]) => {
    if (!selectedRun || !selectedTurn) return;
    try {
      let roots = (requestedRoots ?? selectedRun.captureConfig?.roots ?? selectedRun.fixtureDeployment?.captureRoots ?? []).filter((root) => root.enabled);
      if (!roots.length && cases.find((item) => item.id === selectedRun.caseId)?.source) {
        notify("正在根据 Case.json 初始化默认采样目录…", "info");
        roots = await initializeCase();
      }
      if (!roots.length) throw new Error("Case 没有可解析的默认目录；请在“管理采样目录”中添加 Windows 绝对路径。");
      notify(`Windows 后端正在采样 ${roots.length} 个目录…`, "info");
      const snapshotResponse = await fetch("/api/local/evidence/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: selectedRun.id, turnId: selectedTurn.id, stepId: step.id, roots }),
      });
      if (!snapshotResponse.ok) throw new Error(await responseError(snapshotResponse));
      const { snapshots } = await snapshotResponse.json() as { snapshots: FileSnapshot[] };
      const storedSnapshots = await apiRunSnapshots(selectedRun.id);
      const summaries: string[] = [];
      for (const snapshot of snapshots) {
        // Each snapshot stores the directory's full absolute state (entries with
        // hashes), so it always stands on its own. We diff against the EARLIEST
        // snapshot of this root in the run — a stable baseline that survives
        // deletion of any later sample and auto-promotes if the baseline itself
        // is removed — giving a cumulative "net change vs baseline" view.
        const baseline = storedSnapshots
          .filter((item) => item.runId === selectedRun.id && (item.rootId === snapshot.rootId || item.rootPath === snapshot.rootPath) && item.id !== snapshot.id)
          .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))[0];
        if (baseline) {
          snapshot.previousSnapshotId = baseline.id;
          snapshot.changes = diffSnapshots(baseline, snapshot);
        }
        await apiSaveRunSnapshots(selectedRun.id, [snapshot]);
        await uploadArtifact(new File([JSON.stringify(snapshot, null, 2)], `${snapshot.id}.json`, { type: "application/json" }), step, "file_snapshot");
        if (baseline) {
          const changeSet = { specVersion: "0.4.0", runId: selectedRun.id, turnId: selectedTurn.id, stepId: step.id, rootId: snapshot.rootId, baseline: "run_root_earliest", fromSnapshotId: baseline.id, toSnapshotId: snapshot.id, changes: snapshot.changes };
          await uploadArtifact(new File([JSON.stringify(changeSet, null, 2)], `diff_${baseline.id}_${snapshot.id}.json`, { type: "application/json" }), step, "diff");
        }
        const changeSummary = baseline
          ? `对比基线（${formatDate(baseline.capturedAt)}）：新增 ${snapshot.changes?.filter((item) => item.operation === "create").length ?? 0} · 改动 ${snapshot.changes?.filter((item) => item.operation === "modify").length ?? 0} · 删除 ${snapshot.changes?.filter((item) => item.operation === "delete").length ?? 0}`
          : "首次采样（基线）";
        summaries.push(`${snapshot.rootName}：现有 ${snapshot.fileCount} 个文件（绝对快照）· ${changeSummary}${snapshot.truncated ? "，已达采样上限" : ""}`);
      }
      updateStep(step.id, {
        status: "success",
        content: `Windows 后端同时采样：${roots.map((root) => root.label).join("、")}`,
        resultSummary: summaries.join("\n"),
        evidenceCapture: { type: "directory_snapshot", capturedAt: new Date().toISOString(), phase: step.evidenceCapture?.phase ?? "manual", rootIds: roots.map((root) => root.id) },
      });
    } catch (error) {
      updateStep(step.id, { status: "failed", resultSummary: error instanceof Error ? error.message : "目录采样失败" });
      notify(error instanceof Error ? error.message : "目录采样失败", "error");
    }
  };

  const evidenceStep = (type: "directory_snapshot" | "screenshot" | "upload", roots: CaptureRoot[] = []) => {
    if (!selectedTurn) return undefined;
    const step = blankStep(nextSequentialId("step", selectedTurn.steps.map((item) => item.id)), selectedTurn.steps.length + 1, "evidence_collection");
    const previousCaptures = selectedTurn.steps.filter((item) => item.evidenceCapture?.type === type).length;
    const phase = type === "directory_snapshot" ? previousCaptures ? "after" : "baseline" : "manual";
    step.label = type === "directory_snapshot" ? phase === "baseline" ? "目录基线采样" : "目录复采与 Diff" : type === "screenshot" ? "Windows 截屏采集" : "上传截屏证据";
    step.observationBasis = type === "upload" ? "operator_inference" : "system_ui";
    step.certainty = "exact";
    step.content = type === "directory_snapshot" ? `待采样：${roots.map((root) => root.label).join("、") || "已启用目录"}` : "证据采集中";
    step.evidenceCapture = { type, capturedAt: new Date().toISOString(), phase, rootIds: roots.map((root) => root.id) };
    mutateTurn((turn) => ({ ...turn, steps: [...turn.steps, step] }));
    return step;
  };

  const saveSettings = async (next: WorkbenchConfigState) => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseLibraryPath: next.caseLibraryPath, workingRoot: next.workingRoot, runsRoot: next.runsRoot ?? "" }) });
      if (!response.ok) throw new Error(await responseError(response));
      const loaded = await response.json() as { config: WorkbenchConfigState; configPath: string; resolvedCaseLibraryPath: string; resolvedWorkingRoot: string };
      setSettings({ ...loaded.config, configPath: loaded.configPath, resolvedCaseLibraryPath: loaded.resolvedCaseLibraryPath, resolvedWorkingRoot: loaded.resolvedWorkingRoot });
      setSettingsOpen(false);
      notify("配置已保存；重启前端后重新同步 Case 库");
    } catch (error) {
      notify(error instanceof Error ? error.message : "配置保存失败", "error");
    } finally { setSaving(false); }
  };

  const initializeCase = async (): Promise<CaptureRoot[]> => {
    if (!selectedRun) return [];
    const runId = selectedRun.id;
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: selectedRun.caseId }) });
      if (!response.ok) throw new Error(await responseError(response));
      const { deployment, captureRoots, intranet: startedIntranet } = await response.json() as { deployment: Record<string, string>; captureRoots: CaptureRoot[]; intranet?: IntranetStatus };
      // 需要内网的 Case 由后端在部署前顺手把本 Case 的门户拉起来，地址直接写进
      // fixture，所以这里不必再要求操作员记得"先启动服务再创建目录"。
      if (startedIntranet) setIntranet(startedIntranet);
      // Deploying runs a PowerShell script and takes seconds. Rebuild from the
      // Run as it stands NOW rather than the copy captured before the wait, or
      // anything the operator typed meanwhile is written back over.
      const latest = runsRef.current.find((item) => item.id === runId) ?? selectedRun;
      const customRoots = latest.captureConfig?.roots.filter((root) => root.source === "custom") ?? [];
      await saveRun({ ...latest, fixtureDeployment: { deploymentId: deployment.deployment_id, deploymentPath: deployment.deployment_path, workspacePath: deployment.workspace_path, captureRoots, initializedAt: new Date().toISOString(), intranetBaseUrl: startedIntranet?.baseUrl, caseId: latest.caseId }, captureConfig: { ...latest.captureConfig, roots: [...captureRoots, ...customRoots] } }, startedIntranet ? `Case 已初始化；内网门户 ${startedIntranet.baseUrl} 已写入 fixture` : "Case 已初始化；采样目录已从“文件与沙箱”自动带入");
      return captureRoots;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Case 初始化失败", "error");
      return [];
    } finally { setSaving(false); }
  };

  const destroyCase = async () => {
    if (!selectedRun?.fixtureDeployment?.deploymentPath || selectedRun.fixtureDeployment.destroyedAt) return;
    const runId = selectedRun.id;
    setSaving(true);
    try {
      const response = await fetch("/api/local/cases/destroy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deploymentPath: selectedRun.fixtureDeployment.deploymentPath }) });
      if (!response.ok) throw new Error(await responseError(response));
      const { destruction } = await response.json() as { destruction: Record<string, string> };
      // Same reason as initializeCase: the destroy script takes seconds, so save
      // the Run as it stands now, not the copy captured before the wait.
      const latest = runsRef.current.find((item) => item.id === runId) ?? selectedRun;
      const deployment = latest.fixtureDeployment ?? selectedRun.fixtureDeployment;
      await saveRun({ ...latest, fixtureDeployment: { ...deployment, evidencePath: destruction.evidence_path, destroyedAt: new Date().toISOString() } }, "Case 已销毁，最终 diff 与证据已保留");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Case 销毁失败", "error");
    } finally { setSaving(false); }
  };

  const saveCatalog = async (patch: CatalogPatch) => {
    setSaving(true);
    try {
      const response = await fetch("/api/local/catalog", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ systems: patch }) });
      if (!response.ok) throw new Error(await responseError(response));
      const { repointed } = await response.json() as { repointed: number };
      setCatalog(await apiCatalog());
      notify(repointed ? `分类已保存；${repointed} 个 Case 版本的风险小类名同步更新` : "分类已保存");
    } finally { setSaving(false); }
  };

  /**
   * 启动 / 停止当前 Run 所属 Case 的内网门户。
   *
   * 门户以 Case 为单位：同一个 Case 的所有 Run 共用一个（站点只读，内容逐字节相
   * 同），不同 Case 各起各的，端口自动错开。所以这里必须带上 caseId。
   */
  const toggleIntranet = async (start: boolean) => {
    const caseId = selectedRun?.caseId;
    if (!caseId) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/local/intranet/${start ? "start" : "stop"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const next = await response.json() as IntranetStatus;
      setIntranet(next);
      // 手工停掉就是不想让它跑，别让下一次自动修复又把它拉起来。
      if (!start) autoStartedIntranet.current.add(caseId);
      const caseTitle = cases.find((item) => item.id === caseId)?.title ?? caseId;
      notify(start ? `${caseTitle} 的内网门户已启动：${next.baseUrl}` : `${caseTitle} 的内网门户已停止`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "内网模拟服务操作失败", "error");
    } finally { setSaving(false); }
  };

  /**
   * 选中的 Run 换了 Case，就换一份门户状态。切回标签页时也重新读一次：门户是
   * 独立进程，可能在别处被停掉或被别的工作台启动。
   */
  /** Cases whose portal this page has already tried to start on its own. */
  const autoStartedIntranet = useRef(new Set<string>());

  const refreshIntranet = useEffectEvent(async () => {
    const caseId = selectedRunRef.current?.caseId ?? "";
    let next = await apiIntranetStatus(caseId).catch(() => IDLE_INTRANET);
    // 本 Case 需要内网却没门户在跑，就直接拉起来。门户是独立进程，会跟着开发服务器
    // 重启一起没掉，而部署好的 fixture 里已经写死了它的地址——等操作员自己发现
    // "Agent 连不上内网"时，那一轮往往已经废了。端口按 Case 记住，拉起来还是原来那个。
    // 一个 Case 在本页面里只自动拉一次。自动启动失败或门户又挂了，就把决定权交回
    // 状态条上的按钮——否则每次切标签页都再拉一个，端口会一路涨上去。
    if (!next.running && caseId && !autoStartedIntranet.current.has(caseId) && needsIntranet(cases.find((item) => item.id === caseId))) {
      autoStartedIntranet.current.add(caseId);
      try {
        const response = await fetch("/api/local/intranet/start", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId }),
        });
        if (response.ok) {
          const started = await response.json() as IntranetStatus & { started?: boolean };
          if (started.started && started.baseUrl) notify(`已自动启动本 Case 的内网门户：${started.baseUrl}`, "info");
          next = started;
        }
      } catch { /* 起不来时保留"未运行"，状态条上照样看得见 */ }
    }
    if ((selectedRunRef.current?.caseId ?? "") !== caseId) return;
    setIntranet(next);
  });
  useEffect(() => { void refreshIntranet(); }, [selectedRun?.caseId, loading]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === "visible") void refreshIntranet(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => { window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", recheck); };
  }, []);

  const saveCaseIdentity = async (item: TestCase, identity: { title: string; titleEn: string; globalId: string }) => {
    const response = await fetch("/api/local/cases/identity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: item.id, ...identity }) });
    if (!response.ok) throw new Error(await responseError(response));
    setCases((items) => items.map((candidate) => candidate.source?.familyId && candidate.source.familyId === item.source?.familyId
      ? { ...candidate, title: identity.title, titleEn: identity.titleEn, globalId: identity.globalId }
      : candidate));
    notify("Case 名称与全局 ID 已更新");
  };

  const acceptImportedTurn = async (imported: TestRun, turnIndex: number, appendNew = false) => {
    if (!selectedRun) return;
    const sourceTurn = imported.turns[turnIndex];
    if (!sourceTurn) throw new Error("所选 Turn 不存在");
    // 导入第二轮日志时不必先手工建一个空 Turn 再来合并：直接追加为新 Turn。
    const reuseTurn = appendNew ? undefined : selectedTurn;
    const targetTurn = reuseTurn ?? {
      id: nextSequentialId("turn", selectedRun.turns.map((turn) => turn.id)), order: selectedRun.turns.length + 1,
      caseTurnId: cases.find((item) => item.id === selectedRun.caseId)?.turns[selectedRun.turns.length]?.id,
      prompt: "", response: "", pathMatch: "not_evaluated" as const, unexpectedPathSummary: "", steps: [], annotations: [], summaries: [],
    };
    const firstImported = targetTurn.steps.findIndex((step) => Boolean(step.importedSource));
    const lastImported = targetTurn.steps.reduce((last, step, index) => step.importedSource ? index : last, -1);
    const prefix = firstImported >= 0 ? targetTurn.steps.slice(0, firstImported) : targetTurn.steps;
    const suffix = lastImported >= 0 ? targetTurn.steps.slice(lastImported + 1) : [];
    const usedIds = [...prefix, ...suffix].map((step) => step.id);
    const importedSteps = sourceTurn.steps.map((step) => {
      const id = nextSequentialId("step", usedIds);
      usedIds.push(id);
      return { ...step, id };
    });
    const mergedTurn: RunTurn = {
      ...targetTurn,
      prompt: sourceTurn.prompt || targetTurn.prompt,
      response: sourceTurn.response || targetTurn.response,
      completedAt: sourceTurn.completedAt ?? targetTurn.completedAt,
      steps: [...prefix, ...importedSteps, ...suffix].map((step, index) => ({ ...step, order: index + 1 })),
    };
    const turns = reuseTurn
      ? selectedRun.turns.map((turn) => turn.id === targetTurn.id ? mergedTurn : turn)
      : [...selectedRun.turns, mergedTurn];
    const updated = { ...selectedRun, agentId: imported.agentId, model: imported.model || selectedRun.model, turns, importProvenance: imported.importProvenance, updatedAt: new Date().toISOString() };
    await saveRun(updated, `日志 Turn ${turnIndex + 1} 已合并到 ${targetTurn.id}；原有采样证据已保留`);
    setSelectedTurnId(targetTurn.id);
    setImportOpen(false);
  };

  const completeTurn = async () => {
    if (!selectedRun || !selectedTurn) return;
    const updatedTurn = { ...selectedTurn, completedAt: new Date().toISOString() };
    const updatedRun = { ...selectedRun, turns: selectedRun.turns.map((turn) => turn.id === selectedTurn.id ? updatedTurn : turn) };
    await saveRun(updatedRun, "本轮记录已保存");
  };

  // One 垃圾箱 for both storage kinds: on-disk Case directories and soft-deleted
  // hand-made Cases, newest first.
  const allCaseTrash: CaseTrashEntry[] = [
    ...caseTrash.map((entry) => ({ ...entry, storageKind: "library" as const })),
    ...customTrash.map((item) => ({
      id: `custom:${item.id}`,
      storageKind: "custom" as const,
      scope: "family" as const,
      deletedAt: item.deletedAt ?? item.updatedAt,
      familyId: item.id,
      title: item.title,
      originalRelativePath: "自建 Case（不在 Case Library 目录中）",
      sourceCaseId: item.id,
      runCount: runs.filter((run) => !run.deletedAt && run.caseId === item.id).length,
      affectedVersions: 1,
      wasPreferred: false,
    })),
  ].sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));

  const visibleRuns = runs.filter((run) => !run.deletedAt);
  const activeRuns = visibleRuns.filter((run) => run.status !== "completed").length;
  const evidenceCount = visibleRuns.reduce((sum, run) => sum + run.turns.reduce((turnSum, turn) => turnSum + turn.steps.reduce((stepSum, step) => stepSum + step.evidence.length, 0), 0), 0);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><ShieldCheck size={18} /></div>
          <div><strong>TraceLab</strong><span>AETF · v0.5.1</span></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单"><X size={18} /></button>
        </div>
        <nav className="nav-stack" aria-label="主导航">
          <NavButton active={view === "dashboard"} icon={<LayoutDashboard size={17} />} label="概览" onClick={() => setView("dashboard")} />
          <NavButton active={view === "cases"} icon={<ClipboardList size={17} />} label="Case 管理" badge={caseFamilyCount(cases)} onClick={() => setView("cases")} />
          <NavButton active={view === "entry"} icon={<FileClock size={17} />} label="手工录入" badge={activeRuns || undefined} onClick={() => setView("entry")} />
          <NavButton active={view === "review"} icon={<ShieldAlert size={17} />} label="手工判定" badge={visibleRuns.filter((run) => run.outcome === "not_evaluated").length || undefined} onClick={() => setView("review")} />
          <NavButton active={view === "results"} icon={<BarChart3 size={17} />} label="结果展示" onClick={() => setView("results")} />
        </nav>
        <div className="sidebar-section-label">被测 Agent<small>{runFilters.agentId ? "已过滤" : "点击过滤"}</small></div>
        <div className="agent-mini-list">
          {agents.map((agent) => (
            // Clicking an Agent filters every Run list to that Agent; clicking the
            // active one clears the filter. This used to only jump to 结果展示,
            // which looked like nothing happened when no Run was selected.
            <button
              key={agent.id}
              className={`agent-mini${runFilters.agentId === agent.id ? " active" : ""}`}
              title={runFilters.agentId === agent.id ? `取消只看 ${agent.name} 的 Run` : `只看 ${agent.name} 的 Run`}
              aria-pressed={runFilters.agentId === agent.id}
              onClick={() => {
                const next = runFilters.agentId === agent.id ? "" : agent.id;
                setRunFilters({ ...runFilters, agentId: next });
                if (view !== "entry" && view !== "review" && view !== "results") setView("entry");
                const first = visibleRuns.find((run) => !next || run.agentId === next);
                if (first) { setSelectedRunId(first.id); setSelectedTurnId(first.turns[0]?.id ?? ""); }
              }}
            >
              <span className="agent-dot" style={{ background: agent.accent }} />
              <span>{agent.name}</span>
              <small>{visibleRuns.filter((run) => run.agentId === agent.id).length}</small>
            </button>
          ))}
        </div>
        <div className="sidebar-footer"><Database size={15} /><span>本地预览数据已持久保存</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={19} /></button>
          <div className="crumbs"><span>Office Agent Safety</span><b>/</b><strong>{view === "dashboard" ? "概览" : view === "cases" ? "Case 管理" : view === "entry" ? "手工录入" : view === "review" ? "手工判定" : "结果展示"}</strong></div>
          <div className="top-actions">
            {saving && <span className="saving"><Loader2 size={14} className="spin" />保存中</span>}
            <UndoMenu stack={undoStack} onUndo={(entry) => void runUndo(entry)} onClear={() => setUndoStack([])} />
            <label className="autosave-toggle" title="开启后，正在编辑的 Case 和 Run 会在停止输入约 1 秒后自动写入存储；关闭后请使用页面内的保存按钮。"><input type="checkbox" checked={autoSave} onChange={(event) => setAutoSavePreference(event.target.checked)} /><span>实时保存</span></label>
            <button className="secondary-button" title="调整字号、Case 库路径和工作目录位置。" onClick={() => setSettingsOpen(true)}><Settings size={15} />设置</button>
            <button className="secondary-button" title="将当前 Agent、Case 与 Run 数据导出为一个 JSON 文件，便于备份或复核。" onClick={() => downloadJson("tracelab-export.json", { specVersion: "0.4.0", agents, cases, runs })}><Download size={15} />导出</button>
            <button className="primary-button" title="选择被测 Agent 与 Case 版本，确认后创建一个新的 Run。" onClick={openCreateRun}><Plus size={16} />新建 Run</button>
          </div>
        </header>

        {loading ? <LoadingState /> : (
          <div className="page-content">
            {view === "dashboard" && <Dashboard agents={agents} cases={cases} runs={visibleRuns} evidenceCount={evidenceCount} catalog={catalog} onSaveCatalog={saveCatalog} onCreateRun={openCreateRun} onNavigate={setView} />}
            {view === "cases" && selectedCase && <CaseManager key={selectedCase.id} cases={cases} runs={visibleRuns} trashEntries={allCaseTrash} caseLibraryPath={settings.resolvedCaseLibraryPath ?? ""} selected={selectedCase} autoSave={autoSave} onSelect={setSelectedCaseId} onSave={saveCase} onFork={forkCase} onPromote={promoteCase} onRename={renameCase} onMove={moveCase} onLifecycle={changeCaseLifecycle} onOpenRun={(id) => { setSelectedRunId(id); setView("entry"); }} onDelete={deleteCase} onBatchDelete={batchDeleteCases} onRestoreTrash={restoreCaseTrash} onPurgeTrash={purgeCaseTrash} onEmptyTrash={emptyCaseTrash} onEditForkNote={editForkNote} onSaveIdentity={saveCaseIdentity} onCreate={() => {
              const now = new Date().toISOString();
              const item: TestCase = { id: `case_${Date.now()}`, version: "1.0.0", title: "未命名 Case", description: "", readme: blankCaseReadme(), riskCategory: "未分类安全风险", roots: [], turns: [], updatedAt: now };
              setCases((all) => [item, ...all]); setSelectedCaseId(item.id);
            }} />}
            {view === "entry" && <ManualEntry agents={agents} cases={cases} runs={visibleRuns} trashedRuns={runs.filter((run) => Boolean(run.deletedAt))} selectedRun={selectedRun?.deletedAt ? undefined : selectedRun} selectedTurn={selectedTurn} onSelectRun={(id) => { setSelectedRunId(id); const run = runs.find((item) => item.id === id); setSelectedTurnId(run?.turns[0]?.id ?? ""); }} onSelectTurn={setSelectedTurnId} onMutateRun={mutateRun} onMutateTurn={mutateTurn} onAddTurn={addTurn} onDeleteTurn={deleteTurn} onDeleteTurns={deleteTurns} onAddStep={addStep} onInsertStep={insertStep} onMoveStep={moveStep} onUpdateStep={updateStep} onDeleteStep={deleteStep} onDeleteSteps={deleteSteps} onCaptureScreen={(step) => setScreenCaptureIntent({ step })} onCaptureSnapshot={captureSnapshot} onUploadArtifact={uploadArtifact} onCaptureTurnScreen={() => setScreenCaptureIntent({})} onCaptureTurnSnapshot={(roots) => { const step = evidenceStep("directory_snapshot", roots); if (step) void captureSnapshot(step, roots); }} onCaptureRootsChange={(roots) => mutateRun((run) => ({ ...run, captureConfig: { ...run.captureConfig, roots } }))} onUploadTurnArtifact={(file) => { const step = evidenceStep("upload"); if (step) { void uploadArtifact(file, step); updateStep(step.id, { content: `人工上传：${file.name}`, resultSummary: `${file.type || "image"} · ${Math.ceil(file.size / 1024)} KB` }); } }} onInitializeCase={initializeCase} onDestroyCase={destroyCase} onSave={() => selectedRun && saveRun(selectedRun)} onCompleteTurn={completeTurn} onCreateRun={openCreateRun} onImportTurn={() => setImportOpen(true)} onTrashRun={() => selectedRun && void trashRun(selectedRun)} onRestoreRun={(run) => void restoreRun(run)} onDeleteRun={(run) => void permanentlyDeleteRun(run)} onBatchDeleteRuns={(ids) => void batchTrashRuns(ids)} runsRoot={runsRoot} unreadableRunDirs={unreadableRunDirs} onRescanRuns={() => void rescanRuns()} filters={runFilters} onFilters={setRunFilters} intranet={intranet} onToggleIntranet={(start) => void toggleIntranet(start)} openElsewhere={Boolean(selectedRun && runsOpenElsewhere.has(selectedRun.id))} />}
            {/* Keyed on the Run id ONLY. Including updatedAt remounted the whole
                review pane on every save, which closed open dropdowns and reset
                the expanded Case groups mid-interaction. */}
            {view === "review" && <ManualReview key={selectedRun?.id ?? "empty"} agents={agents} cases={cases} runs={visibleRuns} selectedRun={selectedRun?.deletedAt ? undefined : selectedRun} onSelectRun={setSelectedRunId} onChange={mutateRun} onSave={saveRun} filters={runFilters} onFilters={setRunFilters} />}
            {view === "results" && <ResultsDashboard agents={agents} cases={cases} runs={visibleRuns} filters={runFilters} onFilters={setRunFilters} onOpenRun={(id) => { setSelectedRunId(id); setView("review"); }} />}
          </div>
        )}
      </main>
      {settingsOpen && <SettingsDialog value={settings} fontScale={fontScale} onFontScaleChange={setFontScalePreference} onChange={setSettings} onClose={() => setSettingsOpen(false)} onSave={() => saveSettings(settings)} />}
      {newRunOpen && <NewRunDialog agents={agents} cases={cases} runs={runs} defaultAgentId={defaultRunAgentId} defaultCaseId={defaultRunCaseId} onClose={() => setNewRunOpen(false)} onCreate={createRun} />}
      {importOpen && selectedRun && <AgentLogImportDialog targetRun={selectedRun} targetTurn={selectedTurn} onClose={() => setImportOpen(false)} onImport={acceptImportedTurn} />}
      {screenCaptureIntent && <ScreenCaptureDialog onClose={() => setScreenCaptureIntent(undefined)} onCapture={async (target) => { const step = screenCaptureIntent.step ?? evidenceStep("screenshot"); setScreenCaptureIntent(undefined); if (step) await captureScreen(step, target); }} />}
      {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <CheckCircle2 size={17} /> : toast.tone === "error" ? <CircleAlert size={17} /> : <Loader2 size={17} className="spin" />}{toast.text}</div>}
      {undoAction && <div className="toast undo-toast"><span>{undoAction.label}</span><button type="button" className="text-button" onClick={() => { if (undoTimer.current) clearTimeout(undoTimer.current); void runUndo(undoAction); }}>撤回</button></div>}
    </div>
  );
}

/**
 * Persistent 撤回 control. Clicking undoes the most recent reversible action;
 * the caret opens the recent history so an older step can be picked out
 * directly. Ctrl/Cmd+Z does the same as a plain click.
 */
function UndoMenu({ stack, onUndo, onClear }: { stack: UndoEntry[]; onUndo: (entry: UndoEntry) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const latest = stack[0];
  // No effect needed to close on an empty stack — the panel is only rendered
  // while there is something to undo, and both actions close it explicitly.
  return <div className="undo-menu">
    <button
      type="button"
      className="secondary-button undo-button"
      disabled={!latest}
      title={latest ? `撤回：${latest.label}（Ctrl/⌘ + Z）` : "暂时没有可撤回的操作"}
      onClick={() => latest && onUndo(latest)}
    ><Undo2 size={15} />撤回{stack.length > 1 ? <em>{stack.length}</em> : null}</button>
    <button type="button" className="undo-caret" disabled={!latest} aria-label="查看可撤回的操作" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ChevronDown size={13} className={open ? "rotated" : ""} /></button>
    {open && latest && <div className="undo-history" role="menu">
      <div className="undo-history-head"><strong>最近可撤回的操作</strong><button type="button" className="text-button" onClick={() => { onClear(); setOpen(false); }}>清空列表</button></div>
      {stack.map((entry, index) => <button type="button" role="menuitem" key={entry.id} onClick={() => { onUndo(entry); setOpen(false); }}>
        <span>{index === 0 ? "最近" : `#${index + 1}`}</span><strong>{entry.label}</strong><small>{formatDate(entry.at)}</small>
      </button>)}
      <p>撤回较早的一步不会自动回滚它之后的操作，请按需依次撤回。</p>
    </div>}
  </div>;
}

function SettingsDialog({ value, fontScale, onFontScaleChange, onChange, onClose, onSave }: { value: WorkbenchConfigState; fontScale: FontScale; onFontScaleChange: (value: FontScale) => void; onChange: (value: WorkbenchConfigState) => void; onClose: () => void; onSave: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className="modal-card settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">External configuration</span><h2 id="settings-title">工作台设置</h2></div><button className="icon-button" title="关闭设置，不会撤销已经即时生效的字号选择。" onClick={onClose}><X size={18} /></button></div><div className="settings-fields"><label>界面字号<select value={fontScale} onChange={(event) => onFontScaleChange(event.target.value as FontScale)}><option value="standard">标准</option><option value="comfortable">舒适（默认）</option><option value="large">大字号</option></select><small>字号选择立即生效，并只保存在当前设备。</small></label><label>Case 库路径<input value={value.caseLibraryPath} onChange={(event) => onChange({ ...value, caseLibraryPath: event.target.value })} /><small>当前解析：{value.resolvedCaseLibraryPath}</small></label><label>生成工作目录<input value={value.workingRoot} onChange={(event) => onChange({ ...value, workingRoot: event.target.value })} /><small>当前解析：{value.resolvedWorkingRoot}</small></label><label>Run 存放目录<input value={value.runsRoot ?? ""} placeholder="留空则使用 工作目录\runs" onChange={(event) => onChange({ ...value, runsRoot: event.target.value })} /><small>当前解析：{value.resolvedRunsRoot} · 每个 Run 一个目录（run.json + snapshots + evidence），可整体打包搬走，放回后在“手工录入”点重新扫描即可恢复。</small></label><div className="config-location"><FileJson size={15} /><span>配置文件</span><code>{value.configPath}</code></div><p><CircleAlert size={14} />工作目录不能含 test 或 bench。保存配置后需重启前端，Case 索引才会从新位置重新生成。</p></div><div className="modal-actions"><button className="secondary-button" title="关闭对话框；尚未保存的路径改动不会写入配置文件。" onClick={onClose}>取消</button><button className="primary-button" title="只保存 Case 库路径和生成工作目录到工作台配置；不会保存或完成当前 Run。" onClick={onSave}><Save size={15} />保存路径配置</button></div></div></div>;
}

function CaptureRootsDialog({ roots, onClose, onSave }: { roots: CaptureRoot[]; onClose: () => void; onSave: (roots: CaptureRoot[]) => void }) {
  const [draft, setDraft] = useState(roots);
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const addRoot = () => {
    const cleanPath = path.trim();
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cleanPath)) {
      setError("请输入 Windows 绝对路径，例如 C:\\Data\\Workshop 或 \\\\server\\share。");
      return;
    }
    if (draft.some((root) => root.path.toLocaleLowerCase() === cleanPath.toLocaleLowerCase())) {
      setError("这个路径已经在采样列表中。");
      return;
    }
    setDraft((items) => [...items, {
      id: `custom:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      label: label.trim() || cleanPath.split(/[\\/]/).filter(Boolean).at(-1) || "自定义目录",
      path: cleanPath,
      enabled: true,
      role: "other",
      contentPolicy: "hash_only",
      source: "custom",
    }]);
    setLabel(""); setPath(""); setError("");
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className="modal-card capture-roots-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-roots-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Windows backend · multi-root</span><h2 id="capture-roots-title">管理采样目录</h2><p>Case 初始化后的“文件与沙箱”路径会自动列出；一次采样会保存所有已启用目录。</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <div className="capture-root-list">{draft.length ? draft.map((root) => <div className={`capture-root-row ${root.enabled ? "enabled" : ""}`} key={root.id}><label className="root-enabled"><input type="checkbox" checked={root.enabled} onChange={(event) => setDraft((items) => items.map((item) => item.id === root.id ? { ...item, enabled: event.target.checked } : item))} /><span /></label><div><strong>{root.label}</strong><code>{root.path}</code><small>{root.source === "case_deployment" ? `来自 Case · ${root.rootId}` : "自定义 Windows 路径"}</small></div><select aria-label={`${root.label} 采样策略`} value={root.contentPolicy} onChange={(event) => setDraft((items) => items.map((item) => item.id === root.id ? { ...item, contentPolicy: event.target.value as CaptureRoot["contentPolicy"] } : item))}><option value="hash_only">元数据 + Hash</option><option value="metadata_only">仅元数据</option><option value="changed_files">变化检测</option><option value="full">完整清单</option></select><button className="icon-button danger" title={root.source === "custom" ? "移除自定义路径" : "移除该目录（重新初始化 Case 时可恢复默认目录）"} onClick={() => setDraft((items) => items.filter((item) => item.id !== root.id))}><Trash2 size={15} /></button></div>) : <EmptyInline text="尚未配置采样目录" />}</div>
    <div className="capture-root-add"><label>显示名称<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：Workshop" /></label><label>Windows 绝对路径<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\\Users\\...\\Workshop" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRoot(); } }} /></label><button className="secondary-button" onClick={addRoot}><Plus size={15} />添加路径</button></div>{error && <div className="import-error"><CircleAlert size={15} />{error}</div>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onSave(draft)}><Save size={15} />保存 {draft.filter((root) => root.enabled).length} 个采样目录</button></div></div></div>;
}

type ScreenshotTargetsResponse = {
  windows: Array<{ id: string; label: string; title: string; processName: string; width: number; height: number }>;
  monitors: Array<{ id: string; label: string; primary: boolean; width: number; height: number }>;
};

function ScreenCaptureDialog({ onClose, onCapture }: { onClose: () => void; onCapture: (target: ScreenshotTarget) => Promise<void> }) {
  const [targets, setTargets] = useState<ScreenshotTargetsResponse>();
  const [selected, setSelected] = useState<ScreenshotTarget>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const loadTargets = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/local/evidence/screenshot-targets", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const next = await response.json() as ScreenshotTargetsResponse;
      setTargets(next);
      const preferred = next.windows.find((item) => !/^(Program Manager|Windows 输入体验)$/i.test(item.title));
      if (preferred) setSelected({ type: "window", id: preferred.id, label: preferred.label });
      else if (next.monitors[0]) setSelected({ type: "monitor", id: next.monitors[0].id, label: next.monitors[0].label });
      else setSelected({ type: "desktop", id: "desktop", label: "Windows 桌面" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 Windows 窗口列表"); }
    finally { setBusy(false); }
  };
  // loadTargets reads the live Windows window list once when the dialog opens.
  useEffect(() => { const timer = window.setTimeout(() => { void loadTargets(); }, 0); return () => window.clearTimeout(timer); }, []);
  const windows = targets?.windows.filter((item) => !query.trim() || `${item.title} ${item.processName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card screen-capture-dialog" role="dialog" aria-modal="true" aria-labelledby="screen-capture-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Windows capture service</span><h2 id="screen-capture-title">选择要截取的准确目标</h2><p>截图发生在运行 TraceLab 后端的 Windows 电脑，而不是当前浏览器所在设备。</p></div><button className="icon-button" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <div className="capture-target-groups"><section><div className="capture-target-heading"><strong>桌面与显示器</strong><button className="text-button" disabled={busy} onClick={() => void loadTargets()}><FileSearch size={14} />刷新</button></div><div className="capture-target-grid"><button className={selected?.type === "desktop" ? "active" : ""} onClick={() => setSelected({ type: "desktop", id: "desktop", label: "Windows 桌面" })}><Globe2 size={17} /><span><strong>整个 Windows 桌面</strong><small>包含所有显示器</small></span></button>{targets?.monitors.map((monitor) => <button key={monitor.id} className={selected?.type === "monitor" && selected.id === monitor.id ? "active" : ""} onClick={() => setSelected({ type: "monitor", id: monitor.id, label: monitor.label })}><HardDrive size={17} /><span><strong>{monitor.primary ? "主显示器" : monitor.label}</strong><small>{monitor.width} × {monitor.height}</small></span></button>)}</div></section><section><div className="capture-target-heading"><strong>可见窗口</strong><label className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索窗口标题或进程" /></label></div><div className="capture-window-list">{windows.map((item) => <button key={item.id} className={selected?.type === "window" && selected.id === item.id ? "active" : ""} onClick={() => setSelected({ type: "window", id: item.id, label: item.label })}><span><strong>{item.title}</strong><small>{item.processName || "Windows"} · {item.width} × {item.height}</small></span><CheckCircle2 size={16} /></button>)}{!busy && !windows.length && <EmptyInline text="没有匹配的可见窗口" />}</div></section></div>
    {error && <div className="import-error"><CircleAlert size={15} />{error}</div>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !selected} onClick={async () => { if (!selected) return; setBusy(true); await onCapture(selected); }}>{busy ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}{busy ? "读取 Windows 窗口…" : `截取：${selected?.label ?? "目标"}`}</button></div></div></div>;
}

/**
 * When one Agent has more than one log adapter, this says which build to open
 * first. Qoder's international quota is exhausted, so every new Qoder Run is
 * recorded in QoderWorkCN — opening the 国内版 module saves a click, and the
 * 国际版 module stays one click away in the same grid.
 */
const PREFERRED_LOG_ADAPTER_BY_AGENT: Record<string, string> = { agent_qoder: "qodercn" };

function AgentLogImportDialog({ targetRun, targetTurn, onClose, onImport }: { targetRun: TestRun; targetTurn?: RunTurn; onClose: () => void; onImport: (run: TestRun, turnIndex: number, appendNew: boolean) => Promise<void> }) {
  const [discovery, setDiscovery] = useState<AgentLogDiscovery>();
  const [adapterId, setAdapterId] = useState("");
  const [sessionKey, setSessionKey] = useState("");
  const [preview, setPreview] = useState<TestRun>();
  const [turnIndex, setTurnIndex] = useState(0);
  // 录第二轮时目标不是当前 Turn 而是新的一轮。默认仍合并到当前 Turn：补录同一
  // 轮遗漏的 Step 是更常见的用法，追加新 Turn 只差一次点击。
  const [appendNew, setAppendNew] = useState(false);
  const nextTurnId = nextSequentialId("turn", targetRun.turns.map((turn) => turn.id));
  const [busy, setBusy] = useState(true);
  // A forced rescan running behind the operator, distinct from `busy`: the list
  // stays usable while it runs.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // What the operator has picked right now, readable from the background rescan
  // without making it a dependency of anything.
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const fetchDiscovery = async (force: boolean) => {
    const response = await fetch(`/api/local/agent-logs/discover${force ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    return await response.json() as AgentLogDiscovery;
  };
  // Default to the module that belongs to this Run's Agent, so importing a
  // WorkBuddy Run no longer starts on whichever adapter happened to be first.
  const defaultSelection = (next: AgentLogDiscovery) => {
    const own = next.adapters.filter((item) => item.agentId === targetRun.agentId);
    const preferred = PREFERRED_LOG_ADAPTER_BY_AGENT[targetRun.agentId];
    const firstAdapter = own.find((item) => item.id === preferred && item.sessionCount)?.id
      ?? own.find((item) => item.sessionCount)?.id
      ?? own.find((item) => item.id === preferred)?.id
      ?? own[0]?.id
      ?? next.adapters.find((item) => item.sessionCount)?.id ?? next.adapters[0]?.id ?? "";
    return { adapterId: firstAdapter, sessionKey: next.sessions.find((item) => item.adapterId === firstAdapter)?.key ?? "" };
  };
  const scan = async (force = false) => {
    setBusy(true); setError("");
    try {
      const next = await fetchDiscovery(force);
      setDiscovery(next);
      const selection = defaultSelection(next);
      setAdapterId(selection.adapterId); setSessionKey(selection.sessionKey);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "扫描失败"); }
    finally { setBusy(false); }
  };
  /**
   * 打开时先用缓存立刻出结果，再在后台强制重扫一次。
   *
   * 发现结果在开发服务器进程里是 stale-while-revalidate 的：Agent 刚跑完的那一
   * 轮往往要等到第二次打开对话框才出现，这正是"第一次点开是老的"的来源。这里
   * 把那次"第二次打开"提前到后台做掉，操作员不用再手工点重新扫描。
   */
  const refreshInBackground = async () => {
    setRefreshing(true);
    try {
      const next = await fetchDiscovery(true);
      setDiscovery(next);
      // 选择只在原来选中的会话确实消失时才改动，否则会把操作员刚选好的目标顶掉。
      if (!next.sessions.some((item) => item.key === sessionKeyRef.current)) {
        const selection = defaultSelection(next);
        setAdapterId(selection.adapterId); setSessionKey(selection.sessionKey);
      }
    } catch { /* 缓存结果还在屏幕上，后台刷新失败不打断操作 */ }
    finally { setRefreshing(false); }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => { void scan().then(refreshInBackground); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const sessions = discovery?.sessions.filter((item) => item.adapterId === adapterId) ?? [];
  const selected = sessions.find((item) => item.key === sessionKey);
  const chooseAdapter = (nextId: string) => { setAdapterId(nextId); setSessionKey(discovery?.sessions.find((item) => item.adapterId === nextId)?.key ?? ""); setPreview(undefined); setError(""); };
  const extract = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/local/agent-logs/extract", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapterId, sessionKey, caseId: targetRun.caseId }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { run: TestRun };
      if (!result.run.turns.length) throw new Error("该会话没有可导入的 Turn");
      setPreview(result.run); setTurnIndex(0);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "提取失败"); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className="modal-card agent-import-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-import-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Merge one logged turn into the active timeline</span><h2 id="agent-import-title">从日志导入一个 Turn</h2><p>目标：{targetRun.name || targetRun.id} / {targetTurn && !appendNew ? targetTurn.id : nextTurnId} · 已有 Evidence Step 会按原位置保留</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <div className="adapter-grid">{discovery?.adapters.map((adapter) => <button key={adapter.id} className={`${adapter.id === adapterId ? "active" : ""} ${adapter.status}`} onClick={() => chooseAdapter(adapter.id)}><span>{adapter.appName}</span><strong>{adapter.sessionCount}</strong><em>{adapter.status === "ready" ? "完整轨迹" : adapter.status === "fallback" ? "部分轨迹" : adapter.status === "error" ? "错误" : "未发现"}</em></button>)}</div>
    <div className="import-fields">{targetTurn && <div className="import-target-choice"><strong>导入到哪一轮</strong><div><button className={appendNew ? "" : "active"} onClick={() => setAppendNew(false)}>合并到当前 {targetTurn.id}<em>补录这一轮遗漏的 Step</em></button><button className={appendNew ? "active" : ""} onClick={() => setAppendNew(true)}>追加为新的 {nextTurnId}<em>录入同一个 Run 的下一轮对话</em></button></div></div>}<label>Agent 会话<select value={sessionKey} onChange={(event) => { setSessionKey(event.target.value); setPreview(undefined); }} disabled={!sessions.length}>{sessions.length ? sessions.map((session) => <option key={session.key} value={session.key}>{session.title} · {session.updatedAt ? formatDate(session.updatedAt) : "时间未知"}</option>) : <option value="">没有可导入会话</option>}</select></label>
      {selected && <div className={`session-preview ${selected.completeness}`}><div><Database size={17} /><strong>{selected.appName} · {selected.sourceKind}</strong><em>{selected.completeness}</em></div><code>{selected.sourcePath}</code><span>{selected.sizeBytes ? `${Math.ceil(selected.sizeBytes / 1024)} KB` : "数据库会话"} · {selected.nativeSessionId}</span>{selected.warnings.map((warning) => <p key={warning}><CircleAlert size={13} />{warning}</p>)}</div>}
      {preview && <div className="turn-import-picker"><strong>选择本次要导入的一个 Turn</strong>{preview.turns.map((turn, index) => <button key={turn.id} className={turnIndex === index ? "active" : ""} onClick={() => setTurnIndex(index)}><span>Turn {index + 1}</span><p>{turn.prompt || "源日志未保留 Prompt"}</p><em>{turn.steps.length} steps</em></button>)}</div>}
      {error && <div className="import-error"><CircleAlert size={15} />{error}</div>}
      {!busy && !discovery?.sessions.length && <div className="import-empty"><FileSearch size={23} /><strong>{discovery?.adapters.length ?? 0} 个适配器均已加载，但当前没有发现可导入会话</strong><span>请确认 Agent 已完成至少一个会话并重新扫描；Claude 与 Trae 会直接读取其本机持久会话源。</span></div>}
    </div><div className="modal-actions"><span className="import-scan-age">{discovery ? `扫描于 ${formatDate(discovery.discoveredAt)}${refreshing ? " · 正在后台重新扫描，稍后自动更新" : ""}` : ""}</span><button className="secondary-button" onClick={() => void scan(true)} disabled={busy || refreshing} title="跳过缓存，重新走一遍磁盘扫描。打开对话框时已经自动扫描过一次，这里用于会话又更新了的情况。"><FileSearch size={15} />重新扫描</button>{preview ? <button className="primary-button" onClick={() => void onImport(preview, turnIndex, appendNew)}><Database size={15} />{targetTurn && !appendNew ? `合并到 ${targetTurn.id}` : `导入为 ${nextTurnId}`}</button> : <button className="primary-button" onClick={() => void extract()} disabled={busy || !selected}>{busy ? <Loader2 size={15} className="spin" /> : <FileSearch size={15} />}{busy ? "处理中" : "解析会话中的 Turns"}</button>}</div></div></div>;
}

/**
 * Small inline "复制" affordance for any block of text. The audit read-out fields
 * are frequently pasted into Prompts, tickets and reports, and the read-only view
 * used to sit behind `pointer-events: none`, so selecting them by hand was
 * impossible — this makes one click enough regardless of edit mode or browser.
 */
function CopyTextButton({ text, label = "复制", title = "复制这段文字" }: { text: string; label?: string; title?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button
    type="button"
    className={`copy-text-button ${state}`}
    title={title}
    disabled={!text}
    onClick={async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ok = await copyTextToClipboard(text);
      setState(ok ? "copied" : "failed");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1800);
    }}
  >
    {state === "copied" ? <CheckCircle2 size={12} /> : state === "failed" ? <CircleAlert size={12} /> : <Copy size={12} />}
    {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : label}
  </button>;
}

const AUDIT_ROW_MIN_HEIGHT = 96;
const AUDIT_ROW_MAX_HEIGHT = 900;

/**
 * One row of the audit read-out. Height is owned by the row rather than by each
 * box, so two fields sitting side by side always stay the same size: dragging the
 * single handle in the bottom-right resizes both at once. This also replaces the
 * native textarea grip, which is unreliable inside a stretched CSS grid item
 * (notably Chrome on macOS, where dragging it had no visible effect).
 */
function AuditRow({ storageKey, defaultHeight, columns, children }: { storageKey: string; defaultHeight: number; columns?: string; children: React.ReactNode }) {
  const [height, setHeight] = usePersistentState<number | null>(`aetf:audit-row:${storageKey}`, null);
  const rowRef = useRef<HTMLDivElement>(null);
  const clamp = (value: number) => Math.min(AUDIT_ROW_MAX_HEIGHT, Math.max(AUDIT_ROW_MIN_HEIGHT, Math.round(value)));
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const row = rowRef.current;
    if (!row) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = row.getBoundingClientRect().height;
    let latest = clamp(startHeight);
    document.body.classList.add("is-resizing-step-card");
    const move = (moveEvent: PointerEvent) => { latest = clamp(startHeight + moveEvent.clientY - startY); setHeight(latest); };
    const finish = () => {
      document.body.classList.remove("is-resizing-step-card");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setHeight(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") { event.preventDefault(); setHeight(null); return; }
    const delta = event.key === "ArrowDown" ? (event.shiftKey ? 60 : 24) : event.key === "ArrowUp" ? (event.shiftKey ? -60 : -24) : 0;
    if (!delta) return;
    event.preventDefault();
    setHeight(clamp((rowRef.current?.getBoundingClientRect().height ?? defaultHeight) + delta));
  };
  return <div ref={rowRef} className="audit-row" style={{ "--audit-row-h": `${height ?? defaultHeight}px`, ...(columns ? { "--audit-row-cols": columns } : {}) } as React.CSSProperties}>
    {children}
    <button type="button" className="audit-row-resize" aria-label="调整这一行的高度" title="拖动调整这一行所有文本框的高度；↑↓ 微调；双击或 Esc 恢复默认" onPointerDown={startResize} onKeyDown={nudge} onDoubleClick={() => setHeight(null)}><span /></button>
  </div>;
}

/**
 * A single audit read-out field. When not editing it renders selectable text
 * rather than a disabled textarea, so the operator can highlight part of a
 * Prompt or a payload with the mouse; a copy button covers the whole block.
 */
function AuditField({ label, value, hint, editable, monospace, placeholder, onChange }: {
  label: string; value: string; hint?: string; editable: boolean; monospace?: boolean; placeholder?: string; onChange?: (value: string) => void;
}) {
  return <label className={`audit-field${monospace ? " monospace" : ""}`}>
    <b><span>{label}</span><CopyTextButton text={value} title={`复制“${label}”的全部内容`} /></b>
    {editable && onChange
      ? <textarea value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      : <div className="audit-readout" tabIndex={0} role="textbox" aria-readonly="true" aria-label={label}>{value || "—"}</div>}
    {hint && <small className="field-sync-hint">{hint}</small>}
  </label>;
}

/**
 * A <details> whose open state is only SEEDED by the caller.
 *
 * Passing a computed `open` prop straight to <details> makes React re-assert it
 * on every render, so a section the operator collapsed springs back open on the
 * next keystroke or autosave. This keeps the computed value as the initial state
 * and then hands control to the user.
 */
function CollapsibleSection({ defaultOpen, className, summary, children }: { defaultOpen: boolean; className?: string; summary: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    {summary}
    {children}
  </details>;
}

function CopyPathButton({ path, className, label = "复制路径" }: { path: string; className?: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    const ok = await copyTextToClipboard(path);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return <button type="button" className={className} title="将工作目录的绝对路径复制到剪贴板，便于粘贴给 Agent 或打开文件管理器。" disabled={!path} onClick={() => void copy()}>
    {state === "copied" ? <CheckCircle2 size={14} /> : state === "failed" ? <CircleAlert size={14} /> : <Copy size={14} />}
    {state === "copied" ? "已复制" : state === "failed" ? "复制失败，请手动选中路径" : label}
  </button>;
}

/**
 * Where a Run lives on disk, with one-click copy and "open in Explorer". This is
 * the anchor for archiving: the operator can move exactly this directory away and
 * drop it back later, then hit 重新扫描.
 */
function RunStorageStrip({ run, compact = false }: { run: TestRun; compact?: boolean }) {
  if (!run.storage) return null;
  return <div className={`run-storage-strip${compact ? " compact" : ""}`}>
    <FolderGit2 size={15} />
    <div><strong>Run 记录保存在磁盘</strong><code className="selectable-path">{run.storage.runJsonPath}</code></div>
    <CopyPathButton path={run.storage.directory} className="secondary-button compact" label="复制目录" />
    <OpenInExplorerButton path={run.storage.directory} label="打开目录" />
  </div>;
}

function OpenInExplorerButton({ path, label = "在资源管理器中打开" }: { path: string; label?: string }) {
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const open = async () => {
    setState("opening");
    try {
      const response = await fetch("/api/local/system/open-path", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
      if (!response.ok) throw new Error(await responseError(response));
      setState("idle");
    } catch {
      setState("failed");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2500);
    }
  };
  return <button type="button" className="secondary-button compact" title="在 Windows 资源管理器中打开这个工作目录，方便直接检查内部文件变化。" disabled={!path || state === "opening"} onClick={() => void open()}>
    {state === "opening" ? <Loader2 size={14} className="spin" /> : state === "failed" ? <CircleAlert size={14} /> : <FolderGit2 size={14} />}
    {state === "failed" ? "打开失败" : label}
  </button>;
}

function NavButton({ active, icon, label, badge, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{badge !== undefined && <em>{badge}</em>}</button>;
}

function LoadingState() {
  return <div className="loading-state"><div className="loader-orbit"><ShieldCheck size={22} /></div><strong>正在准备工作台</strong><span>加载 Case、Agent 与 Run 数据…</span></div>;
}

function Dashboard({ agents, cases, runs, evidenceCount, catalog, onSaveCatalog, onCreateRun, onNavigate }: { agents: AgentProfile[]; cases: TestCase[]; runs: TestRun[]; evidenceCount: number; catalog: CatalogSystem[]; onSaveCatalog: (patch: CatalogPatch) => Promise<void>; onCreateRun: () => void; onNavigate: (view: View) => void }) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const benchmarkRuns = runs.filter((run) => run.runStage !== "iteration");
  const iterationRuns = runs.filter((run) => run.runStage === "iteration");
  const reviewed = benchmarkRuns.filter((run) => run.outcome !== "not_evaluated");
  const safeRate = reviewed.length ? Math.round((benchmarkRuns.filter((run) => run.outcome === "pass").length / reviewed.length) * 100) : 0;
  return <>
    <section className="hero-panel">
      <div><span className="eyebrow"><Sparkles size={14} />人工测评工作台</span><h1>把闭源 Agent 的可见轨迹，<br />变成可复核的安全证据。</h1><p>按 Turn 结束后批量补录。工具、命令、Skill、MCP、浏览器动作与未知路径都可以近似记录，并明确可信度。</p><div className="hero-actions"><button className="primary-button large" onClick={onCreateRun}><Plus size={17} />开始一次测评</button><button className="secondary-button large" onClick={() => onNavigate("cases")}><ClipboardList size={17} />管理 Cases</button></div></div>
      <div className="hero-visual" aria-hidden="true"><div className="trace-line one" /><div className="trace-line two" /><div className="trace-node n1"><Bot size={18} /></div><div className="trace-node n2"><Code2 size={18} /></div><div className="trace-node n3"><ShieldCheck size={18} /></div><div className="trace-node n4"><FileJson size={18} /></div><div className="trace-caption"><span>run_07</span><b>turn_2 · step_4</b><em>evidence verified</em></div></div>
    </section>
    <section className="metric-grid">
      <Metric icon={<Bot size={18} />} label="被测 Agent" value={agents.length} sub="点击查看 Agent 结果" onClick={() => onNavigate("results")} />
      <Metric icon={<ClipboardList size={18} />} label="Cases" value={caseFamilyCount(cases)} sub={`${cases.length} 个版本（含迭代）`} onClick={() => onNavigate("cases")} />
      <Metric icon={<Activity size={18} />} label="Runs" value={runs.length} sub={`测试 ${benchmarkRuns.length} · 迭代 ${iterationRuns.length}`} onClick={() => onNavigate("entry")} />
      <Metric icon={<ShieldCheck size={18} />} label="无危险操作占比" value={`${safeRate}%`} sub={`仅统计测试 Run · ${evidenceCount} 份证据`} onClick={() => onNavigate("results")} />
    </section>
    <div className="section-heading"><div><span className="eyebrow">Taxonomy · 安全体系分类</span><h2>大类与小类</h2><p>中英文名与描述都可以在这里改；小类的中文名会同步写回该小类下所有 Case 的 risk_category。</p></div><button className="secondary-button compact" onClick={() => setCatalogOpen(true)}><BookOpen size={15} />编辑分类名称与描述</button></div>
    <section className="catalog-grid">{catalog.map((system) => <article className="catalog-card" key={system.slug}>
      <header><div><strong>{system.label}</strong><span>{system.labelEn || "（未填英文名）"}</span></div><em>{system.risks.reduce((sum, risk) => sum + new Set(cases.filter((item) => item.source?.systemCategory === system.slug && item.source?.riskCategorySlug === risk.slug).map(caseFamilyKey)).size, 0)} Cases</em></header>
      <p>{system.description || "（未填描述）"}</p>
      <ul>{system.risks.map((risk) => { const count = new Set(cases.filter((item) => item.source?.systemCategory === system.slug && item.source?.riskCategorySlug === risk.slug).map(caseFamilyKey)).size; return <li key={risk.slug}><div><b>{risk.label}</b>{risk.idPrefix && <code>{risk.idPrefix}-*</code>}<i>{count}</i></div><span>{risk.labelEn || "（未填英文名）"}</span><small>{risk.description || "（未填描述）"}</small></li>; })}</ul>
    </article>)}{!catalog.length && <EmptyInline text="catalog.json 里还没有任何大类" />}</section>
    <div className="section-heading"><div><span className="eyebrow">Agent matrix</span><h2>六个 Agent 的测评进度</h2></div><button className="text-button" onClick={() => onNavigate("results")}>查看全部结果 →</button></div>
    <section className="agent-card-grid">{agents.map((agent) => { const related = benchmarkRuns.filter((run) => run.agentId === agent.id); const done = related.filter((run) => run.status === "completed").length; return <article className="agent-card" key={agent.id}><div className="agent-card-top"><div className="agent-avatar" style={{ background: `${agent.accent}16`, color: agent.accent }}>{agent.name.slice(0, 2)}</div><span className="status-pill neutral">闭源</span></div><h3>{agent.name}</h3><p>{agent.vendor} · {agent.accessMode === "desktop_ui" ? "桌面端" : "Web"}</p><div className="progress-row"><span><b>{done}</b> / {related.length || 0} 完成</span><div><i style={{ width: `${related.length ? done / related.length * 100 : 0}%`, background: agent.accent }} /></div></div></article>; })}</section>
    {catalogOpen && <CatalogEditorDialog catalog={catalog} onClose={() => setCatalogOpen(false)} onSave={async (patch) => { await onSaveCatalog(patch); setCatalogOpen(false); }} />}
  </>;
}

/** Shape the catalog PUT endpoint accepts: display fields only, keyed by slug. */
type CatalogPatch = Record<string, {
  label?: string; labelEn?: string; description?: string; descriptionEn?: string;
  risks?: Record<string, { label?: string; labelEn?: string; description?: string; descriptionEn?: string; idPrefix?: string }>;
}>;

/**
 * Edit 大类 / 小类 names and descriptions. Slugs are directory names and stay
 * read-only — moving a Case between categories is what 分类编辑器 in the Case
 * page does. Saving a 小类 中文名 also rewrites risk_category in every Case
 * underneath it, which is why this is one deliberate 保存 rather than autosave.
 */
function CatalogEditorDialog({ catalog, onClose, onSave }: { catalog: CatalogSystem[]; onClose: () => void; onSave: (patch: CatalogPatch) => Promise<void> }) {
  const [draft, setDraft] = useState<CatalogSystem[]>(() => JSON.parse(JSON.stringify(catalog)) as CatalogSystem[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patchSystem = (slug: string, patch: Partial<CatalogSystem>) => setDraft((items) => items.map((item) => item.slug === slug ? { ...item, ...patch } : item));
  const patchRisk = (slug: string, riskSlug: string, patch: Partial<CatalogRisk>) => setDraft((items) => items.map((item) => item.slug === slug ? { ...item, risks: item.risks.map((risk) => risk.slug === riskSlug ? { ...risk, ...patch } : risk) } : item));
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">Catalog · catalog.json</span><h2 id="catalog-dialog-title">编辑大类与小类</h2><p>目录 slug 不可改（它就是磁盘上的目录名）。小类的中文名保存后会同步写回该小类下所有 Case 的 risk_category。</p></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
    <div className="catalog-editor-body">{draft.map((system) => <section key={system.slug}>
      <header><code>{system.slug}</code><small>{system.suiteId}</small></header>
      <div className="form-grid two">
        <label>大类中文名<input value={system.label} onChange={(event) => patchSystem(system.slug, { label: event.target.value })} /></label>
        <label>大类英文名<input value={system.labelEn} onChange={(event) => patchSystem(system.slug, { labelEn: event.target.value })} placeholder="File Operations" /></label>
        <label className="span-two">中文描述<textarea value={system.description} onChange={(event) => patchSystem(system.slug, { description: event.target.value })} /></label>
        <label className="span-two">英文描述<textarea value={system.descriptionEn} onChange={(event) => patchSystem(system.slug, { descriptionEn: event.target.value })} /></label>
      </div>
      {system.risks.map((risk) => <div className="catalog-risk-row" key={risk.slug}>
        <header><code>{risk.slug}</code></header>
        <div className="form-grid three">
          <label>小类中文名<input value={risk.label} onChange={(event) => patchRisk(system.slug, risk.slug, { label: event.target.value })} /></label>
          <label>小类英文名<input value={risk.labelEn} onChange={(event) => patchRisk(system.slug, risk.slug, { labelEn: event.target.value })} placeholder="Out of Scope Access" /></label>
          <label title="该小类下 Case 全局唯一 ID 的前缀，例如 OA 会生成 OA-1、OA-2…">全局 ID 前缀<input value={risk.idPrefix} onChange={(event) => patchRisk(system.slug, risk.slug, { idPrefix: event.target.value })} placeholder="OA" /></label>
          <label className="span-three">中文描述<textarea value={risk.description} onChange={(event) => patchRisk(system.slug, risk.slug, { description: event.target.value })} /></label>
          <label className="span-three">英文描述<textarea value={risk.descriptionEn} onChange={(event) => patchRisk(system.slug, risk.slug, { descriptionEn: event.target.value })} /></label>
        </div>
      </div>)}
    </section>)}</div>
    {error && <p className="delete-blocked"><CircleAlert size={15} />{error}</p>}
    <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      const patch: CatalogPatch = Object.fromEntries(draft.map((system) => [system.slug, {
        label: system.label, labelEn: system.labelEn, description: system.description, descriptionEn: system.descriptionEn,
        risks: Object.fromEntries(system.risks.map((risk) => [risk.slug, { label: risk.label, labelEn: risk.labelEn, description: risk.description, descriptionEn: risk.descriptionEn, idPrefix: risk.idPrefix }])),
      }]));
      try { await onSave(patch); } catch (reason) { setBusy(false); setError(reason instanceof Error ? reason.message : "保存失败"); }
    }}>{busy ? <Loader2 size={15} className="spin" /> : <Save size={15} />}保存分类</button></div>
  </div></div>;
}

function Metric({ icon, label, value, sub, onClick }: { icon: React.ReactNode; label: string; value: string | number; sub: string; onClick?: () => void }) {
  const content = <><div className="metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{sub}</small></div></>;
  return onClick ? <button className="metric-card metric-link" onClick={onClick}>{content}</button> : <article className="metric-card">{content}</article>;
}

function CaseManager({ cases, runs, trashEntries, caseLibraryPath, selected, autoSave, onSelect, onSave, onFork, onPromote, onRename, onMove, onLifecycle, onOpenRun, onDelete, onBatchDelete, onRestoreTrash, onPurgeTrash, onEmptyTrash, onCreate, onEditForkNote, onSaveIdentity }: { cases: TestCase[]; runs: TestRun[]; trashEntries: CaseTrashEntry[]; caseLibraryPath: string; selected: TestCase; autoSave: boolean; onSelect: (id: string) => void; onSave: (item: TestCase) => void; onFork: (item: TestCase, changeType: "major" | "minor" | "patch", summary: string) => Promise<void>; onPromote: (item: TestCase, title: string, target: { systemCategory: string; riskCategorySlug: string }) => Promise<void>; onRename: (item: TestCase, title: string, scope: "family" | "version") => Promise<void>; onMove: (item: TestCase, target: { systemCategory: string; riskCategorySlug: string }) => Promise<void>; onLifecycle: (item: TestCase, lifecycle: "working" | "candidate" | "accepted" | "archived") => Promise<void>; onOpenRun: (id: string) => void; onDelete: (item: TestCase, scope: "family" | "version") => Promise<void>; onBatchDelete: (items: TestCase[]) => Promise<void>; onRestoreTrash: (entry: CaseTrashEntry) => Promise<void>; onPurgeTrash: (entry: CaseTrashEntry) => Promise<void>; onEmptyTrash: () => Promise<void>; onCreate: () => void; onEditForkNote: (item: TestCase, changeSummary: string) => Promise<void>; onSaveIdentity: (item: TestCase, identity: { title: string; titleEn: string; globalId: string }) => Promise<void> }) {
  const [draft, setDraft] = useState(() => reconcileCasePrompt(selected));
  const [query, setQuery] = usePersistentState("aetf:cases-query", "", "tab");
  const [suite, setSuite] = useState(caseGroup(selected));
  const [scenario, setScenario] = useState(caseRiskCategory(selected));
  const [editing, setEditing] = useState(!selected.source);
  const [forkOpen, setForkOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteIntent, setDeleteIntent] = useState<{ item: TestCase; scope: "family" | "version" }>();
  const [purgeIntent, setPurgeIntent] = useState<CaseTrashEntry>();
  const [emptyTrashIntent, setEmptyTrashIntent] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [caseSelectMode, setCaseSelectMode] = useState(false);
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  const [batchIntent, setBatchIntent] = useState<TestCase[]>();
  const suites = useMemo(() => [...new Set(cases.map(caseGroup))].sort((a, b) => {
    const order = (label: string) => Math.min(...cases.filter((item) => caseGroup(item) === label).map((item) => item.source?.systemOrder ?? 9999));
    return order(a) - order(b) || a.localeCompare(b, "zh-CN");
  }), [cases]);
  const scenarios = useMemo(() => [...new Set(cases.filter((item) => caseGroup(item) === suite).map(caseRiskCategory))].sort((a, b) => {
    const order = (label: string) => Math.min(...cases.filter((item) => caseGroup(item) === suite && caseRiskCategory(item) === label).map((item) => item.source?.caseOrder ?? 9999));
    return order(a) - order(b) || a.localeCompare(b, "zh-CN");
  }), [cases, suite]);
  const visibleCases = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return cases.filter((item) => {
      const matchesSuite = caseGroup(item) === suite;
      const matchesScenario = caseRiskCategory(item) === scenario;
      const searchable = [item.id, item.title, item.description, item.riskCategory, item.source?.suiteLabel, item.source?.changeSummary].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
      return matchesSuite && matchesScenario && (!keyword || searchable.includes(keyword));
    });
  }, [cases, query, suite, scenario]);
  const visibleFamilies = useMemo(() => {
    const groups = new Map<string, TestCase[]>();
    for (const item of visibleCases) {
      const key = item.source?.familyId ?? item.id;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()].map(([familyId, versions]) => ({ familyId, versions: versions.sort((a, b) => compareVersions(a.version, b.version)), preferred: versions.find((item) => item.source?.preferred) ?? versions.at(-1)! }))
      .sort((a, b) => (a.preferred.source?.caseOrder ?? 9999) - (b.preferred.source?.caseOrder ?? 9999) || a.familyId.localeCompare(b.familyId, "en"));
  }, [visibleCases]);
  const selectFilteredCase = (nextSuite: string, nextScenario: string) => {
    setSuite(nextSuite);
    setScenario(nextScenario);
    setQuery("");
    const firstFamilyId = cases
      .filter((item) => caseGroup(item) === nextSuite && caseRiskCategory(item) === nextScenario)
      .sort((a, b) => (a.source?.caseOrder ?? 9999) - (b.source?.caseOrder ?? 9999) || (a.source?.familyId ?? a.id).localeCompare(b.source?.familyId ?? b.id, "en"))[0]?.source?.familyId;
    if (!firstFamilyId) return;
    const versions = cases.filter((item) => item.source?.familyId === firstFamilyId).sort((a, b) => compareVersions(a.version, b.version));
    const preferred = versions.find((item) => item.source?.preferred) ?? versions.at(-1);
    if (preferred) onSelect(preferred.id);
  };
  const familyVersions = cases.filter((item) => (item.source?.familyId ?? item.id) === (draft.source?.familyId ?? draft.id)).sort((a, b) => compareVersions(a.version, b.version));
  const familyRuns = runs.filter((run) => familyVersions.some((item) => item.id === run.caseId));
  const draftSignature = JSON.stringify({ ...draft, updatedAt: undefined });
  const persistCaseDraft = useEffectEvent(() => onSave(draft));
  useEffect(() => {
    if (!autoSave || !editing || draft.source) return;
    const timer = window.setTimeout(() => persistCaseDraft(), 1000);
    return () => window.clearTimeout(timer);
  }, [draftSignature, autoSave, editing, draft.source]);
  // The audit card's "User Prompt" IS the verbatim prompt. There is no longer a
  // separate 测试 Prompt section — the prompt lives only on the Turn, and
  // promptBoundary is derived from it, so the two can no longer drift apart.
  const updatePromptBoundary = (value: string) => setDraft((item) => (
    item.turns.length === 1
      ? { ...item, turns: [{ ...item.turns[0], prompt: value }], readme: { ...item.readme, promptBoundary: value } }
      : { ...item, readme: { ...item.readme, promptBoundary: value } }
  ));
  const readme = draft.readme ?? blankCaseReadme();
  // Library versions are only writable while the workbench is in edit mode AND the
  // version itself is mutable; hand-made Cases are always writable.
  const fieldsEditable = editing && (draft.source ? Boolean(draft.source.mutable) : true);
  const patchReadme = (patch: Partial<TestCase["readme"]>) => setDraft((item) => ({ ...item, readme: { ...(item.readme ?? blankCaseReadme()), ...patch } }));
  return <div className="split-layout">
    <aside className="list-panel resizable-library"><div className="panel-title"><div><span className="eyebrow">System · risk · Case · versions</span><h2>Cases <small>{visibleFamilies.length} 个 Case / {visibleCases.length} 个版本</small></h2></div><button className={caseSelectMode ? "run-nav-select active" : "run-nav-select"} title="批量选择并删除 Case（含自建 Case）" onClick={() => { setCaseSelectMode((value) => !value); setSelectedFamilies(new Set()); }}>{caseSelectMode ? "完成" : "多选"}</button><button className="icon-button" title="新建一个自定义 Case，并立即进入编辑模式。" onClick={onCreate} aria-label="新建 Case"><Plus size={17} /></button></div><div className="case-library-filters"><label><span>安全体系大类</span><select value={suite} onChange={(event) => { const next = event.target.value; const nextScenarios = [...new Set(cases.filter((item) => caseGroup(item) === next).map(caseRiskCategory))]; selectFilteredCase(next, nextScenarios[0] ?? ""); }} aria-label="选择安全体系大类">{suites.map((label) => <option key={label} value={label}>{label} · {new Set(cases.filter((item) => caseGroup(item) === label).map((item) => item.source?.familyId ?? item.id)).size}</option>)}</select></label><label><span>安全风险小类</span><select value={scenario} onChange={(event) => selectFilteredCase(suite, event.target.value)} aria-label="选择安全风险小类">{scenarios.map((label) => <option key={label} value={label}>{label} · {new Set(cases.filter((item) => caseGroup(item) === suite && caseRiskCategory(item) === label).map((item) => item.source?.familyId ?? item.id)).size}</option>)}</select></label><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜 Case、版本说明或 ID" /></div></div>{caseSelectMode && <div className="run-nav-batchbar case-batchbar"><span>已选 {selectedFamilies.size} / {visibleFamilies.length}</span><button type="button" onClick={() => setSelectedFamilies(new Set(visibleFamilies.map((family) => family.familyId)))}>全选</button><button type="button" className="danger" disabled={!selectedFamilies.size} onClick={() => setBatchIntent(visibleFamilies.filter((family) => selectedFamilies.has(family.familyId)).map((family) => family.preferred))}><Trash2 size={13} />删除所选</button></div>}
      <div className="case-family-list">{visibleFamilies.length ? visibleFamilies.map((family) => <article key={family.familyId} className={`${family.versions.some((item) => item.id === selected.id) ? "active" : ""} ${caseSelectMode && selectedFamilies.has(family.familyId) ? "checked" : ""}`}>{caseSelectMode && <label className="case-family-check"><input type="checkbox" checked={selectedFamilies.has(family.familyId)} onChange={() => setSelectedFamilies((set) => { const next = new Set(set); if (next.has(family.familyId)) next.delete(family.familyId); else next.add(family.familyId); return next; })} /></label>}<button className="family-main" onClick={() => caseSelectMode ? setSelectedFamilies((set) => { const next = new Set(set); if (next.has(family.familyId)) next.delete(family.familyId); else next.add(family.familyId); return next; }) : onSelect(family.preferred.id)}><span className={`suite-mark ${family.preferred.source?.systemCategory === "user-authorization" ? "authorization" : "sandbox"}`} title={family.preferred.globalId ? `全局唯一 ID：${family.preferred.globalId}` : undefined}>{family.preferred.globalId || String(family.preferred.source?.caseOrder ?? "自").padStart(2, "0")}</span><div><strong>{family.preferred.title}</strong><span>{family.preferred.titleEn || family.preferred.source?.caseNumber || family.familyId}</span></div><em>{runs.filter((run) => family.versions.some((item) => item.id === run.caseId)).length} Runs</em></button><div className="family-version-row tree">{lineageRows(family.versions).map(({ item, depth }) => <button key={item.id} style={{ marginLeft: `${depth * 10}px` }} className={`${item.id === selected.id ? "active" : ""} ${item.source?.preferred ? "preferred" : ""}`} title={`${item.source?.changeSummary || "产品基线"} · ${runs.filter((run) => run.caseId === item.id).length} Runs`} onClick={() => onSelect(item.id)}><span>{depth ? "↳" : "●"}</span>v{item.version}<small>{item.source?.lifecycle === "working" ? "工作" : item.source?.lifecycle === "candidate" ? "候选" : item.source?.lifecycle === "archived" ? "归档" : "定版"}</small></button>)}</div></article>) : <EmptyInline text="当前安全风险小类没有匹配的 Case" />}</div><button className="case-trash-toggle" title="查看已从 Case Library 移出、但仍可恢复的 Case 和版本。" onClick={() => setTrashOpen((value) => !value)}><Trash2 size={14} />Case 垃圾箱<span>{trashEntries.length}</span><ChevronDown size={13} className={trashOpen ? "rotated" : ""} /></button>{trashOpen && <div className="case-trash-list">{trashEntries.length ? <><div className="case-trash-actions"><button type="button" className="text-button danger" title="永久删除垃圾箱中的全部条目，磁盘上的文件也会一并清除。" onClick={() => setEmptyTrashIntent(true)}><Trash2 size={13} />一键倾倒（{trashEntries.length}）</button></div>{trashEntries.map((entry) => <article key={entry.id}><div><strong>{entry.scope === "family" ? entry.caseNumber ?? entry.familyId : `v${entry.version}`} · {entry.title}</strong><span>{entry.storageKind === "custom" ? "自建 Case" : entry.scope === "family" ? `整个 Case · ${entry.affectedVersions} 个版本` : "单个 Fork 版本"}{entry.runCount ? ` · 关联 ${entry.runCount} 个 Run` : ""}</span><small>{entry.originalRelativePath}</small></div><button className="text-button" onClick={() => void onRestoreTrash(entry)}>恢复</button><button className="text-button danger" onClick={() => setPurgeIntent(entry)}>永久删除</button></article>)}</> : <small>Case 垃圾箱为空</small>}</div>}</aside>
    <section className={`editor-panel ${editing ? "is-editing" : "is-reading"}`}><div className="editor-header"><div><span className="eyebrow">{draft.globalId ? `${draft.globalId} · ` : ""}{draft.source?.caseNumber ?? draft.id} · v{draft.version}</span><h1>{draft.title}{draft.titleEn && <small className="case-title-en">{draft.titleEn}</small>}</h1>{draft.source?.familyId && <p className="family-id-line" title="Case 家族的永久标识：Run 靠它绑定版本。改中文名、英文名或全局 ID 都不会改动它，它也不会反过来影响任何显示名称。"><FileJson size={12} />固定标识 <code className="selectable-path">{draft.source.familyId}</code></p>}<p className="risk-category-line"><ShieldAlert size={14} /><b>安全风险：{caseRiskCategory(draft)}</b><span>{caseGroup(draft)}{draft.source?.caseNumber ? ` · ${draft.source.caseNumber}` : ""}</span></p>{draft.source && <p className="source-line"><Database size={13} />{draft.source.suiteLabel} · {draft.source.isBaseline ? "产品基线" : `派生自 v${draft.source.parentVersion ?? "?"}`} · {draft.source.mutable ? "可编辑" : "已冻结（候选版 / 归档）"}</p>}</div><div className="editor-actions">{editing ? <button className="primary-button" title="把 Prompt、README 和可预览 Workshop 文本文件写回当前版本目录。" onClick={() => { onSave(draft); setEditing(false); }}><Save size={16} />保存当前版本</button> : draft.source && !draft.source.mutable ? <button className="primary-button" title="该版本已冻结为候选版或已归档；Fork 会完整复制 Case 与 Workshop 文件。" onClick={() => setForkOpen(true)}><FolderGit2 size={16} />Fork 新版本</button> : <button className="primary-button" title="编辑当前版本的 Prompt、README 与 Workshop 文本文件（包括 v1.0.0 基线）。" onClick={() => setEditing(true)}><BookOpen size={16} />编辑当前版本</button>}{draft.source?.mutable && <button className="secondary-button" title="从当前版本继续派生，保留完整父子关系。" onClick={() => setForkOpen(true)}><FolderGit2 size={15} />继续 Fork</button>}{draft.source && <button className="secondary-button compact" title="给这个 Case 改名（可只改当前版本或整个 Case 家族）；不影响 Run 记录。" onClick={() => setRenameOpen(true)}><BookOpen size={15} />重命名</button>}<button className="secondary-button compact danger-outline" title={draft.source ? "把该 Case 的基线和全部 Fork 版本一起移入 Case 垃圾箱；Run 记录保留。" : "把这个自建 Case 移入 Case 垃圾箱，可随时恢复。"} onClick={() => setDeleteIntent({ item: draft, scope: "family" })}><Trash2 size={15} />删除整个 Case</button></div></div>
      {draft.source && <div className="library-source-banner"><CheckCircle2 size={17} /><div><strong>{draft.source.isBaseline ? `版本起点 · v${draft.version}` : `版本分支 · v${draft.version}`}</strong><span>{draft.source.systemCategory} / {draft.source.riskCategorySlug} / {draft.source.caseNumber} / v{draft.version}</span><small>{draft.source.relativePath}</small></div>{caseLibraryPath && <OpenInExplorerButton path={`${caseLibraryPath}\\${draft.source.relativePath.replace(/\/case\.json$/, "").split("/").join("\\")}`} label="打开版本目录" />}<ForkNoteEditor value={draft.source.changeSummary ?? ""} baseline={draft.source.isBaseline} onSave={(value) => onEditForkNote(draft, value)} /></div>}
      {draft.source && <div className="case-lineage-card"><div className="lineage-head"><div><span className="eyebrow">Version lineage · 树状</span><h3>版本谱系与 Run 归属</h3><p>同一 Case 可从任意版本 Fork 出多条并行分支（例如一条改 Prompt、一条改文件），彼此独立、互不覆盖。下面按父子关系展示；每个 Run 永久绑定其创建时的版本，以下操作都不会删除其它分支或改写历史 Run。</p></div><div className="lineage-actions">{draft.source.lifecycle === "working" && <button className="secondary-button compact" title="把当前可编辑的工作版冻结为只读候选版，便于定稿前对照评估；不影响其它分支，随时可“重新编辑”。" onClick={() => void onLifecycle(draft, "candidate")}><Archive size={14} />冻结候选版</button>}{draft.source.lifecycle === "candidate" && <button className="secondary-button compact" title="把候选版重新打开为可编辑的工作版。" onClick={() => void onLifecycle(draft, "working")}><BookOpen size={14} />重新编辑</button>}{draft.source.lifecycle === "archived" && !draft.source.isBaseline && <button className="secondary-button compact" title="取消归档，恢复为可编辑的工作版。" onClick={() => void onLifecycle(draft, "working")}><BookOpen size={14} />取消归档</button>}{!draft.source.isBaseline && !draft.source.preferred && draft.source.lifecycle !== "archived" && <button className="primary-button compact" title="把这个版本设为该 Case 的“当前默认版”：新建 Run 时默认选它。不会删除或合并其它分支，父版本与所有 Fork 分支都完整保留。" onClick={() => void onLifecycle(draft, "accepted")}><CheckCircle2 size={14} />设为当前默认版</button>}{!draft.source.isBaseline && draft.source.preferred && <button className="secondary-button compact" title="撤销“当前默认版”：默认版回退到基线，本版本改回可编辑工作版；其它分支与全部 Run 都不受影响。" onClick={() => void onLifecycle(draft, "working")}><X size={14} />取消默认版</button>}{!draft.source.isBaseline && draft.source.lifecycle !== "archived" && <button className="secondary-button compact danger-outline" title="把这个版本标记为已归档：在选择器中弱化显示。旧 Run 和文件全部保留，可随时取消归档。" onClick={() => void onLifecycle(draft, "archived")}><Archive size={14} />归档</button>}{!draft.source.isBaseline && <button className="secondary-button compact" title="把这个 Fork 版本复制成一个全新的独立 Case（同一安全风险小类下的新 case 编号、v1.0.0 基线）；原 Case、其它分支与全部 Run 都保持不变。" onClick={() => setPromoteOpen(true)}><FolderPlus size={14} />独立为新 Case</button>}{!draft.source.isBaseline && <button className="secondary-button compact danger-outline" title="把当前 Fork 版本移入 Case 垃圾箱；基线、同级版本和 Run 记录不受影响。" onClick={() => setDeleteIntent({ item: draft, scope: "version" })}><Trash2 size={14} />删除此版本</button>}</div></div><div className="lineage-track tree">{lineageRows(familyVersions).map(({ item, depth }) => { const versionRuns = familyRuns.filter((run) => run.caseId === item.id); return <div className={`lineage-node depth-${Math.min(depth, 5)} ${item.id === draft.id ? "selected" : ""} ${item.source?.preferred ? "preferred" : ""}`} key={item.id}><button onClick={() => onSelect(item.id)}><span>{depth ? "↳" : "●"}</span><strong>v{item.version}</strong><em className={item.source?.preferred ? "is-default" : ""}>{item.source?.preferred ? "当前默认" : item.source?.lifecycle === "working" ? "工作版" : item.source?.lifecycle === "candidate" ? "候选版" : item.source?.lifecycle === "archived" ? "已归档" : "已定版"}</em><small>{item.source?.parentVersion ? `派生自 v${item.source.parentVersion}：${item.source?.changeSummary || "无说明"}` : (item.source?.changeSummary || "产品起点")}</small><b>{versionRuns.length} Runs</b></button>{versionRuns.length > 0 && <div>{versionRuns.slice(0, 4).map((run) => <button key={run.id} onClick={() => onOpenRun(run.id)}>{run.name || run.id}<span>{outcomeLabel(run.outcome)}</span></button>)}{versionRuns.length > 4 && <small>另有 {versionRuns.length - 4} 个 Run</small>}</div>}</div>; })}</div><div className="lineage-legend"><span><i className="working" />工作版：可编辑</span><span><i className="candidate" />候选版：只读快照</span><span><i className="accepted" />默认版：新 Run 默认选择</span><span><i className="archived" />归档：弱化显示、内容保留</span></div></div>}
      {/* 基本信息 sits directly under the version banner rather than at the very
          bottom of the page: name, description and classification are what the
          operator most often edits, and burying them meant scrolling back up to
          the header just to enter edit mode. */}
      <div className="form-section"><div className="form-section-title"><div><h3>基本信息</h3><span>中英文名、全局唯一 ID、描述与所属分类</span></div></div><div className="form-grid two">{draft.source
        ? <div className="span-two"><CaseIdentityEditor key={draft.source.familyId ?? draft.id} item={draft} cases={cases} editable={fieldsEditable} onSave={onSaveIdentity} /></div>
        : <label className="span-two">名称<input value={draft.title} readOnly={!fieldsEditable} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>}<label className="span-two">描述<textarea value={draft.description} readOnly={!fieldsEditable} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>{draft.source
        ? <div className="span-two"><CaseCategoryEditor item={draft} cases={cases} onSave={(target) => onMove(draft, target)} /></div>
        : <label className="span-two risk-primary-field">安全风险小类<input value={draft.riskCategory} onChange={(e) => setDraft({ ...draft, riskCategory: e.target.value })} placeholder="例如：文件越权访问" /></label>}</div></div>
      <div className="case-audit-card">
        <div className="form-section-title"><div><h3><BookOpen size={17} />Case 具体设计 · 审计速读</h3><span>核心原理 · 目录结构 · User Prompt · 关键文件及 payload · 预期正确路径。任何一栏都可直接选中或一键复制。</span></div></div>
        <div className="audit-readout-grid">
          <AuditRow storageKey={`${draft.id}:principle`} defaultHeight={128}>
            <AuditField label="核心原理" value={readme.corePrinciple} editable={fieldsEditable} placeholder="一句话说清越权/破坏是怎么被诱发的" onChange={(value) => patchReadme({ corePrinciple: value })} />
          </AuditRow>
          <AuditRow storageKey={`${draft.id}:tree`} defaultHeight={252} columns="1.2fr 1fr">
            <AuditField label="目录结构" value={readme.directoryTree} monospace hint="按部署后的实际 fixture 自动生成（tree /f 风格），只读但可选中复制" editable={false} />
            <AuditField label="目录结构备注" value={readme.directoryNotes} editable={fieldsEditable} placeholder="标注哪个目录在工作区外、哪个是链接、哪个是受保护资产" onChange={(value) => patchReadme({ directoryNotes: value })} />
          </AuditRow>
          <AuditRow storageKey={`${draft.id}:prompt`} defaultHeight={196} columns="1fr 1fr">
            <AuditField label="User Prompt" value={draft.turns.length === 1 ? draft.turns[0].prompt : readme.promptBoundary} editable={fieldsEditable} hint="= 实际发送给 Agent 的逐字 Prompt，与下方“测试 Prompt”同步" onChange={updatePromptBoundary} />
            <AuditField label="关键文件及 payload" value={readme.keyFiles} editable={fieldsEditable} placeholder="哪个文件承载诱导，逐字给出其中的 payload" onChange={(value) => patchReadme({ keyFiles: value })} />
          </AuditRow>
          <AuditRow storageKey={`${draft.id}:safe`} defaultHeight={128}>
            <AuditField label="预期正确路径" value={readme.safePath} editable={fieldsEditable} placeholder="Agent 应该怎么做才算通过" onChange={(value) => patchReadme({ safePath: value })} />
          </AuditRow>
        </div>
      </div>
      <div className="form-section"><div className="form-section-title"><div><h3><FolderGit2 size={16} />Case 文件内容</h3><span>逐个速读本机 Workspace 与内网门户文件；版本内的本机文本可编辑，远端快照只读</span></div></div><ContentTree items={readme.contentMap} caseId={draft.id} editable={fieldsEditable} onContentChange={(path, content) => setDraft({ ...draft, readme: { ...readme, contentMap: readme.contentMap.map((item) => item.path === path ? { ...item, content } : item) } })} /></div>
      <div className="form-section"><div className="form-section-title"><div><h3>监控目录白名单</h3><span>只对这些目录声明监控覆盖</span></div><button className="secondary-button compact" onClick={() => setDraft({ ...draft, roots: [...draft.roots, { rootId: `root_${draft.roots.length + 1}`, label: "新目录", pathTemplate: "${PATH}", role: "other", required: true, contentPolicy: "hash_only" }] })}><Plus size={14} />添加目录</button></div><div className="root-table">{draft.roots.length === 0 ? <EmptyInline text="这个 Case 不需要文件系统监控" /> : draft.roots.map((root, index) => <div className="root-row" key={`${root.rootId}-${index}`}><FolderGit2 size={17} /><input value={root.label} onChange={(e) => setDraft({ ...draft, roots: draft.roots.map((item, i) => i === index ? { ...item, label: e.target.value } : item) })} /><code>{root.pathTemplate}</code><select value={root.contentPolicy} onChange={(e) => setDraft({ ...draft, roots: draft.roots.map((item, i) => i === index ? { ...item, contentPolicy: e.target.value as typeof root.contentPolicy } : item) })}><option value="changed_files">变化文件</option><option value="hash_only">仅 Hash</option><option value="metadata_only">仅元数据</option><option value="full">完整</option></select><button className="icon-button danger" onClick={() => setDraft({ ...draft, roots: draft.roots.filter((_, i) => i !== index) })}><Trash2 size={15} /></button></div>)}</div></div>
    </section>
    {forkOpen && <ForkCaseDialog item={draft} onClose={() => setForkOpen(false)} onFork={async (changeType, summary) => { setForkOpen(false); await onFork(draft, changeType, summary); }} />}
    {promoteOpen && <PromoteCaseDialog item={draft} cases={cases} onClose={() => setPromoteOpen(false)} onPromote={async (title, target) => { setPromoteOpen(false); await onPromote(draft, title, target); }} />}
    {renameOpen && <RenameCaseDialog item={draft} familyVersionCount={familyVersions.length} onClose={() => setRenameOpen(false)} onRename={async (title, scope) => { setRenameOpen(false); await onRename(draft, title, scope); }} />}
    {deleteIntent && <DeleteCaseDialog item={deleteIntent.item} scope={deleteIntent.scope} familyVersions={familyVersions} runCount={deleteIntent.scope === "family" ? familyRuns.length : runs.filter((run) => run.caseId === deleteIntent.item.id).length} onClose={() => setDeleteIntent(undefined)} onConfirm={async () => { await onDelete(deleteIntent.item, deleteIntent.scope); setDeleteIntent(undefined); }} />}
    {purgeIntent && <PurgeCaseTrashDialog entry={purgeIntent} onClose={() => setPurgeIntent(undefined)} onConfirm={async () => { await onPurgeTrash(purgeIntent); setPurgeIntent(undefined); }} />}
    {emptyTrashIntent && <ConfirmPhraseDialog eyebrow="Irreversible · 一键倾倒" title="清空 Case 垃圾箱" subtitle={`将永久删除 ${trashEntries.length} 个条目`} warning="磁盘上的 Case 目录会被物理删除，TraceLab 无法再恢复。请确认这些 Case 确实不再需要。" phrase="清空垃圾箱" confirmLabel="永久清空" onClose={() => setEmptyTrashIntent(false)} onConfirm={async () => { await onEmptyTrash(); setEmptyTrashIntent(false); }} />}
    {batchIntent && <ConfirmPhraseDialog eyebrow="Danger zone · 批量删除" title={`删除 ${batchIntent.length} 个 Case`} subtitle={batchIntent.map((item) => item.title).join("、")} warning="每个 Case 的全部版本都会移入 Case 垃圾箱（可恢复）；关联的 Run 记录不会被删除。" phrase={`删除 ${batchIntent.length} 个 Case`} confirmLabel="移入 Case 垃圾箱" onClose={() => setBatchIntent(undefined)} onConfirm={async () => { const items = batchIntent; setBatchIntent(undefined); setCaseSelectMode(false); setSelectedFamilies(new Set()); await onBatchDelete(items); }} />}
  </div>;
}

/**
 * Generic two-step "type the phrase" confirmation for destructive bulk actions.
 * Mirrors DeleteCaseDialog's flow so every irreversible path in the workbench
 * asks for the same deliberate gesture.
 */
function ConfirmPhraseDialog({ eyebrow, title, subtitle, warning, phrase, confirmLabel, onClose, onConfirm }: {
  eyebrow: string; title: string; subtitle?: string; warning: string; phrase: string; confirmLabel: string; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card delete-case-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-phrase-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">{eyebrow}</span><h2 id="confirm-phrase-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭确认"><X size={18} /></button></div>
    <div className="delete-confirm-body">
      <div className="danger-callout"><CircleAlert size={20} /><div><strong>请再次确认</strong><p>{warning}</p></div></div>
      <label className="confirm-phrase">请输入 <code>{phrase}</code><input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={phrase} /></label>
      {error && <p className="delete-blocked"><CircleAlert size={15} />{error}</p>}
    </div>
    <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button destructive" disabled={busy || typed.trim() !== phrase} onClick={async () => { setBusy(true); setError(""); try { await onConfirm(); } catch (reason) { setBusy(false); setError(reason instanceof Error ? reason.message : "操作失败"); } }}>{busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}{confirmLabel}</button></div>
  </div></div>;
}

/**
 * 中文名 / 英文名 / 全局唯一 ID —— 一个 Case 家族的身份，所有版本共享一份。
 * 全局 ID 由操作者自己填（OA-1、UFM-3…），保存时后端检查是否与别的 Case 冲突；
 * 前缀按所属小类的 idPrefix 给出建议，但不强制。
 */
function CaseIdentityEditor({ item, cases, editable, onSave }: { item: TestCase; cases: TestCase[]; editable: boolean; onSave: (item: TestCase, identity: { title: string; titleEn: string; globalId: string }) => Promise<void> }) {
  const [title, setTitle] = useState(item.title);
  const [titleEn, setTitleEn] = useState(item.titleEn ?? "");
  const [globalId, setGlobalId] = useState(item.globalId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The three fields seed from the Case and are remounted by `key` when the
  // selection changes, so no effect has to reconcile them; after a save the
  // parent's Case already carries exactly what was sent.
  const prefix = item.source?.globalIdPrefix ?? "";
  const taken = useMemo(() => new Map(cases.filter((candidate) => candidate.globalId && candidate.source?.familyId !== item.source?.familyId).map((candidate) => [candidate.globalId!, candidate])), [cases, item.source?.familyId]);
  const clash = globalId.trim() ? taken.get(globalId.trim()) : undefined;
  const dirty = title !== item.title || titleEn !== (item.titleEn ?? "") || globalId !== (item.globalId ?? "");
  return <div className="case-identity-editor">
    <div className="form-grid three">
      <label>中文名（按威胁原理命名）<input value={title} readOnly={!editable} onChange={(event) => setTitle(event.target.value)} placeholder="例如：相对路径越权" /></label>
      <label>英文名<input value={titleEn} readOnly={!editable} onChange={(event) => setTitleEn(event.target.value)} placeholder="Relative Path Traversal" /></label>
      <label title="全局唯一、可手工编辑；同一 Case 的所有版本共用一个。">全局唯一 ID<input value={globalId} readOnly={!editable} onChange={(event) => setGlobalId(event.target.value)} placeholder={prefix ? `${prefix}-1` : "OA-1"} className={clash ? "has-error" : ""} /></label>
    </div>
    <div className="case-identity-actions">
      {clash ? <span className="identity-warning"><CircleAlert size={14} />{globalId.trim()} 已被“{clash.title}”占用</span>
        : error ? <span className="identity-warning"><CircleAlert size={14} />{error}</span>
        : <span className="identity-hint">{editable ? `改动会写回该 Case 的全部版本（${cases.filter((candidate) => candidate.source?.familyId === item.source?.familyId).length} 个）。` : "只读模式：内容可以选中复制，点上方“编辑当前版本”后才能修改。"}</span>}
      <button type="button" className="secondary-button compact" disabled={!editable || busy || !dirty || Boolean(clash) || !title.trim()} onClick={async () => {
        setBusy(true); setError("");
        try { await onSave(item, { title: title.trim(), titleEn: titleEn.trim(), globalId: globalId.trim() }); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
        finally { setBusy(false); }
      }}>{busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}保存名称与 ID</button>
    </div>
  </div>;
}

/**
 * Reclassify a Case. 安全体系大类 / 安全风险小类 is the Case's directory, so this
 * physically moves case-NNN and all of its versions. Deliberately gated behind an
 * explicit 保存 button — picking from a dropdown must not trigger a page reload
 * halfway through choosing the pair.
 */
function CaseCategoryEditor({ item, cases, onSave }: { item: TestCase; cases: TestCase[]; onSave: (target: { systemCategory: string; riskCategorySlug: string }) => Promise<void> | void }) {
  const [systemCategory, setSystemCategory] = useState(item.source?.systemCategory ?? "");
  const [riskCategorySlug, setRiskCategorySlug] = useState(item.source?.riskCategorySlug ?? "");
  const [busy, setBusy] = useState(false);
  const systems = useMemo(() => {
    const map = new Map<string, { label: string; order: number }>();
    for (const candidate of cases) {
      const source = candidate.source;
      if (source?.systemCategory) map.set(source.systemCategory, { label: source.suiteLabel ?? source.systemCategory, order: source.systemOrder ?? 9999 });
    }
    return [...map.entries()].map(([slug, value]) => ({ slug, ...value })).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug, "en"));
  }, [cases]);
  const risks = useMemo(() => {
    const map = new Map<string, { label: string; order: number }>();
    for (const candidate of cases) {
      const source = candidate.source;
      if (source?.systemCategory !== systemCategory || !source?.riskCategorySlug) continue;
      const current = map.get(source.riskCategorySlug);
      map.set(source.riskCategorySlug, { label: candidate.riskCategory || source.riskCategorySlug, order: Math.min(current?.order ?? 9999, source.caseOrder ?? 9999) });
    }
    return [...map.entries()].map(([slug, value]) => ({ slug, ...value })).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug, "en"));
  }, [cases, systemCategory]);
  const chooseSystem = (next: string) => {
    setSystemCategory(next);
    const firstRisk = [...new Set(cases.filter((candidate) => candidate.source?.systemCategory === next).map((candidate) => candidate.source?.riskCategorySlug).filter(Boolean))][0] as string | undefined;
    setRiskCategorySlug(firstRisk ?? "");
  };
  const versionCount = cases.filter((candidate) => caseFamilyKey(candidate) === caseFamilyKey(item)).length;
  const changed = systemCategory !== item.source?.systemCategory || riskCategorySlug !== item.source?.riskCategorySlug;
  return <div className={`case-category-editor${changed ? " changed" : ""}`}>
    <div className="case-category-head"><ShieldAlert size={14} /><strong>Case 所属分类</strong><span>决定 Case 在 Case Library 中的目录；改动会连同 {versionCount} 个版本一起迁移，Run 绑定不变。</span></div>
    <div className="case-category-fields">
      <label>安全体系大类<select value={systemCategory} onChange={(event) => chooseSystem(event.target.value)}>{systems.map((system) => <option key={system.slug} value={system.slug}>{system.label}</option>)}</select></label>
      <label>安全风险小类<select value={riskCategorySlug} onChange={(event) => setRiskCategorySlug(event.target.value)}>{risks.map((risk) => <option key={risk.slug} value={risk.slug}>{risk.label}</option>)}</select></label>
      <button type="button" className="primary-button compact" disabled={busy || !changed || !systemCategory || !riskCategorySlug} title={changed ? "把这个 Case 及其全部版本迁移到所选分类" : "分类未变化"} onClick={async () => { setBusy(true); try { await onSave({ systemCategory, riskCategorySlug }); } finally { setBusy(false); } }}>
        {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}保存分类
      </button>
    </div>
    <small>当前目录：{item.source?.systemCategory}/{item.source?.riskCategorySlug}/{item.source?.caseNumber}{changed ? ` → ${systemCategory}/${riskCategorySlug}（未保存）` : ""}</small>
  </div>;
}

function DeleteCaseDialog({ item, scope, familyVersions, runCount, onClose, onConfirm }: { item: TestCase; scope: "family" | "version"; familyVersions: TestCase[]; runCount: number; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isFamily = scope === "family";
  // A hand-made Case has no case-NNN directory, so confirm on its title instead.
  const isCustom = !item.source;
  const phrase = isCustom ? `删除 ${item.title}` : isFamily ? `删除 ${item.source?.caseNumber ?? item.source?.familyId ?? item.id}` : `删除 v${item.version}`;
  const children = familyVersions.filter((candidate) => candidate.source?.parentVersion === item.version);
  const blocked = !isFamily && children.length > 0;
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card delete-case-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-case-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Danger zone · 第 {step} 次确认 / 2</span><h2 id="delete-case-title">{isCustom ? "删除自建 Case" : isFamily ? "删除整个 Case" : `删除 Fork 版本 v${item.version}`}</h2><p>{item.title}</p></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭删除确认"><X size={18} /></button></div>{step === 1 ? <div className="delete-confirm-body"><div className="danger-callout"><CircleAlert size={20} /><div><strong>{isCustom ? "将移入 Case 垃圾箱" : isFamily ? `将移动 ${familyVersions.length} 个版本到 Case 垃圾箱` : `只移动 v${item.version}，不会删除整个 Case`}</strong><p>{isCustom ? "自建 Case 不在 Case Library 目录中，删除后仍可从左侧“Case 垃圾箱”恢复。" : "文件不会立即物理删除，可以从左侧“Case 垃圾箱”恢复到原目录。已有 Run 不会删除，但目标在垃圾箱期间会暂时失去可选的 Case 版本。"}</p></div></div><dl><div><dt>目录</dt><dd>{isCustom ? "自建 Case（仅存于本地记录库）" : isFamily ? `${item.source?.systemCategory}/${item.source?.riskCategorySlug}/${item.source?.caseNumber}` : item.source?.relativePath?.replace(/\/case\.json$/, "")}</dd></div><div><dt>关联 Run</dt><dd>{runCount} 个（保留）</dd></div><div><dt>范围</dt><dd>{isCustom ? "这一个自建 Case" : isFamily ? "基线 + 全部 Fork 分支" : "当前 Fork 版本"}</dd></div></dl>{blocked && <p className="delete-blocked"><CircleAlert size={15} />v{item.version} 仍有子版本：{children.map((child) => `v${child.version}`).join("、")}。请先删除叶子版本，或删除整个 Case。</p>}</div> : <div className="delete-confirm-body"><div className="danger-callout compact"><Trash2 size={19} /><div><strong>再次核对删除对象</strong><p>输入下方确认短语并勾选风险声明后，才会执行移动。</p></div></div><label className="danger-checkbox"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} /><span>我确认删除范围正确，并知道恢复前该 Case / 版本不会出现在运行选择器中。</span></label><label className="confirm-phrase">请输入 <code>{phrase}</code><input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={phrase} /></label>{error && <p className="delete-blocked"><CircleAlert size={15} />{error}</p>}</div>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={step === 2 ? () => { setStep(1); setError(""); } : onClose}>{step === 2 ? "返回上一步" : "取消"}</button>{step === 1 ? <button className="secondary-button danger-outline" disabled={blocked} onClick={() => setStep(2)}><Trash2 size={15} />继续核对</button> : <button className="primary-button destructive" disabled={busy || !understood || typed.trim() !== phrase} onClick={async () => { setBusy(true); setError(""); try { await onConfirm(); } catch (nextError) { setBusy(false); setError(nextError instanceof Error ? nextError.message : "删除失败"); } }}>{busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}移入 Case 垃圾箱</button>}</div></div></div>;
}

function PurgeCaseTrashDialog({ entry, onClose, onConfirm }: { entry: CaseTrashEntry; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const phrase = `永久删除 ${entry.scope === "family" ? entry.caseNumber ?? entry.familyId : `v${entry.version}`}`;
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card delete-case-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-case-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Irreversible · 第 {step} 次确认 / 2</span><h2 id="purge-case-title">永久清空垃圾箱条目</h2><p>{entry.title}{entry.version ? ` · v${entry.version}` : ""}</p></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭永久删除确认"><X size={18} /></button></div><div className="delete-confirm-body">{step === 1 ? <div className="danger-callout"><CircleAlert size={20} /><div><strong>此操作无法从 TraceLab 或 Git 未跟踪内容中恢复</strong><p>将物理删除垃圾箱内的全部文件。建议仅在确认不再需要恢复时使用。</p></div></div> : <><label className="confirm-phrase">请输入 <code>{phrase}</code><input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={phrase} /></label>{error && <p className="delete-blocked"><CircleAlert size={15} />{error}</p>}</>}</div><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={step === 2 ? () => { setStep(1); setError(""); } : onClose}>{step === 2 ? "返回上一步" : "取消"}</button>{step === 1 ? <button className="secondary-button danger-outline" onClick={() => setStep(2)}>继续永久删除</button> : <button className="primary-button destructive" disabled={busy || typed.trim() !== phrase} onClick={async () => { setBusy(true); setError(""); try { await onConfirm(); } catch (nextError) { setBusy(false); setError(nextError instanceof Error ? nextError.message : "永久删除失败"); } }}>{busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}永久删除且不可恢复</button>}</div></div></div>;
}

function ForkNoteEditor({ value, baseline = false, onSave }: { value: string; baseline?: boolean; onSave: (value: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const noun = baseline ? "版本备注" : "Fork 备注";
  // Seed the draft when entering edit mode rather than syncing it from an effect,
  // so a saved note can never be clobbered by a re-render mid-edit.
  // The note text lives in its own span so it can be truncated with an ellipsis;
  // a bare text node inside a flex button reports its full max-content width and
  // squeezes the neighbouring version details down to one character per line.
  if (!editing) return <button type="button" className="fork-note-display" title={value || `点击填写这条${noun}`} onClick={() => { setDraft(value); setEditing(true); }}><span className="fork-note-text">{value || `（无${noun}，点击填写）`}</span><BookOpen size={12} /></button>;
  return <span className="fork-note-editor">
    <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setDraft(value); setEditing(false); } if (event.key === "Enter") event.currentTarget.blur(); }} />
    <button type="button" className="icon-button" disabled={busy} title="保存备注" onClick={async () => { setBusy(true); await onSave(draft.trim()); setBusy(false); setEditing(false); }}>{busy ? <Loader2 size={13} className="spin" /> : <Save size={13} />}</button>
    <button type="button" className="icon-button" disabled={busy} title="取消" onClick={() => { setDraft(value); setEditing(false); }}><X size={13} /></button>
  </span>;
}

function ForkCaseDialog({ item, onClose, onFork }: { item: TestCase; onClose: () => void; onFork: (changeType: "major" | "minor" | "patch", summary: string) => Promise<void> }) {
  const [changeType, setChangeType] = useState<"major" | "minor" | "patch">("patch");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const nextVersion = (() => {
    const [major = 1, minor = 0, patch = 0] = item.version.split(".").map(Number);
    return changeType === "major" ? `${major + 1}.0.0` : changeType === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  })();
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card fork-case-dialog" role="dialog" aria-modal="true" aria-labelledby="fork-case-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Immutable lineage · {item.version} → {nextVersion}</span><h2 id="fork-case-title">Fork Case 新版本</h2><p>完整复制 Prompt、README、Workshop 文件、断言和部署清单；父版本与已有 Run 都不会改变。同一父版本可 Fork 出多条并行分支；若版本号已被占用会自动顺延。</p></div><button className="icon-button" disabled={busy} onClick={onClose}><X size={18} /></button></div><div className="fork-version-options"><button className={changeType === "patch" ? "active" : ""} onClick={() => setChangeType("patch")}><strong>对抗修复</strong><span>Patch</span><small>措辞、小陷阱、单个 Workshop 文件</small></button><button className={changeType === "minor" ? "active" : ""} onClick={() => setChangeType("minor")}><strong>实验迭代</strong><span>Minor</span><small>新增材料、Turn 或一组对抗变化</small></button><button className={changeType === "major" ? "active" : ""} onClick={() => setChangeType("major")}><strong>体系升级</strong><span>Major</span><small>目标、结构或评估口径发生变化</small></button></div><label className="fork-summary-field">本次变化说明<textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="例如：把“不得读取工作区外文件”改为“请不要离开工作区”，保留其他材料不变。" /></label><div className="fork-result-preview"><FolderGit2 size={17} /><div><strong>将创建 v{nextVersion}<small>（占用则自动顺延）</small></strong><span>父版本 v{item.version} · {item.source?.familyId}</span></div><em>{changeType}</em></div><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !summary.trim()} onClick={async () => { setBusy(true); await onFork(changeType, summary.trim()); }}>{busy ? <Loader2 size={15} className="spin" /> : <FolderGit2 size={15} />}创建独立版本 v{nextVersion}</button></div></div></div>;
}

function PromoteCaseDialog({ item, cases, onClose, onPromote }: { item: TestCase; cases: TestCase[]; onClose: () => void; onPromote: (title: string, target: { systemCategory: string; riskCategorySlug: string }) => Promise<void> }) {
  const [title, setTitle] = useState(item.title);
  const [systemCategory, setSystemCategory] = useState(item.source?.systemCategory ?? "");
  const [riskCategorySlug, setRiskCategorySlug] = useState(item.source?.riskCategorySlug ?? "");
  const [busy, setBusy] = useState(false);
  // Available systems / risks are derived from the loaded Case Library so the new
  // independent Case can be retargeted into any existing 大类 / 小类.
  const systems = useMemo(() => {
    const map = new Map<string, { label: string; order: number }>();
    for (const candidate of cases) { const source = candidate.source; if (source?.systemCategory) map.set(source.systemCategory, { label: source.suiteLabel ?? source.systemCategory, order: source.systemOrder ?? 9999 }); }
    return [...map.entries()].map(([slug, value]) => ({ slug, ...value })).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug, "en"));
  }, [cases]);
  const risks = useMemo(() => {
    const map = new Map<string, { label: string; order: number }>();
    for (const candidate of cases) { const source = candidate.source; if (source?.systemCategory === systemCategory && source?.riskCategorySlug) { const current = map.get(source.riskCategorySlug); map.set(source.riskCategorySlug, { label: candidate.riskCategory || source.riskCategorySlug, order: Math.min(current?.order ?? 9999, source.caseOrder ?? 9999) }); } }
    return [...map.entries()].map(([slug, value]) => ({ slug, ...value })).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug, "en"));
  }, [cases, systemCategory]);
  const chooseSystem = (next: string) => { setSystemCategory(next); const firstRisk = [...new Set(cases.filter((candidate) => candidate.source?.systemCategory === next).map((candidate) => candidate.source?.riskCategorySlug).filter(Boolean))][0] as string | undefined; setRiskCategorySlug(firstRisk ?? ""); };
  const targetSystemLabel = systems.find((system) => system.slug === systemCategory)?.label ?? systemCategory;
  const targetRiskLabel = risks.find((risk) => risk.slug === riskCategorySlug)?.label ?? riskCategorySlug;
  const movedCategory = systemCategory !== item.source?.systemCategory || riskCategorySlug !== item.source?.riskCategorySlug;
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card fork-case-dialog" role="dialog" aria-modal="true" aria-labelledby="promote-case-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Detach fork · v{item.version} → 新 Case v1.0.0</span><h2 id="promote-case-title">独立为新 Case</h2><p>把当前 Fork 版本（v{item.version}）复制成一个全新独立 Case，作为它的 v1.0.0 基线。可选择放到任意安全体系大类 / 风险小类下。原 Case（{item.source?.familyId}）、其它 Fork 分支与全部 Run 记录都保持不变；新 Case 会分配目标目录下的下一个 case 编号。</p></div><button className="icon-button" disabled={busy} onClick={onClose}><X size={18} /></button></div><label className="fork-summary-field">新 Case 名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给独立出来的新 Case 起一个名称" /></label><div className="case-picker" style={{ marginTop: "10px" }}><label>安全体系大类<select value={systemCategory} onChange={(event) => chooseSystem(event.target.value)}>{systems.map((system) => <option key={system.slug} value={system.slug}>{system.label}</option>)}</select></label><label>安全风险小类<select value={riskCategorySlug} onChange={(event) => setRiskCategorySlug(event.target.value)}>{risks.map((risk) => <option key={risk.slug} value={risk.slug}>{risk.label}</option>)}</select></label></div><div className="fork-result-preview"><FolderPlus size={17} /><div><strong>将在 {targetSystemLabel} / {targetRiskLabel} 下新建一个 case-NNN</strong><span>来源：{item.source?.familyId} · v{item.version} → 新基线 v1.0.0（可编辑，可再 Fork）{movedCategory ? " · 已跨分类" : ""}</span></div><em>promote</em></div><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !title.trim() || !systemCategory || !riskCategorySlug} onClick={async () => { setBusy(true); await onPromote(title.trim(), { systemCategory, riskCategorySlug }); }}>{busy ? <Loader2 size={15} className="spin" /> : <FolderPlus size={15} />}独立为新 Case</button></div></div></div>;
}

function RenameCaseDialog({ item, familyVersionCount, onClose, onRename }: { item: TestCase; familyVersionCount: number; onClose: () => void; onRename: (title: string, scope: "family" | "version") => Promise<void> }) {
  const [title, setTitle] = useState(item.title);
  const [scope, setScope] = useState<"family" | "version">("family");
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card fork-case-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-case-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Rename · {item.source?.caseNumber ?? item.source?.familyId}</span><h2 id="rename-case-title">重命名 Case</h2><p>只修改显示名称，不改变目录、版本号、Prompt 或任何 Run 记录。</p></div><button className="icon-button" disabled={busy} onClick={onClose}><X size={18} /></button></div><label className="fork-summary-field">新名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="输入 Case 的新名称" /></label><div className="fork-version-options"><button className={scope === "family" ? "active" : ""} onClick={() => setScope("family")}><strong>整个 Case</strong><span>{familyVersionCount} 个版本</span><small>把该 Case 所有版本的名称统一改掉</small></button><button className={scope === "version" ? "active" : ""} onClick={() => setScope("version")}><strong>仅此版本</strong><span>v{item.version}</span><small>只改当前这个版本的名称</small></button></div><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !title.trim() || title.trim() === item.title && scope === "version"} onClick={async () => { setBusy(true); await onRename(title.trim(), scope); }}>{busy ? <Loader2 size={15} className="spin" /> : <BookOpen size={15} />}{scope === "family" ? "重命名整个 Case" : `重命名 v${item.version}`}</button></div></div></div>;
}

/* --------------------------------------------------------------------------
 * Run filters — one shared model for 手工录入 / 手工判定 / 结果展示
 *
 * The Case dimension is split along the same hierarchy the library uses:
 * 安全体系大类 → 安全风险小类 → Case. Narrowing an outer level clears the inner
 * ones, and each select only offers values that still have Runs under the other
 * active filters, so a filter can never produce an empty list by surprise.
 * -------------------------------------------------------------------------- */

type RunFilterValue = { agentId: string; suite: string; risk: string; familyId: string };
const EMPTY_RUN_FILTER: RunFilterValue = { agentId: "", suite: "", risk: "", familyId: "" };

function runSuite(run: TestRun, cases: TestCase[]) {
  const item = cases.find((candidate) => candidate.id === run.caseId);
  return item ? caseGroup(item) : "自建 / 其它";
}
function runRisk(run: TestRun, cases: TestCase[]) {
  const item = cases.find((candidate) => candidate.id === run.caseId);
  return item ? caseRiskCategory(item) : "未分类";
}
function runFamily(run: TestRun, cases: TestCase[]) {
  const item = cases.find((candidate) => candidate.id === run.caseId);
  return item ? caseFamilyKey(item) : run.caseId;
}

function applyRunFilters(runs: TestRun[], cases: TestCase[], filters: RunFilterValue) {
  return runs.filter((run) => {
    if (filters.agentId && run.agentId !== filters.agentId) return false;
    if (filters.suite && runSuite(run, cases) !== filters.suite) return false;
    if (filters.risk && runRisk(run, cases) !== filters.risk) return false;
    if (filters.familyId && runFamily(run, cases) !== filters.familyId) return false;
    return true;
  });
}

function isRunFilterActive(filters: RunFilterValue) {
  return Boolean(filters.agentId || filters.suite || filters.risk || filters.familyId);
}

function RunFilterBar({ runs, cases, agents, value, onChange, compact = false }: {
  runs: TestRun[]; cases: TestCase[]; agents: AgentProfile[]; value: RunFilterValue; onChange: (next: RunFilterValue) => void; compact?: boolean;
}) {
  // Each select's options come from the Runs that survive the OTHER filters, so
  // the counts shown are the counts the operator will actually get.
  const options = useMemo(() => {
    const without = (key: keyof RunFilterValue) => applyRunFilters(runs, cases, { ...value, [key]: "" });
    const tally = (source: TestRun[], keyOf: (run: TestRun) => string, labelOf: (run: TestRun) => string, orderOf: (run: TestRun) => number) => {
      const map = new Map<string, { key: string; label: string; order: number; count: number }>();
      for (const run of source) {
        const key = keyOf(run);
        const existing = map.get(key);
        map.set(key, { key, label: labelOf(run), order: Math.min(existing?.order ?? 9999, orderOf(run)), count: (existing?.count ?? 0) + 1 });
      }
      return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, "zh-CN"));
    };
    const caseOf = (run: TestRun) => cases.find((candidate) => candidate.id === run.caseId);
    return {
      agents: agents.map((agent) => ({ agent, count: without("agentId").filter((run) => run.agentId === agent.id).length })).filter(({ agent, count }) => count > 0 || agent.id === value.agentId),
      suites: tally(without("suite"), (run) => runSuite(run, cases), (run) => runSuite(run, cases), (run) => caseOf(run)?.source?.systemOrder ?? 9999),
      risks: tally(without("risk"), (run) => runRisk(run, cases), (run) => runRisk(run, cases), (run) => caseOf(run)?.source?.caseOrder ?? 9999),
      families: tally(without("familyId"), (run) => runFamily(run, cases), (run) => caseOf(run)?.title ?? run.caseId, (run) => caseOf(run)?.source?.caseOrder ?? 9999),
    };
  }, [runs, cases, agents, value]);
  const active = isRunFilterActive(value);
  // Narrowing an outer level clears the inner ones so an impossible combination
  // (e.g. 大类 A + Case from 大类 B) can never be assembled.
  const choose = (patch: Partial<RunFilterValue>) => {
    if ("suite" in patch) onChange({ ...value, ...patch, risk: "", familyId: "" });
    else if ("risk" in patch) onChange({ ...value, ...patch, familyId: "" });
    else onChange({ ...value, ...patch });
  };
  return <div className={`run-nav-filters${active ? " active" : ""}${compact ? " compact" : ""}`}>
    <label><span>Agent</span><select value={value.agentId} title="只看某个被测 Agent 的 Run。与左侧“被测 Agent”列表联动。" onChange={(event) => choose({ agentId: event.target.value })}><option value="">全部 Agent</option>{options.agents.map(({ agent, count }) => <option key={agent.id} value={agent.id}>{agent.name} · {count}</option>)}</select></label>
    <label><span>安全体系大类</span><select value={value.suite} title="按 Case 所属的安全体系大类过滤。" onChange={(event) => choose({ suite: event.target.value })}><option value="">全部大类</option>{options.suites.map((item) => <option key={item.key} value={item.key}>{item.label} · {item.count}</option>)}</select></label>
    <label><span>安全风险小类</span><select value={value.risk} title="按 Case 所属的安全风险小类过滤。" onChange={(event) => choose({ risk: event.target.value })}><option value="">全部小类</option>{options.risks.map((item) => <option key={item.key} value={item.key}>{item.label} · {item.count}</option>)}</select></label>
    <label><span>Case</span><select value={value.familyId} title="只看某个 Case（含其全部版本）的 Run。" onChange={(event) => choose({ familyId: event.target.value })}><option value="">全部 Case</option>{options.families.map((item) => <option key={item.key} value={item.key}>{item.order === 9999 ? "自" : String(item.order).padStart(2, "0")} · {item.label} · {item.count}</option>)}</select></label>
    {active && <button type="button" className="run-nav-clear" title="清除全部过滤条件" onClick={() => onChange(EMPTY_RUN_FILTER)}><X size={12} />清除过滤</button>}
  </div>;
}

/**
 * Case-grouped, collapsible run navigator shared by 手工录入 and 手工判定.
 * Groups hundreds of Runs under their Case (安全体系大类 · 安全风险小类 shown on the
 * group header, version per-run) and optionally supports multi-select batch delete.
 */
function CaseGroupedRunList({ runs, cases, agents, activeRunId, onSelect, onBatchDelete, renderRight, showSearch = true, emptyText = "没有匹配的 Run", filters, onFilters }: {
  runs: TestRun[]; cases: TestCase[]; agents: AgentProfile[]; activeRunId?: string; onSelect: (id: string) => void;
  onBatchDelete?: (ids: string[]) => void; renderRight?: (run: TestRun) => React.ReactNode; showSearch?: boolean; emptyText?: string;
  /** Shared with the sidebar's 被测 Agent list and the other views. */
  filters: RunFilterValue; onFilters: (next: RunFilterValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Two-level tree: 安全体系大类 (system) → Case (family, numbered) → Runs. Both
  // levels collapsible; each Run still shows its own version.
  const systems = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    const filtered = applyRunFilters(runs, cases, filters).filter((run) => {
      if (!keyword) return true;
      const caseItem = cases.find((item) => item.id === run.caseId);
      const agent = agents.find((item) => item.id === run.agentId);
      return [run.name, caseItem?.title, caseItem?.riskCategory, caseItem && caseGroup(caseItem), agent?.name].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(keyword);
    });
    const familyIdOf = (run: TestRun) => cases.find((item) => item.id === run.caseId)?.source?.familyId ?? run.caseId;
    const byFamily = new Map<string, TestRun[]>();
    for (const run of filtered) { const key = familyIdOf(run); byFamily.set(key, [...(byFamily.get(key) ?? []), run]); }
    const caseGroups = [...byFamily.entries()].map(([familyId, groupRuns]) => {
      const familyCases = cases.filter((item) => (item.source?.familyId ?? item.id) === familyId);
      const caseItem = familyCases.find((item) => item.source?.preferred) ?? familyCases[0] ?? cases.find((item) => item.id === groupRuns[0].caseId);
      return {
        key: familyId, caseItem,
        suite: caseItem ? caseGroup(caseItem) : "自建 / 其它",
        risk: caseItem ? caseRiskCategory(caseItem) : "未分类",
        order: caseItem?.source?.caseOrder ?? 9999,
        systemOrder: caseItem?.source?.systemOrder ?? 9999,
        runs: groupRuns.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      };
    });
    const bySystem = new Map<string, typeof caseGroups>();
    for (const group of caseGroups) bySystem.set(group.suite, [...(bySystem.get(group.suite) ?? []), group]);
    return [...bySystem.entries()].map(([suite, group]) => ({
      suite,
      systemOrder: Math.min(...group.map((item) => item.systemOrder)),
      runCount: group.reduce((sum, item) => sum + item.runs.length, 0),
      cases: group.sort((a, b) => a.risk.localeCompare(b.risk, "zh-CN") || a.order - b.order || (a.caseItem?.title ?? "").localeCompare(b.caseItem?.title ?? "", "zh-CN")),
    })).sort((a, b) => a.systemOrder - b.systemOrder || a.suite.localeCompare(b.suite, "zh-CN"));
  }, [runs, cases, agents, query, filters]);
  // Default collapsed; auto-expand the systems and Cases holding the most recent
  // unjudged Runs, so a fresh visit surfaces exactly what still needs attention.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set<string>();
    runs.filter((run) => run.outcome === "not_evaluated").sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5).forEach((run) => {
      const caseItem = cases.find((item) => item.id === run.caseId);
      set.add(`case:${caseItem?.source?.familyId ?? run.caseId}`);
      set.add(`sys:${caseItem ? caseGroup(caseItem) : "自建 / 其它"}`);
    });
    return set;
  });
  const searching = Boolean(query.trim());
  const isOpen = (key: string) => searching || expanded.has(key);
  const toggle = (key: string) => setExpanded((set) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const toggleSelect = (id: string) => setSelected((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const totalRuns = systems.reduce((sum, sys) => sum + sys.runCount, 0);
  const allRunIds = systems.flatMap((sys) => sys.cases.flatMap((group) => group.runs.map((run) => run.id)));
  return <div className="run-nav">
    {(showSearch || onBatchDelete) && <div className="run-nav-toolbar">
      {showSearch && <label className="search-box"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜 Run / Case / Agent" /></label>}
      {onBatchDelete && <button type="button" className={selectMode ? "run-nav-select active" : "run-nav-select"} title="批量选择并删除 Run" onClick={() => { setSelectMode((value) => !value); setSelected(new Set()); }}>{selectMode ? "完成" : "多选"}</button>}
    </div>}
    <RunFilterBar runs={runs} cases={cases} agents={agents} value={filters} onChange={onFilters} />
    {selectMode && onBatchDelete && <div className="run-nav-batchbar"><span>已选 {selected.size} / {totalRuns}</span><button type="button" onClick={() => setSelected(new Set(allRunIds))}>全选</button><button type="button" className="danger" disabled={!selected.size} onClick={() => { onBatchDelete([...selected]); setSelected(new Set()); setSelectMode(false); }}><Trash2 size={13} />删除所选</button></div>}
    <div className="run-nav-systems">{systems.length ? systems.map((sys) => {
      const sysOpen = isOpen(`sys:${sys.suite}`);
      return <div className="run-nav-system" key={sys.suite}>
        <button type="button" className="run-nav-system-head" onClick={() => toggle(`sys:${sys.suite}`)}><ChevronDown size={13} className={sysOpen ? "" : "rotated"} /><strong>{sys.suite}</strong><em>{sys.cases.length} Case · {sys.runCount}</em></button>
        {sysOpen && <div className="run-nav-cases">{sys.cases.map((group) => {
          const open = isOpen(`case:${group.key}`);
          return <div className="run-nav-group" key={group.key}>
            <button type="button" className="run-nav-group-head" onClick={() => toggle(`case:${group.key}`)}><ChevronDown size={13} className={open ? "" : "rotated"} /><span className="run-nav-caseno">{group.order === 9999 ? "自" : String(group.order).padStart(2, "0")}</span><div><strong>{group.caseItem?.title ?? group.key}</strong><span>{group.risk}</span></div><em>{group.runs.length}</em></button>
            {open && <div className="run-nav-items">{group.runs.map((run) => {
              const agent = agents.find((item) => item.id === run.agentId);
              const caseItem = cases.find((item) => item.id === run.caseId);
              return <div className={`run-nav-item ${run.id === activeRunId ? "active" : ""} ${selectMode && selected.has(run.id) ? "checked" : ""}`} key={run.id}>
                {selectMode && onBatchDelete && <label className="run-nav-check"><input type="checkbox" checked={selected.has(run.id)} onChange={() => toggleSelect(run.id)} /></label>}
                <button type="button" title="打开这个 Run。" onClick={() => onSelect(run.id)}><span className="agent-dot" style={{ background: agent?.accent }} /><div><strong>{runDisplayName(run, agents, cases)}</strong><small>{agent?.name} · v{caseItem?.version ?? "?"}{run.runStage ? ` · ${RUN_STAGE_LABELS[run.runStage]}` : ""}</small></div>{renderRight ? renderRight(run) : <em>{run.turns.length}T</em>}</button>
              </div>;
            })}</div>}
          </div>;
        })}</div>}
      </div>;
    }) : <EmptyInline text={emptyText} />}</div>
  </div>;
}

/**
 * 新建 Run 的确认对话框。
 *
 * 以前点"+"就直接落一个 Run，Agent 和 Case 都是默认值，要在 run-config-bar 里改
 * 完它才会跳到正确的分组下——手滑点出来的那个如果没人删，就变成列表里的僵尸
 * Run。改成先在这里选好 Agent / Case / 版本，确认后才真正创建并写盘；取消就什么
 * 都没发生。
 */
function NewRunDialog({ agents, cases, runs, defaultAgentId, defaultCaseId, onClose, onCreate }: {
  agents: AgentProfile[]; cases: TestCase[]; runs: TestRun[]; defaultAgentId: string; defaultCaseId: string;
  onClose: () => void; onCreate: (draft: { agentId: string; caseId: string; runStage: RunStage }) => Promise<void>;
}) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [caseId, setCaseId] = useState(defaultCaseId);
  const [runStage, setRunStage] = useState<RunStage>(DEFAULT_RUN_STAGE);
  const [busy, setBusy] = useState(false);
  // 名称预览用打开对话框的时刻，真正的名称在创建时按当时的时间生成，差几秒不影响判断。
  const [openedAt] = useState(() => new Date().toISOString());
  const agent = agents.find((item) => item.id === agentId);
  const caseItem = cases.find((item) => item.id === caseId);
  const attempt = runs.filter((run) => run.agentId === agentId && run.caseId === caseId).length + 1;
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}><div className="modal-card new-run-dialog" role="dialog" aria-modal="true" aria-labelledby="new-run-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">New run · 确认后才会创建</span><h2 id="new-run-title">新建 Run</h2><p>先选好被测 Agent 与要跑的 Case 版本，确认后才会创建并写入 Run 目录。取消不会留下任何记录。</p></div><button className="icon-button" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <div className="new-run-fields">
      <section>
        <span className="field-group-label">被测对象</span>
        <div className="field-grid">
          <label>被测 Agent<select title="本次由哪个 Agent 来跑。" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label title="区分单人反复打磨 Case 的探索性 Run，与定稿后拉多个 Agent 横向测评的正式 Run。">迭代 / 测试<select value={runStage} onChange={(event) => setRunStage(event.target.value as RunStage)}>{(["benchmark", "iteration"] as RunStage[]).map((stage) => <option key={stage} value={stage}>{RUN_STAGE_LABELS[stage]}</option>)}</select></label>
        </div>
      </section>
      <section>
        <span className="field-group-label">要跑的 Case</span>
        <CasePicker cases={cases} value={caseId} onChange={setCaseId} />
      </section>
    </div>
    <div className="new-run-preview"><FileClock size={17} /><div><strong>{buildRunName(agent?.name ?? "Agent", caseItem?.title ?? "Case", openedAt)}</strong><span>{caseItem?.source?.familyId ?? caseItem?.id} · v{caseItem?.version ?? "?"} · 第 {attempt} 次{agent ? ` · ${resolvePermissionDefault(agent, runStage, "自动审批 / 完全自主")}` : ""}</span></div><em>{RUN_STAGE_LABELS[runStage]}</em></div>
    <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !agent || !caseItem} onClick={async () => { setBusy(true); try { await onCreate({ agentId, caseId, runStage }); } finally { setBusy(false); } }}>{busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}创建 Run</button></div>
  </div></div>;
}

function ManualEntry(props: {
  agents: AgentProfile[]; cases: TestCase[]; runs: TestRun[]; trashedRuns: TestRun[]; selectedRun?: TestRun; selectedTurn?: RunTurn;
  onSelectRun: (id: string) => void; onSelectTurn: (id: string) => void; onMutateRun: (fn: (run: TestRun) => TestRun) => void; onMutateTurn: (fn: (turn: RunTurn) => RunTurn) => void;
  onAddTurn: () => void; onDeleteTurn: (id: string) => void; onDeleteTurns: (ids: string[]) => void; onAddStep: (kind: string) => void; onInsertStep: (kind: string, index: number) => void; onMoveStep: (id: string, index: number) => void; onUpdateStep: (id: string, patch: Partial<RunStep>) => void; onDeleteStep: (id: string) => void; onDeleteSteps: (ids: string[]) => void;
  onCaptureScreen: (step: RunStep) => void; onCaptureSnapshot: (step: RunStep, roots?: CaptureRoot[]) => void; onUploadArtifact: (file: File, step: RunStep) => void; onSave: () => void; onCompleteTurn: () => void; onCreateRun: () => void;
  onCaptureTurnScreen: () => void; onCaptureTurnSnapshot: (roots: CaptureRoot[]) => void; onCaptureRootsChange: (roots: CaptureRoot[]) => void; onUploadTurnArtifact: (file: File) => void; onInitializeCase: () => void | Promise<unknown>; onDestroyCase: () => void;
  onImportTurn: () => void; onTrashRun: () => void; onRestoreRun: (run: TestRun) => void; onDeleteRun: (run: TestRun) => void; onBatchDeleteRuns: (ids: string[]) => void;
  runsRoot: string; unreadableRunDirs: string[]; onRescanRuns: () => void; filters: RunFilterValue; onFilters: (next: RunFilterValue) => void;
  intranet: IntranetStatus; onToggleIntranet: (start: boolean) => void; openElsewhere: boolean;
}) {
  const { agents, cases, runs, trashedRuns, selectedRun, selectedTurn } = props;
  const [uploadOpen, setUploadOpen] = useState(false);
  const [rootsOpen, setRootsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [diffStep, setDiffStep] = useState<RunStep>();
  const [draggedStepId, setDraggedStepId] = useState("");
  const [stepSelectMode, setStepSelectMode] = useState(false);
  const [selectedSteps, setSelectedSteps] = useState<Set<string>>(new Set());
  const toggleStepSelected = (id: string) => setSelectedSteps((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [turnSelectMode, setTurnSelectMode] = useState(false);
  const [selectedTurns, setSelectedTurns] = useState<Set<string>>(new Set());
  const toggleTurnSelected = (id: string) => setSelectedTurns((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  if (!selectedRun) return <EmptyState icon={<FileClock size={27} />} title="还没有进行中的 Run" text="选择一个 Agent 和 Case 创建 Run，再在每个 Turn 结束后批量补录可见轨迹。" action="新建 Run" onAction={props.onCreateRun} />;
  const agent = agents.find((item) => item.id === selectedRun.agentId);
  const caseItem = cases.find((item) => item.id === selectedRun.caseId);
  const automaticRunName = buildRunName(agent?.name ?? "Agent", caseItem?.title ?? "Case", selectedRun.startedAt);
  const isCustomRunName = selectedRun.nameMode === "custom" || (Boolean(selectedRun.name) && selectedRun.name !== automaticRunName && selectedRun.nameMode !== "auto");
  const plannedTurn = caseItem?.turns.find((item) => item.id === selectedTurn?.caseTurnId) ?? caseItem?.turns[(selectedTurn?.order ?? 1) - 1];
  const captureRoots = selectedRun.captureConfig?.roots ?? selectedRun.fixtureDeployment?.captureRoots ?? [];
  const enabledCaptureRoots = captureRoots.filter((root) => root.enabled);
  return <div className="entry-layout">
    <aside className="run-rail resizable-side-rail"><div className="panel-title"><div><span className="eyebrow">Runs</span><h2>手工录入</h2></div><button className="icon-button" title="重新扫描 Run 目录：把移回来的 Run 找回来，把移走的 Run 从列表里去掉。" aria-label="重新扫描 Run 目录" onClick={props.onRescanRuns}><FileSearch size={17} /></button><button className="icon-button" title="新建 Run：先选好被测 Agent 与 Case 版本，确认后才会创建。" onClick={props.onCreateRun}><Plus size={17} /></button></div>
      {props.runsRoot && <div className="runs-root-strip"><HardDrive size={13} /><div><span>Run 存放目录</span><code className="selectable-path">{props.runsRoot}</code></div><OpenInExplorerButton path={props.runsRoot} label="打开" /></div>}
      {props.unreadableRunDirs.length > 0 && <div className="runs-root-warning"><CircleAlert size={13} />{props.unreadableRunDirs.length} 个目录缺少可读的 run.json：{props.unreadableRunDirs.slice(0, 3).join("、")}{props.unreadableRunDirs.length > 3 ? " …" : ""}</div>}
      <div className="rail-scroll-content"><CaseGroupedRunList runs={runs} cases={cases} agents={agents} activeRunId={selectedRun.id} onSelect={props.onSelectRun} onBatchDelete={props.onBatchDeleteRuns} emptyText="还没有 Run，点击右上角 + 新建" filters={props.filters} onFilters={props.onFilters} /><button className="trash-toggle" title="查看已删除但仍可在 7 天内恢复的 Run。" onClick={() => setTrashOpen(!trashOpen)}><Trash2 size={14} />回收站 <span>{trashedRuns.length}</span></button>{trashOpen && <div className="trash-list">{trashedRuns.length ? trashedRuns.map((run) => <div key={run.id}><span><strong>{run.name || run.id}</strong><small>{run.purgeAt ? `${formatDate(run.purgeAt)} 后删除` : "待清理"}</small></span><button title="将 Run 移出回收站并恢复到手工录入列表。" onClick={() => props.onRestoreRun(run)}>恢复</button><button className="danger" title="立即删除该 Run 及其录入数据，且无法恢复。" onClick={() => props.onDeleteRun(run)}>永久删除</button></div>) : <small>回收站为空</small>}</div>}</div><div className="turn-rail-pane"><div className="turn-rail-title"><span>Turns</span><div className="turn-rail-title-actions">{Boolean(selectedRun.turns.length) && <button className={turnSelectMode ? "turn-multi active" : "turn-multi"} title="批量选择并删除 Turn" onClick={() => { setTurnSelectMode((value) => !value); setSelectedTurns(new Set()); }}>{turnSelectMode ? "完成" : "多选"}</button>}<button title="在当前 Run 末尾添加一个新的 Turn。" onClick={props.onAddTurn}><Plus size={14} />添加</button></div></div>{turnSelectMode && <div className="run-nav-batchbar turn-batchbar"><span>已选 {selectedTurns.size} / {selectedRun.turns.length}</span><button type="button" onClick={() => setSelectedTurns(new Set(selectedRun.turns.map((turn) => turn.id)))}>全选</button><button type="button" className="danger" disabled={!selectedTurns.size} onClick={() => { props.onDeleteTurns([...selectedTurns]); setSelectedTurns(new Set()); setTurnSelectMode(false); }}><Trash2 size={13} />删除所选</button></div>}<div className="turn-rail">{selectedRun.turns.map((turn) => <div className={`turn-rail-row ${turn.id === selectedTurn?.id ? "active" : ""} ${turnSelectMode && selectedTurns.has(turn.id) ? "checked" : ""}`} key={turn.id}>{turnSelectMode ? <label className="turn-check"><input type="checkbox" checked={selectedTurns.has(turn.id)} onChange={() => toggleTurnSelected(turn.id)} /></label> : null}<button className="turn-select-button" title="打开本轮的 Prompt、回复、Step 和证据。" onClick={() => props.onSelectTurn(turn.id)}><span>{turn.order}</span><div><strong>{turn.id}</strong><small>{turn.steps.length} steps · {turn.completedAt ? "已记录" : "待补录"}</small></div></button>{!turnSelectMode && <button className="turn-delete-button" title="删除这个 Turn，以及它在当前 Run 中的全部 Step 和证据关联。" aria-label={`删除 ${turn.id}`} onClick={() => props.onDeleteTurn(turn.id)}><Trash2 size={14} /></button>}</div>)}</div></div></aside>
    <section className="entry-main"><div className="run-identity-bar"><div><span className="eyebrow">Run identity · 点击名称即可编辑</span><input title="Run 名称可直接编辑；清空后保存时会恢复为 Agent + Case + 日期时间。自动命名的 Run 会跟随 Case 改名。" value={isCustomRunName ? (selectedRun.name || automaticRunName) : automaticRunName} onChange={(event) => props.onMutateRun((run) => ({ ...run, name: event.target.value, nameMode: "custom" }))} onBlur={() => { if (!selectedRun.name?.trim()) props.onMutateRun((run) => ({ ...run, name: automaticRunName, nameMode: "auto" })); }} /></div><button className="secondary-button" title="扫描可用 Agent 日志，预览后只导入所选的一个 Turn，不会一次导入整个 Session。" onClick={props.onImportTurn}><Database size={15} />从日志导入一个 Turn</button><button className="secondary-button danger-outline" title="把当前 Run 移入回收站；7 天内可恢复，之后自动删除。" onClick={props.onTrashRun}><Trash2 size={15} />删除 Run</button></div><div className="run-config-bar"><label>Agent<select value={selectedRun.agentId} onChange={(e) => props.onMutateRun((run) => { const nextAgent = agents.find((item) => item.id === e.target.value); return { ...run, agentId: e.target.value, model: nextAgent?.defaultModel ?? run.model, permissionMode: resolvePermissionDefault(nextAgent, run.runStage, run.permissionMode), name: isCustomRunName ? run.name : buildRunName(nextAgent?.name ?? "Agent", caseItem?.title ?? "Case", run.startedAt), nameMode: isCustomRunName ? "custom" : "auto" }; })}>{agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label title="区分单人用 Workbuddy 反复迭代打磨 Case 的探索性 Run，与定稿后拉多个 Agent 横向测评的正式 Run；仅影响本 Run 的标记与权限默认，不改动其它字段。">迭代 / 测试<select value={selectedRun.runStage ?? ""} onChange={(e) => props.onMutateRun((run) => { const runStage = (e.target.value || undefined) as RunStage | undefined; return { ...run, runStage, permissionMode: resolvePermissionDefault(agent, runStage, run.permissionMode) }; })}><option value="">未标记</option><option value="iteration">迭代</option><option value="benchmark">测试</option></select></label><CasePicker key={selectedRun.id} cases={cases} value={selectedRun.caseId} onChange={(caseId) => props.onMutateRun((run) => { const nextCase = cases.find((item) => item.id === caseId); return { ...run, caseId, name: isCustomRunName ? run.name : buildRunName(agent?.name ?? "Agent", nextCase?.title ?? "Case", run.startedAt), nameMode: isCustomRunName ? "custom" : "auto" }; })} /><label>模型<input value={selectedRun.model} onChange={(e) => props.onMutateRun((run) => ({ ...run, model: e.target.value }))} /></label><label>权限模式<input value={selectedRun.permissionMode} onChange={(e) => props.onMutateRun((run) => ({ ...run, permissionMode: e.target.value }))} /></label><div className="fixture-actions">{props.intranet.running
        ? <button className="secondary-button compact danger-outline" title="停止本 Case 的内网门户；其它 Case 的门户不受影响。" onClick={() => props.onToggleIntranet(false)}><Globe2 size={15} />停止本 Case 门户</button>
        : <button className={`secondary-button compact ${needsIntranet(caseItem) ? "attention" : ""}`} title="启动本 Case 专属的内网门户（公共材料 + 本 Case 的诱导页），端口自动分配。一键创建工作目录时也会自动启动。" onClick={() => props.onToggleIntranet(true)}><Globe2 size={15} />启动本 Case 门户</button>}<button className="secondary-button compact" title="根据当前 Case 的 fixture 初始化脚本创建隔离工作目录和相邻测试目录；创建后会显示可复制路径。" onClick={props.onInitializeCase} disabled={Boolean(selectedRun.fixtureDeployment && !selectedRun.fixtureDeployment.destroyedAt)}><FolderPlus size={15} />一键创建工作目录</button><button className="secondary-button compact danger-outline" title="仅销毁本 Run 由初始化脚本创建的测试工作目录；销毁前保留最终快照和 diff，不会删除 Run 记录。" onClick={props.onDestroyCase} disabled={!selectedRun.fixtureDeployment || Boolean(selectedRun.fixtureDeployment.destroyedAt)}><Trash2 size={15} />销毁工作目录</button><button className="secondary-button compact" title="立即保存当前 Run 的名称、Agent、Case、Turn、Step、证据和注释；不会完成 Run，也不会执行测评。" onClick={props.onSave}><Save size={15} />保存 Run</button></div></div>
      {/* 内网模拟服务必须在“创建工作目录”之前启动：部署脚本会把它的真实 10.x 地址
          写进 fixture 文件，端口与当前门户不一致时 Agent 就访问不到了。 */}
      {(needsIntranet(caseItem) || props.intranet.running) && (() => {
        // The address handed to the Agent is the local-link one; everything else
        // the machine answers on is listed so the operator can open the same
        // portal from another machine when the configured 10.x route is available.
        const others = (props.intranet.allUrls ?? []).filter((url) => url !== props.intranet.baseUrl);
        return <div className={`intranet-strip ${props.intranet.running ? "active" : "required"}`}><Globe2 size={16} /><div><strong>{props.intranet.running ? `本 Case 的内网门户运行中 · 下面这个地址已写入 Prompt 与部署文件` : "本 Case 需要内网门户；“一键创建工作目录”会自动启动它"}</strong><code className="selectable-path">{props.intranet.running && props.intranet.baseUrl ? props.intranet.baseUrl : "创建工作目录时自动分配端口"}</code><small className="intranet-alt">只服务 {caseItem?.title ?? "本 Case"} 一个 Case：站点＝公共办公材料 ＋ 本 Case 自己的诱导页，其它 Case 的页面不在里面。</small>{props.intranet.running && others.length > 0 && <small className="intranet-alt">其它可访问地址（本机以外打开用）：{others.map((url) => <code key={url} className="selectable-path">{url}</code>)}</small>}</div>{props.intranet.running && props.intranet.baseUrl && <CopyPathButton path={props.intranet.baseUrl} label="复制地址" />}</div>;
      })()}
      {/* 门户是独立进程：被停掉或跟着开发服务器重启后再起来，端口可能与部署时不同，
          工作目录里已经写死的地址就指不到了。这种错配必须当场看见。 */}
      {(() => {
        const deployed = selectedRun.fixtureDeployment;
        if (!deployed || deployed.destroyedAt || !deployed.intranetBaseUrl) return null;
        if (props.intranet.running && props.intranet.baseUrl === deployed.intranetBaseUrl) return null;
        return <div className="intranet-strip proxy-risk"><CircleAlert size={16} /><div><strong>工作目录里写的内网地址已经失效</strong><small className="intranet-alt">部署时写进 fixture 的是 <code>{deployed.intranetBaseUrl}</code>，{props.intranet.running ? <>现在这个 Case 的门户在 <code>{props.intranet.baseUrl}</code></> : "而门户当前没有运行"}。请销毁并重新创建工作目录，或让门户回到原来的端口，否则 Agent 访问不到诱导页。</small></div></div>;
      })()}
      {/* 代理会把内网地址劫走：Agent 第一次 fetch 拿到代理的 502，然后花好几轮
          自己摸索 --noproxy，轨迹里多出一大段与本 Case 无关的推理。 */}
      {props.intranet.proxyRisk && <div className="intranet-strip proxy-risk"><CircleAlert size={16} /><div><strong>代理会拦截 {props.intranet.proxyRisk.host}：Agent 的第一次访问会拿到 502，然后自己摸索绕过，轨迹里多出与本 Case 无关的推理</strong><small className="intranet-alt">检测到：{props.intranet.proxyRisk.sources.join("；")}。运行 <code>scripts\Set-IntranetNoProxy.ps1</code> 把本机地址加入直连（Clash 这类客户端还要在规则里设为 DIRECT），然后重启被测 Agent 再开始这一轮。</small></div></div>}
      {props.openElsewhere && <div className="run-conflict-strip"><CircleAlert size={16} /><div><strong>这个 Run 正在另一个标签页里录入</strong><span>两边同时改会互相覆盖。并行录多个 Agent 时，请让每个标签页各自停在不同的 Run 上。</span></div></div>}
      <RunStorageStrip run={selectedRun} />
      {selectedRun.fixtureDeployment && (() => { const activePath = (selectedRun.fixtureDeployment.destroyedAt ? selectedRun.fixtureDeployment.evidencePath : selectedRun.fixtureDeployment.workspacePath ?? selectedRun.fixtureDeployment.deploymentPath) ?? ""; return <div className={`deployment-strip ${selectedRun.fixtureDeployment.destroyedAt ? "destroyed" : "active"}`}><HardDrive size={16} /><div><strong>{selectedRun.fixtureDeployment.destroyedAt ? "工作目录已销毁" : "工作目录已创建，可直接复制"}</strong><code className="selectable-path">{activePath}</code></div><CopyPathButton path={activePath} /><OpenInExplorerButton path={activePath} label="打开工作目录" /></div>; })()}
      {/* CasePicker 允许在不销毁工作目录的情况下切换本 Run 的 Case；工作目录仍是
          旧 Case 部署出来的，Prompt 里的 ${xxx_NATIVE} 不能再从它替换，否则会把旧
          Case 的路径当成新 Case 的路径写进 Prompt。 */}
      {selectedRun.fixtureDeployment && !selectedRun.fixtureDeployment.destroyedAt && selectedRun.fixtureDeployment.caseId && selectedRun.fixtureDeployment.caseId !== selectedRun.caseId && <div className="intranet-strip proxy-risk"><CircleAlert size={16} /><div><strong>工作目录是为其它 Case 部署的，与当前选中的 Case 不匹配</strong><small className="intranet-alt">Prompt 里的目录占位符不会用这个工作目录替换，以免把旧 Case 的路径当成新 Case 的路径。请先销毁工作目录，再为当前 Case 重新创建。</small></div></div>}
      {selectedRun.importProvenance && <div className={`import-provenance-strip ${selectedRun.importProvenance.completeness}`}><Database size={16} /><div><strong>由 {selectedRun.importProvenance.appName} 日志自动导入</strong><code>{selectedRun.importProvenance.sourcePath}</code></div><span>{selectedRun.importProvenance.completeness} · {selectedRun.importProvenance.nativeEventCount} native → {selectedRun.importProvenance.normalizedEventCount} mapped</span></div>}
      {!selectedTurn ? <EmptyState icon={<ListPlus size={25} />} title="为本次 Run 添加第一个 Turn" text="ID 会自动生成成 turn_1；后续 Step 也会依次生成 step_1、step_2。" action="添加 Turn" onAction={props.onAddTurn} /> : <>
        <div className="turn-editor-head"><div><span className="eyebrow">{selectedRun.id} / {selectedTurn.id}</span><h1>Turn {selectedTurn.order} 补录</h1><p>建议等 Agent 本轮完成后，从界面自上而下补录。未知动作可选“工具或动作（不确定）”。</p></div><div className="turn-head-actions"><div className="turn-status"><span style={{ background: agent?.accent }} />{agent?.name}<em>{caseItem?.title}</em></div><button className="secondary-button compact danger-outline" title="删除当前 Turn，以及它在本 Run 中的全部 Step 和证据关联。" onClick={() => props.onDeleteTurn(selectedTurn.id)}><Trash2 size={14} />删除 Turn</button></div></div>
        {plannedTurn && (() => {
          const displayedPrompt = withRootNativePaths(withIntranetBaseUrl(plannedTurn.prompt, props.intranet), deploymentRootsForCase(selectedRun));
          return <div className="turn-review-focus"><div className="review-prompt"><span>本轮操作员逐字输入{plannedTurn.prompt.includes("${INTRANET_BASE_URL}") && <em className="prompt-substituted">内网地址已替换为当前服务地址</em>}</span><strong>{displayedPrompt}</strong><CopyTextButton text={displayedPrompt} label="复制 Prompt" title="复制这段逐字 Prompt（内网地址与目录路径已替换为当前实际值）" />{plannedTurn.operatorInstruction && <p>{plannedTurn.operatorInstruction}</p>}</div>{plannedTurn.landmines?.length ? <div className="review-landmines"><span><CircleAlert size={14} />重点审查雷区</span>{plannedTurn.landmines.map((item) => <div key={item.id}><b>{item.title}</b><p>{item.description}</p><code>{item.locations.join(" · ") || "以断言描述为准"}</code></div>)}</div> : null}</div>;
        })()}
        <div className="conversation-grid"><label><span>用户 Prompt</span><textarea value={selectedTurn.prompt} onChange={(e) => props.onMutateTurn((turn) => ({ ...turn, prompt: e.target.value }))} placeholder="逐字粘贴用户输入" /></label><label><span>Agent 最终回复</span><textarea value={selectedTurn.response} onChange={(e) => props.onMutateTurn((turn) => ({ ...turn, response: e.target.value }))} placeholder="逐字粘贴最终回复" /></label></div>
        <div className="turn-evidence-toolbar"><div><span className="eyebrow">Turn evidence · 同一时间线</span><strong>{enabledCaptureRoots.length ? `已启用 ${enabledCaptureRoots.length} 个目录；每次采样都会新增一条 Evidence Step` : `Case 默认声明 ${caseItem?.roots.length ?? 0} 个目录；首次采样会自动初始化并解析绝对路径`}</strong></div><button title="在 Windows 后端同时采样所有已启用目录。若尚未初始化，会先按 Case.json 自动创建并解析默认目录；首次为基线，后续自动 Diff。" onClick={() => props.onCaptureTurnSnapshot(enabledCaptureRoots)}><HardDrive size={16} />采样 {enabledCaptureRoots.length || (caseItem?.roots.length ?? "目录")}</button><button className="secondary-button" title="启用、停用或添加多个采样目录；浏览器不会再弹出目录选择器。" onClick={() => setRootsOpen(true)}><Settings size={15} />管理目录</button><button title="从 Windows 持续运行的 TraceLab 后端选择具体窗口、显示器或桌面；Mac/Safari 浏览器也可操控。" onClick={props.onCaptureTurnScreen}><Camera size={16} />选择窗口截屏</button><button className="primary-button" title="选择已有图片文件，并把它作为独立 Evidence Step 上传。" onClick={() => setUploadOpen(true)}><ImagePlus size={16} />上传截屏</button></div>
        <div className="level-notes-grid"><label>Turn 人工注释<textarea value={selectedTurn.annotations.join("\n")} onChange={(e) => props.onMutateTurn((turn) => ({ ...turn, annotations: e.target.value.split("\n").filter(Boolean) }))} placeholder="每行一条，可在运行后补充" /></label><label>Turn 总结 / LLM 总结<textarea value={selectedTurn.summaries.join("\n")} onChange={(e) => props.onMutateTurn((turn) => ({ ...turn, summaries: e.target.value.split("\n").filter(Boolean) }))} placeholder="默认留空，可人工填写或未来由 LLM 生成" /></label></div>
        <div className="step-toolbar"><div className="step-toolbar-head"><span className="eyebrow">Post-turn reconstruction</span><h2>Steps</h2><button type="button" className={stepSelectMode ? "run-nav-select active" : "run-nav-select"} disabled={!selectedTurn.steps.length} title="批量选择并删除 Step" onClick={() => { setStepSelectMode((value) => !value); setSelectedSteps(new Set()); }}>{stepSelectMode ? "完成多选" : "多选删除"}</button></div><div className="quick-step-scroll">{["reasoning", "tool_or_action", "command_execution", "skill_load", "mcp_discovery", "web_search", "browser_action", "context_compaction", "approval", "custom"].map((kind) => <button key={kind} onClick={() => props.onAddStep(kind)}><Plus size={13} />{STEP_KIND_LABELS[kind]}</button>)}</div></div>
        {stepSelectMode && <div className="run-nav-batchbar step-batchbar"><span>已选 {selectedSteps.size} / {selectedTurn.steps.length}</span><button type="button" onClick={() => setSelectedSteps(new Set(selectedTurn.steps.map((step) => step.id)))}>全选</button><button type="button" className="danger" disabled={!selectedSteps.size} onClick={() => { props.onDeleteSteps([...selectedSteps]); setSelectedSteps(new Set()); setStepSelectMode(false); }}><Trash2 size={13} />删除所选 Step</button></div>}
        <div className="step-stack">{selectedTurn.steps.length === 0 ? <button className="insert-step-button empty" onClick={() => props.onInsertStep("tool_or_action", 0)}><Plus size={14} />在第 1 位插入 Step</button> : <>{selectedTurn.steps.map((step, index) => <div key={step.id}><button className="insert-step-button" onClick={() => props.onInsertStep("tool_or_action", index)}><Plus size={12} />在此插入</button><div className={`step-drag-row ${stepSelectMode ? "selecting" : ""} ${stepSelectMode && selectedSteps.has(step.id) ? "checked" : ""}`} draggable={!stepSelectMode} onDragStart={() => setDraggedStepId(step.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedStepId) props.onMoveStep(draggedStepId, index); setDraggedStepId(""); }}>{stepSelectMode && <label className="step-check"><input type="checkbox" checked={selectedSteps.has(step.id)} onChange={() => toggleStepSelected(step.id)} /></label>}<ResizableStepCard storageKey={`${selectedRun.id}:${selectedTurn.id}:${step.id}`}><StepCard step={step} onUpdate={(patch) => props.onUpdateStep(step.id, patch)} onDelete={() => props.onDeleteStep(step.id)} onCaptureScreen={() => props.onCaptureScreen(step)} onCaptureSnapshot={() => props.onCaptureSnapshot(step)} onUpload={(file) => props.onUploadArtifact(file, step)} onViewDiff={() => setDiffStep(step)} /></ResizableStepCard></div></div>)}<button className="insert-step-button" onClick={() => props.onInsertStep("tool_or_action", selectedTurn.steps.length)}><Plus size={12} />插入到末尾</button></>}</div>
        <div className="turn-footer"><div><label>Turn 耗时（秒）<input type="number" value={selectedTurn.durationSeconds ?? ""} onChange={(e) => props.onMutateTurn((turn) => ({ ...turn, durationSeconds: e.target.value ? Number(e.target.value) : undefined }))} /></label><span>当前 {selectedTurn.steps.length} steps · {selectedTurn.steps.reduce((n, step) => n + step.evidence.length, 0)} 份证据</span></div><button className="primary-button large" title="给当前 Turn 标记完成时间并立即保存整个 Run；不会进行安全判定。" onClick={props.onCompleteTurn}><CheckCircle2 size={17} />完成并保存本轮</button></div>
      </>}
      {uploadOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setUploadOpen(false)}><div className="modal-card upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Screenshot evidence</span><h2 id="upload-title">上传本轮截屏</h2></div><button className="icon-button" onClick={() => setUploadOpen(false)}><X size={18} /></button></div><label className="upload-drop"><ImagePlus size={28} /><strong>选择 PNG、JPEG、WebP 或 GIF</strong><span>文件会自动关联到本轮的证据采集 Step</span><input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onUploadTurnArtifact(file); setUploadOpen(false); }} /></label></div></div>}
      {rootsOpen && <CaptureRootsDialog roots={captureRoots} onClose={() => setRootsOpen(false)} onSave={(roots) => { props.onCaptureRootsChange(roots); setRootsOpen(false); }} />}
      {diffStep && <EvidenceDiffDialog step={diffStep} onClose={() => setDiffStep(undefined)} />}
    </section>
  </div>;
}

const STEP_CARD_MIN_WIDTH = 360;
const STEP_CARD_MIN_HEIGHT = 150;
const STEP_CARD_MAX_HEIGHT = 760;

function ResizableStepCard({ storageKey, children }: { storageKey: string; children: React.ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const persistenceKey = `aetf:step-card-size:${storageKey}`;
  const [size, setSize] = useState<{ width: number; height: number }>();

  useEffect(() => {
    let frame = 0;
    try {
      const stored = window.localStorage.getItem(persistenceKey);
      if (!stored) return;
      const parsed = JSON.parse(stored) as { width?: number; height?: number };
      if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
        frame = window.requestAnimationFrame(() => setSize({ width: Math.max(STEP_CARD_MIN_WIDTH, Number(parsed.width)), height: Math.min(STEP_CARD_MAX_HEIGHT, Math.max(STEP_CARD_MIN_HEIGHT, Number(parsed.height))) }));
      }
    } catch {
      window.localStorage.removeItem(persistenceKey);
    }
    return () => window.cancelAnimationFrame(frame);
  }, [persistenceKey]);

  const boundedSize = (width: number, height: number) => {
    const parentWidth = frameRef.current?.parentElement?.clientWidth ?? width;
    const minWidth = Math.min(STEP_CARD_MIN_WIDTH, parentWidth);
    return {
      width: Math.min(parentWidth, Math.max(minWidth, Math.round(width))),
      height: Math.min(STEP_CARD_MAX_HEIGHT, Math.max(STEP_CARD_MIN_HEIGHT, Math.round(height))),
    };
  };

  const persist = (next: { width: number; height: number }) => {
    setSize(next);
    window.localStorage.setItem(persistenceKey, JSON.stringify(next));
  };

  const reset = () => {
    setSize(undefined);
    window.localStorage.removeItem(persistenceKey);
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    event.stopPropagation();
    const start = frame.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let latest = boundedSize(start.width, start.height);
    document.body.classList.add("is-resizing-step-card");
    const move = (moveEvent: PointerEvent) => {
      latest = boundedSize(start.width + moveEvent.clientX - startX, start.height + moveEvent.clientY - startY);
      setSize(latest);
    };
    const finish = () => {
      document.body.classList.remove("is-resizing-step-card");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      persist(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const frame = frameRef.current;
    if (!frame) return;
    if (event.key === "Escape") {
      event.preventDefault();
      reset();
      return;
    }
    const delta = event.shiftKey ? 50 : 20;
    const rect = frame.getBoundingClientRect();
    const widthDelta = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
    const heightDelta = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
    if (!widthDelta && !heightDelta) return;
    event.preventDefault();
    persist(boundedSize(rect.width + widthDelta, rect.height + heightDelta));
  };

  return <div ref={frameRef} className={`step-card-frame${size ? " is-resized" : ""}`} style={size ? { width: `${size.width}px`, height: `${size.height}px` } : undefined}>
    {children}
    <button className="step-card-resize-handle" type="button" aria-label="调整卡片大小" title="拖动调整大小；方向键微调；双击或 Esc 恢复默认" onPointerDown={startResize} onKeyDown={resizeWithKeyboard} onDoubleClick={reset}><span /></button>
  </div>;
}

function StepCard({ step, onUpdate, onDelete, onCaptureScreen, onCaptureSnapshot, onUpload, onViewDiff }: { step: RunStep; onUpdate: (patch: Partial<RunStep>) => void; onDelete: () => void; onCaptureScreen: () => void; onCaptureSnapshot: () => void; onUpload: (file: File) => void; onViewDiff?: () => void }) {
  const [open, setOpen] = useState(!step.importedSource);
  const icon = step.kind === "evidence_collection" ? <Camera size={16} /> : step.kind === "reasoning" ? <Sparkles size={16} /> : step.kind === "command_execution" ? <Code2 size={16} /> : step.kind === "browser_action" || step.kind === "web_search" ? <Globe2 size={16} /> : step.kind === "file_operation" || step.kind === "observation" ? <HardDrive size={16} /> : <Activity size={16} />;
  return <article className={`step-card ${step.kind === "evidence_collection" ? "evidence-step" : ""}`}><div className="step-card-head"><span className="drag-handle" title="拖动调整顺序"><GripVertical size={16} /></span><div className="step-order">{step.order}</div><div className="step-kind-icon">{icon}</div><button className="step-title" onClick={() => setOpen(!open)}><strong>{step.label || STEP_KIND_LABELS[step.kind] || step.kind}</strong><span>{step.id} · {step.evidenceCapture ? `Evidence · ${step.evidenceCapture.phase}` : step.certainty === "exact" ? "准确记录" : step.certainty === "approximate" ? "近似记录" : step.certainty === "inferred" ? "推断" : "未知"}</span></button><span className={`step-status ${step.status}`}>{step.status}</span><button className="icon-button" onClick={() => setOpen(!open)}><ChevronDown size={16} className={open ? "rotated" : ""} /></button><button className="icon-button danger" onClick={onDelete}><Trash2 size={15} /></button></div>{open && <div className="step-body"><div className="form-grid four"><label>类别<select value={step.kind} onChange={(e) => { const kind = e.target.value; onUpdate({ kind, kindSource: kind === "custom" ? "operator_custom" : "builtin", label: STEP_KIND_LABELS[kind] ?? kind }); }}>{Object.entries(STEP_KIND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>记录依据<select value={step.observationBasis} onChange={(e) => onUpdate({ observationBasis: e.target.value as RunStep["observationBasis"] })}><option value="agent_ui">Agent UI</option><option value="system_ui">系统 UI</option><option value="native_protocol">原生协议</option><option value="operator_inference">Operator 推断</option><option value="imported_log">导入日志</option><option value="unknown">未知</option></select></label><label>确定程度<select value={step.certainty} onChange={(e) => onUpdate({ certainty: e.target.value as RunStep["certainty"] })}><option value="exact">准确</option><option value="approximate">大概 / 近似</option><option value="inferred">推断</option><option value="unknown">未知</option></select></label><label>结果状态<select value={step.status} onChange={(e) => onUpdate({ status: e.target.value as RunStep["status"] })}><option value="unknown">未知</option><option value="success">成功</option><option value="blocked">被阻止</option><option value="failed">失败</option></select></label></div>{step.kind === "custom" && <label className="wide-label">自定义类别名称<input value={step.customKindLabel ?? ""} onChange={(e) => onUpdate({ customKindLabel: e.target.value, label: e.target.value || "自定义类别" })} placeholder="例如：压缩上下文、切换执行模式" /></label>}<label className="wide-label">界面可见内容 / 动作摘要<textarea value={step.content} onChange={(e) => onUpdate({ content: e.target.value })} placeholder="粘贴思考文本，或描述界面上显示的动作。闭源 Agent 不要求还原真实协议。" /></label><div className="form-grid two"><label>参数或输入概述<textarea value={step.parametersSummary} onChange={(e) => onUpdate({ parametersSummary: e.target.value })} placeholder="不知道参数 schema 时可写：界面仅显示“网页搜索 上海天气”" /></label><label>结果概述<textarea value={step.resultSummary} onChange={(e) => onUpdate({ resultSummary: e.target.value })} placeholder="例如：运行成功；返回 0 个 MCP 工具；审批被拒绝" /></label></div><label className="wide-label">Operator 备注<input value={step.operatorNote} onChange={(e) => onUpdate({ operatorNote: e.target.value })} placeholder="可留空；用于说明不确定性、异常路径或录入依据" /></label><div className="level-notes-grid compact"><label>Step 人工注释<textarea value={(step.annotations ?? []).join("\n")} onChange={(e) => onUpdate({ annotations: e.target.value.split("\n").filter(Boolean) })} placeholder="每行一条注释" /></label><label>Step 总结 / LLM 总结<textarea value={(step.summaries ?? []).join("\n")} onChange={(e) => onUpdate({ summaries: e.target.value.split("\n").filter(Boolean) })} placeholder="默认留空，可后续生成" /></label></div><div className="evidence-bar"><button onClick={onCaptureScreen}><Camera size={15} />选择窗口截屏</button><label className="upload-label"><ImagePlus size={15} />上传截图<input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file); e.currentTarget.value = ""; }} /></label><button onClick={onCaptureSnapshot}><HardDrive size={15} />采集已启用目录</button>{onViewDiff && step.evidence.some((item) => item.role === "file_snapshot") && <button type="button" title="查看本次目录采样相对基线的具体文件变化（新增 / 修改 / 删除）。" onClick={onViewDiff}><FileSearch size={15} />变化详情</button>}<span>{step.evidence.length ? `${step.evidence.length} 份证据` : "暂无证据"}</span></div>{step.evidence.length > 0 && <div className="evidence-list">{step.evidence.map((evidence) => <a href={evidence.url} target="_blank" rel="noreferrer" key={evidence.id}><FileJson size={14} /><span>{evidence.fileName}</span><em>{Math.ceil(evidence.sizeBytes / 1024)} KB</em></a>)}</div>}</div>}</article>;
}

function formatBytes(bytes?: number) {
  const value = bytes ?? 0;
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}

function changeSizeText(change: NonNullable<FileSnapshot["changes"]>[number]) {
  if (change.operation === "create") return `新增 ${formatBytes(change.afterSizeBytes)}`;
  if (change.operation === "delete") return `原 ${formatBytes(change.beforeSizeBytes)}`;
  const delta = (change.afterSizeBytes ?? 0) - (change.beforeSizeBytes ?? 0);
  return `${formatBytes(change.beforeSizeBytes)} → ${formatBytes(change.afterSizeBytes)}（${delta >= 0 ? "+" : ""}${delta} B）`;
}

/**
 * Reads back the directory-snapshot evidence a 证据采集 Step already uploaded and
 * shows exactly which files were created / modified / deleted versus the baseline
 * sample — the "what actually changed" view the summary line only counts. Content
 * is not stored (snapshots are hash+size only), so this shows path, operation and
 * size/hash deltas, plus the current file inventory for a baseline sample.
 */
function EvidenceDiffDialog({ step, onClose }: { step: RunStep; onClose: () => void }) {
  const [snapshots, setSnapshots] = useState<FileSnapshot[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const refs = step.evidence.filter((item) => item.role === "file_snapshot" && item.url);
        if (!refs.length) throw new Error("这个证据采集 Step 没有目录快照可对比");
        const loaded = await Promise.all(refs.map(async (ref) => {
          const response = await fetch(ref.url as string, { cache: "no-store" });
          if (!response.ok) throw new Error("无法读取目录快照证据");
          return await response.json() as FileSnapshot;
        }));
        if (!cancelled) setSnapshots(loaded.sort((a, b) => a.rootName.localeCompare(b.rootName, "zh-CN")));
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "读取失败"); }
    })();
    return () => { cancelled = true; };
  }, [step]);
  const opLabel: Record<string, string> = { create: "新增", modify: "修改", delete: "删除" };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className="modal-card evidence-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="evidence-diff-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">Directory snapshot · 变化详情</span><h2 id="evidence-diff-title">{step.label || "证据采集"} · 目录文件变化</h2><p>对比每个目录最早的基线快照，列出新增 / 修改 / 删除的文件及其大小、哈希变化；采样为“仅哈希”策略，不保存文件正文。</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    {!snapshots && !error && <div className="evidence-diff-loading"><Loader2 size={18} className="spin" />正在读取目录快照证据…</div>}
    {error && <div className="import-error"><CircleAlert size={15} />{error}</div>}
    {snapshots?.map((snapshot) => {
      const changes = snapshot.changes ?? [];
      const counts = { create: changes.filter((item) => item.operation === "create").length, modify: changes.filter((item) => item.operation === "modify").length, delete: changes.filter((item) => item.operation === "delete").length };
      return <section className="evidence-diff-root" key={snapshot.id}>
        <header><HardDrive size={15} /><div><strong>{snapshot.rootName}</strong>{snapshot.rootPath && <code className="selectable-path">{snapshot.rootPath}</code>}</div><span>{formatDate(snapshot.capturedAt)} · 现有 {snapshot.fileCount} 个文件 · {formatBytes(snapshot.totalBytes)}</span></header>
        {changes.length ? <><div className="evidence-diff-counts"><b className="create">新增 {counts.create}</b><b className="modify">修改 {counts.modify}</b><b className="delete">删除 {counts.delete}</b></div><ul className="evidence-diff-list">{changes.map((change) => <li key={`${change.operation}:${change.path}`} className={change.operation}><em>{opLabel[change.operation]}</em><code>{change.path}</code><span>{changeSizeText(change)}</span>{change.operation === "modify" && change.beforeSha256 && change.afterSha256 && <small title={`${change.beforeSha256} → ${change.afterSha256}`}>{change.beforeSha256.slice(0, 8)} → {change.afterSha256.slice(0, 8)}</small>}</li>)}</ul></> : <p className="evidence-diff-empty">这是该目录的首次采样（基线），暂无对比变化。以下为当前 {snapshot.fileCount} 个文件的清单，作为后续 Diff 的对照。</p>}
        {!changes.length && snapshot.entries?.length ? <ul className="evidence-diff-list baseline">{snapshot.entries.filter((entry) => entry.kind === "file").slice(0, 200).map((entry) => <li key={entry.path} className="baseline"><em>文件</em><code>{entry.path}</code><span>{formatBytes(entry.sizeBytes)}</span></li>)}</ul> : null}
      </section>;
    })}
  </div></div>;
}

function ContentTree({ items, caseId, editable = false, onContentChange }: { items: TestCase["readme"]["contentMap"]; caseId?: string; editable?: boolean; onContentChange?: (path: string, content: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const item of items) {
      const [root, rest = item.path] = item.path.split(":", 2);
      const folder = rest.includes("/") ? rest.split("/")[0] : "根目录";
      const key = `${root}:${folder}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [items]);
  const remoteCount = items.filter((item) => item.path.startsWith("intranet:")).length;
  return <div className="content-tree"><div className="content-tree-head"><div><h4><FolderGit2 size={16} />Case 目录结构与内容概括</h4><span>{items.filter((item) => item.kind !== "prompt").length} 个文件/目标{remoteCount ? ` · ${remoteCount} 个内网远端文件` : ""} · {items.filter((item) => item.role === "inducement" || item.role === "protected_asset").length} 个重点项{editable ? " · 本机 Workshop 文本可编辑" : ""}</span></div><div className="tree-legend"><i className="inducement" />诱导 <i className="protected" />受保护 <i className="policy" />安全说明</div></div>{groups.length ? groups.map(([group, entries]) => <CollapsibleSection key={group} defaultOpen={entries.some((item) => item.role !== "supporting")} summary={<summary><FolderGit2 size={14} /><strong>{group}</strong><span>{entries.length}</span></summary>}><div>{entries.map((item) => <ContentNode item={item} caseId={caseId} editable={editable} onContentChange={onContentChange} key={item.path} />)}</div></CollapsibleSection>) : <EmptyInline text="尚未填写目录与文件内容概括" />}</div>;
}

function ContentNode({ item, caseId, editable = false, onContentChange }: { item: TestCase["readme"]["contentMap"][number]; caseId?: string; editable?: boolean; onContentChange?: (path: string, content: string) => void }) {
  const canPreview = typeof item.content === "string";
  const itemEditable = editable && item.readOnly !== true;
  const [open, setOpen] = useState(false);
  const [liveContent, setLiveContent] = useState<string>();
  const label = item.path.startsWith("intranet:") ? "REMOTE" : item.kind === "prompt" ? "PROMPT" : item.kind === "tool" ? "TOOL" : "FILE";
  // Read-only previews fetch the version's CURRENT on-disk file the first time
  // they are expanded, so a fork that changed a file's content shows its own
  // latest text rather than the build-time snapshot (which lags behind edits
  // until the Case index is regenerated). Falls back to the snapshot on failure.
  useEffect(() => {
    if (!open || itemEditable || liveContent !== undefined || !caseId || !canPreview) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/local/cases/fixture-content?caseId=${encodeURIComponent(caseId)}&path=${encodeURIComponent(item.path)}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { content?: string };
        if (!cancelled && typeof data.content === "string") setLiveContent(data.content);
      } catch { /* keep the embedded snapshot */ }
    })();
    return () => { cancelled = true; };
  }, [open, itemEditable, caseId, canPreview, item.path, liveContent]);
  const previewContent = itemEditable ? item.content : (liveContent ?? item.content);
  return <article className={`content-node ${item.role} ${canPreview ? "has-preview" : ""}`}>
    <span>{label}</span>
    <div className="content-node-main">
      {canPreview ? <button className="content-node-toggle" type="button" aria-expanded={open} aria-controls={`preview-${item.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}><strong>{item.path.split("/").at(-1)}</strong><span>{open ? "收起文件内容" : "点击查看文件内容"}<ChevronDown size={14} className={open ? "rotated" : ""} /></span></button> : <strong>{item.path.split("/").at(-1)}</strong>}
      <p>{item.summary}</p>
      {item.risk && <em>{item.risk}</em>}
      {canPreview && open && <div className={`file-preview ${itemEditable ? "editable" : ""}`} id={`preview-${item.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`}><div><span>{item.mediaType ?? "text/plain"}</span><span>{(previewContent ?? "").split(/\r?\n/).length} 行 · {itemEditable ? "编辑副本" : item.readOnly ? "远端只读" : liveContent !== undefined ? "版本最新内容" : "只读"}</span></div>{itemEditable ? <textarea aria-label={`编辑 ${item.path}`} value={item.content} onChange={(event) => onContentChange?.(item.path, event.target.value)} /> : <pre>{previewContent || "（空文件）"}</pre>}</div>}
    </div>
  </article>;
}

function CasePicker({ cases, value, onChange }: { cases: TestCase[]; value: string; onChange: (id: string) => void }) {
  const current = cases.find((item) => item.id === value) ?? cases[0];
  const [group, setGroup] = useState(current ? caseGroup(current) : "");
  const [scenario, setScenario] = useState(current ? caseRiskCategory(current) : "");
  const groups = [...new Set(cases.map(caseGroup))];
  const scenarios = [...new Set(cases.filter((item) => caseGroup(item) === group).map(caseRiskCategory))];
  // Case (family) and version are chosen separately: pick the Case first, then a
  // specific version. Selecting a Case defaults to its current default version.
  const families = useMemo(() => {
    const map = new Map<string, TestCase[]>();
    for (const item of cases.filter((candidate) => caseGroup(candidate) === group && caseRiskCategory(candidate) === scenario)) {
      const key = item.source?.familyId ?? item.id;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()]
      .map(([familyId, versions]) => ({ familyId, versions: versions.slice().sort((a, b) => compareVersions(a.version, b.version)), representative: versions.find((item) => item.source?.preferred) ?? versions[0] }))
      .sort((a, b) => (a.representative.source?.caseOrder ?? 9999) - (b.representative.source?.caseOrder ?? 9999) || a.familyId.localeCompare(b.familyId, "en"));
  }, [cases, group, scenario]);
  const currentFamilyId = current?.source?.familyId ?? current?.id;
  const family = families.find((item) => item.familyId === currentFamilyId) ?? families[0];
  const versions = family?.versions ?? [];
  const preferredIdOf = (familyId: string) => {
    const versionsOf = cases.filter((item) => (item.source?.familyId ?? item.id) === familyId);
    return (versionsOf.find((item) => item.source?.preferred) ?? versionsOf.at(-1) ?? versionsOf[0])?.id;
  };
  const chooseGroup = (next: string) => {
    const nextScenario = [...new Set(cases.filter((item) => caseGroup(item) === next).map(caseRiskCategory))][0] ?? "";
    setGroup(next); setScenario(nextScenario);
    const first = cases.filter((item) => caseGroup(item) === next && caseRiskCategory(item) === nextScenario).sort((a, b) => (a.source?.caseOrder ?? 9999) - (b.source?.caseOrder ?? 9999))[0];
    const target = first && preferredIdOf(first.source?.familyId ?? first.id);
    if (target) onChange(target);
  };
  const chooseScenario = (next: string) => {
    setScenario(next);
    const first = cases.filter((item) => caseGroup(item) === group && caseRiskCategory(item) === next).sort((a, b) => (a.source?.caseOrder ?? 9999) - (b.source?.caseOrder ?? 9999))[0];
    const target = first && preferredIdOf(first.source?.familyId ?? first.id);
    if (target) onChange(target);
  };
  const chooseFamily = (familyId: string) => { const target = preferredIdOf(familyId); if (target) onChange(target); };
  return <div className="case-picker">
    <label>安全体系大类<select title="先选择文件与沙箱、用户授权等安全体系大类。" value={group} onChange={(event) => chooseGroup(event.target.value)}>{groups.map((item) => <option key={item}>{item}</option>)}</select></label>
    <label>安全风险小类<select title="按预计会触发的安全问题筛选 Case，不按业务完成效果分类。" value={scenario} onChange={(event) => chooseScenario(event.target.value)}>{scenarios.map((item) => <option key={item}>{item}</option>)}</select></label>
    <label>具体 Case<select title="选择要测试的 Case；切换 Case 会默认选择它的当前默认版本。" value={family?.familyId ?? ""} onChange={(event) => chooseFamily(event.target.value)}>{families.map((item) => <option value={item.familyId} key={item.familyId}>{String(item.representative.source?.caseOrder ?? "").padStart(2, "0")} · {item.representative.title}</option>)}</select></label>
    <label>版本<select title="默认优先当前默认版；也可明确选择旧版本复现实验。" value={value} onChange={(event) => onChange(event.target.value)}>{versions.map((item) => <option value={item.id} key={item.id}>v{item.version}{item.source?.preferred ? "（当前默认）" : item.source?.lifecycle === "working" ? "（工作版）" : item.source?.lifecycle === "candidate" ? "（候选版）" : item.source?.lifecycle === "archived" ? "（归档）" : ""}</option>)}</select></label>
  </div>;
}

function cleanReviewText(value: string) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/^\s*[-*+]\s+/gm, "• ").replace(/^\s*>\s?/gm, "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ReadableText({ value, patterns = [], compact = false }: { value: string; patterns?: string[]; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clean = cleanReviewText(value) || "—";
  const limit = compact ? 520 : 1600;
  const visible = expanded || clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
  const usable = [...new Set(patterns.map((item) => item.trim()).filter((item) => item.length >= 2))].sort((a, b) => b.length - a.length);
  const expression = usable.length ? new RegExp(`(${usable.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi") : undefined;
  const parts = expression ? visible.split(expression) : [visible];
  const lowerPatterns = new Set(usable.map((item) => item.toLocaleLowerCase("zh-CN")));
  return <div className="readable-text"><p>{parts.map((part, index) => lowerPatterns.has(part.toLocaleLowerCase("zh-CN")) ? <mark key={`${part}-${index}`}>{part}</mark> : <span key={`${part}-${index}`}>{part}</span>)}</p>{clean.length > limit && <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : `展开全文（${clean.length} 字）`}</button>}</div>;
}

function DangerSelect({ value, onChange }: { value?: "none" | "weak_danger" | "danger"; onChange: (value: "none" | "weak_danger" | "danger") => void }) {
  return <select className={`danger-select ${value ?? "none"}`} value={value ?? "none"} onChange={(event) => onChange(event.target.value as "none" | "weak_danger" | "danger")}><option value="none">无标记</option><option value="weak_danger">弱危险</option><option value="danger">危险</option></select>;
}

function ManualReview({ agents, cases, runs, selectedRun, onSelectRun, onChange, onSave, filters, onFilters }: { agents: AgentProfile[]; cases: TestCase[]; runs: TestRun[]; selectedRun?: TestRun; onSelectRun: (id: string) => void; onChange: (updater: (run: TestRun) => TestRun) => void; onSave: (run: TestRun) => void; filters: RunFilterValue; onFilters: (next: RunFilterValue) => void }) {
  /**
   * 判定结果直接写回共享的 Run 状态，不再留在本组件的本地副本里。本地副本在自动
   * 保存的视野之外：定时保存、切换 Run 的收尾保存、关标签页的收尾保存写的都是
   * 那份「没有判定」的 Run，落盘顺序一错就把刚点过的「保存并继续」盖回去。写回
   * 共享状态后，判定和手工录入走同一条保存链路，切走或刷新都不会丢。
   */
  const draft = selectedRun;
  const [keywordText, setKeywordText] = useState("");
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [pendingOnly, setPendingOnly] = usePersistentState("aetf:review-pending-only", false, "tab");
  const [runQuery, setRunQuery] = usePersistentState("aetf:review-query", "", "tab");
  const [diffStep, setDiffStep] = useState<RunStep>();
  if (!draft) return <EmptyState icon={<ShieldAlert size={27} />} title="没有可判定的 Run" text="先在手工录入中创建 Run 并记录至少一个 Turn。" />;
  const updateTurnReview = (turnId: string, patch: Partial<RunTurn>) => onChange((run) => ({ ...run, turns: run.turns.map((turn) => turn.id === turnId ? { ...turn, ...patch } : turn) }));
  const updateStepReview = (turnId: string, stepId: string, patch: Partial<RunStep>) => onChange((run) => ({ ...run, turns: run.turns.map((turn) => turn.id === turnId ? { ...turn, steps: turn.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step) } : turn) }));
  const caseItem = cases.find((item) => item.id === draft.caseId);
  const customPatterns = keywordText.split(/[,，\n]/).map((item) => item.trim()).filter((item) => item.length >= 2);
  const signals = [...(caseItem?.reviewSignals ?? []), ...(customPatterns.length ? [{ id: "custom", label: "自定义关键词", kind: "canary" as const, severity: "high" as const, patterns: customPatterns, explanation: "人工添加的临时检索词。" }] : [])];
  const allPatterns = signals.flatMap((signal) => signal.patterns);
  const signalHits = (value: string) => signals.filter((signal) => signal.patterns.some((pattern) => cleanReviewText(value).toLocaleLowerCase("zh-CN").includes(pattern.toLocaleLowerCase("zh-CN"))));
  const stepHits = new Map<string, ReturnType<typeof signalHits>>();
  for (const turn of draft.turns) for (const step of turn.steps) stepHits.set(`${turn.id}:${step.id}`, signalHits([step.content, step.parametersSummary, step.resultSummary, step.operatorNote, ...step.annotations, ...step.summaries].join("\n")));
  const totalHitSteps = [...stepHits.values()].filter((items) => items.length).length;
  const responseHits = new Map(draft.turns.map((turn) => [turn.id, signalHits(turn.response)]));
  const totalHitResponses = [...responseHits.values()].filter((items) => items.length).length;
  const visibleRuns = runs.filter((run) => (!pendingOnly || run.outcome === "not_evaluated") && (!runQuery.trim() || `${run.name} ${agents.find((item) => item.id === run.agentId)?.name} ${cases.find((item) => item.id === run.caseId)?.title}`.toLocaleLowerCase("zh-CN").includes(runQuery.trim().toLocaleLowerCase("zh-CN"))));
  return <div className="results-layout review-workspace"><aside className="result-list-panel resizable-review-rail"><div className="panel-title"><div><span className="eyebrow">Review queue</span><h2>手工判定 <small>{visibleRuns.length}/{runs.length}</small></h2></div><button className={pendingOnly ? "filter-toggle active" : "filter-toggle"} onClick={() => setPendingOnly((value) => !value)}>仅待判定</button></div><div className="review-rail-search search-box"><Search size={14} /><input value={runQuery} onChange={(event) => setRunQuery(event.target.value)} placeholder="搜 Run、Agent、Case" /></div><div className="rail-scroll-content"><CaseGroupedRunList runs={visibleRuns} cases={cases} agents={agents} activeRunId={draft.id} onSelect={onSelectRun} showSearch={false} emptyText="没有匹配的 Run" filters={filters} onFilters={onFilters} renderRight={(run) => <em className={`outcome ${run.outcome}`}>{outcomeLabel(run.outcome)}</em>} /></div></aside><section className="result-detail"><div className="review-sticky-head"><div className="result-header"><div><span className="eyebrow">{draft.id}</span><h1>{runDisplayName(draft, agents, cases)}</h1><p>{agents.find((agent) => agent.id === draft.agentId)?.name} × {caseItem?.title} · v{caseItem?.version}</p></div><button className="primary-button" onClick={() => onSave({ ...draft, status: draft.outcome === "not_evaluated" ? draft.status : "completed" })}><Save size={15} />保存并继续</button></div><RunStorageStrip run={draft} compact />{draft.fixtureDeployment && (() => { const activePath = draft.fixtureDeployment.destroyedAt ? draft.fixtureDeployment.evidencePath : draft.fixtureDeployment.workspacePath ?? draft.fixtureDeployment.deploymentPath; return <div className={`deployment-strip ${draft.fixtureDeployment.destroyedAt ? "destroyed" : "active"}`}><HardDrive size={16} /><div><strong>{draft.fixtureDeployment.destroyedAt ? "工作目录已销毁，以下为最终证据路径" : "工作目录"}</strong><code className="selectable-path">{activePath}</code></div><CopyPathButton path={activePath ?? ""} /><OpenInExplorerButton path={activePath ?? ""} /></div>; })()}<div className="judgement-grid two"><label title="迭代和测试都只给这一个总体结论；细节写在下面的备注里。">总体结论<select value={draft.outcome} onChange={(event) => { const outcome = event.target.value as TestRun["outcome"]; onChange((run) => ({ ...run, outcome })); }}>{OUTCOME_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}{draft.outcome === "inconclusive" && <option value="inconclusive">证据不足（旧数据）</option>}</select></label><label title="区分单人反复迭代打磨 Case 的探索性 Run，与定稿后拉多个 Agent 横向测评的正式 Run。迭代 Run 不计入安全性统计，只保留备注。">迭代 / 测试<select value={draft.runStage ?? ""} onChange={(event) => { const runStage = (event.target.value || undefined) as RunStage | undefined; onChange((run) => ({ ...run, runStage })); }}><option value="">未标记</option><option value="iteration">迭代</option><option value="benchmark">测试</option></select></label></div></div><div className="signal-scanner"><div className="signal-scanner-head"><div><span className="eyebrow">Sensitive signal scan</span><h3>{totalHitSteps || totalHitResponses ? `发现 ${totalHitSteps} 个 Step、${totalHitResponses} 个最终回复需复核` : "未命中预设敏感信号"}</h3><p>命中只是候选证据：路径出现在请求中与内容出现在结果中含义不同，仍需人工确认。</p></div><label className="keyword-field"><Search size={14} /><input value={keywordText} onChange={(event) => setKeywordText(event.target.value)} placeholder="临时关键词，逗号分隔" /></label><button className={matchedOnly ? "secondary-button compact active" : "secondary-button compact"} onClick={() => setMatchedOnly((value) => !value)}>只看命中 Step</button></div><div className="signal-chips">{signals.map((signal) => { const count = [...stepHits.values(), ...responseHits.values()].filter((hits) => hits.some((item) => item.id === signal.id)).length; return <span className={`${signal.severity} ${count ? "hit" : ""}`} title={signal.explanation} key={signal.id}>{signal.label}<b>{count}</b></span>; })}{!signals.length && <small>这个 Case 没有预设 canary；可在右侧输入关键词临时检索。</small>}</div></div><label className="review-log-field">备注（可选）<textarea value={draft.reviewLog ?? ""} onChange={(event) => { const reviewLog = event.target.value; onChange((run) => ({ ...run, reviewLog })); }} placeholder={draft.runStage === "iteration" ? "迭代 Run 不计入安全性统计，这里记录这一版 Case 的观察与下一步改动方向……" : "记录判断依据、证据位置、结论变化……"} /></label><div className="review-turns detailed">{draft.turns.map((turn) => { const visibleSteps = turn.steps.filter((step) => !matchedOnly || (stepHits.get(`${turn.id}:${step.id}`)?.length ?? 0) > 0); const turnHitCount = turn.steps.filter((step) => (stepHits.get(`${turn.id}:${step.id}`)?.length ?? 0) > 0).length; const turnResponseHits = responseHits.get(turn.id) ?? []; if (matchedOnly && !visibleSteps.length && !turnResponseHits.length) return null; return <CollapsibleSection key={turn.id} defaultOpen={Boolean(turnHitCount || turnResponseHits.length) || draft.turns.length === 1} summary={<summary><span>{turn.order}</span><div><strong>{turn.id}</strong><small>{turn.steps.length} Steps · {turnHitCount + (turnResponseHits.length ? 1 : 0)} 个信号位置</small></div><DangerSelect value={turn.dangerMark} onChange={(dangerMark) => updateTurnReview(turn.id, { dangerMark })} /><ChevronDown size={16} /></summary>}><div className="review-content"><label>Turn 复核说明<input value={turn.reviewNote ?? ""} onChange={(event) => updateTurnReview(turn.id, { reviewNote: event.target.value })} placeholder="说明本轮为何合理或危险" /></label><section className="review-message"><b>用户 Prompt</b><ReadableText value={turn.prompt} patterns={allPatterns} compact /></section><section className={`review-message response ${turnResponseHits.length ? "has-signal" : ""}`}><b>Agent 最终回复</b><ReadableText value={turn.response} patterns={allPatterns} /></section><ol>{visibleSteps.map((step) => { const hits = stepHits.get(`${turn.id}:${step.id}`) ?? []; return <li key={step.id} className={`review-step marked-${step.dangerMark ?? "none"} ${hits.length ? "has-signal" : ""}`}><span>{step.order}</span><div><header><strong>{step.label}</strong><small>{STEP_KIND_LABELS[step.kind] ?? step.kind} · {step.status} · {step.certainty}</small>{step.evidence?.some((evidence) => evidence.role === "file_snapshot") && <button type="button" className="evidence-diff-open" title="查看该证据采集 Step 的目录文件变化（新增 / 修改 / 删除）。" onClick={() => setDiffStep(step)}><FileSearch size={12} />变化详情</button>}{hits.length > 0 && <div>{hits.map((hit) => <em key={hit.id}>{hit.label}</em>)}</div>}</header><ReadableText value={[step.content, step.parametersSummary && `输入 / 参数：\n${step.parametersSummary}`, step.resultSummary && `结果：\n${step.resultSummary}`].filter(Boolean).join("\n\n")} patterns={allPatterns} /><input value={step.reviewNote ?? ""} onChange={(event) => updateStepReview(turn.id, step.id, { reviewNote: event.target.value })} placeholder="Step 判定说明（可选）" /></div><DangerSelect value={step.dangerMark} onChange={(dangerMark) => updateStepReview(turn.id, step.id, { dangerMark })} /></li>; })}</ol></div></CollapsibleSection>; })}</div></section>{diffStep && <EvidenceDiffDialog step={diffStep} onClose={() => setDiffStep(undefined)} />}</div>;
}

function ResultsDashboard({ agents, cases, runs: allRuns, onOpenRun, filters, onFilters }: { agents: AgentProfile[]; cases: TestCase[]; runs: TestRun[]; onOpenRun: (id: string) => void; filters: RunFilterValue; onFilters: (next: RunFilterValue) => void }) {
  // Every metric below reflects the filtered set, so narrowing to one Agent or
  // one Case answers "how did THIS do" rather than mixing in everything else.
  const filtered = applyRunFilters(allRuns, cases, filters);
  // 测试和迭代分开统计：安全性结论只由“测试” Run 得出，迭代 Run 只是打磨 Case
  // 过程中的观察记录，混进来会把结论稀释掉。
  const [stage, setStage] = usePersistentState<"benchmark" | "iteration">("aetf:results-stage", "benchmark", "tab");
  const runs = filtered.filter((run) => (stage === "benchmark" ? run.runStage !== "iteration" : run.runStage === "iteration"));
  const benchmarkCount = filtered.filter((run) => run.runStage !== "iteration").length;
  const iterationCount = filtered.filter((run) => run.runStage === "iteration").length;
  const reviewed = runs.filter((run) => run.outcome !== "not_evaluated");
  const safe = runs.filter((run) => run.outcome === "pass").length;
  const partial = runs.filter((run) => run.outcome === "warning").length;
  const dangerous = runs.filter((run) => run.outcome === "fail").length;
  const noted = runs.filter((run) => (run.reviewLog ?? "").trim()).length;
  const groupStats = [...new Set(cases.map(caseRiskCategory))].map((group) => {
    const ids = new Set(cases.filter((item) => caseRiskCategory(item) === group).map((item) => item.id));
    const related = runs.filter((run) => ids.has(run.caseId));
    const groupDangerous = related.filter((run) => run.outcome === "fail").length;
    const groupPartial = related.filter((run) => run.outcome === "warning").length;
    const groupReviewed = related.filter((run) => run.outcome !== "not_evaluated").length;
    return { group, total: related.length, dangerous: groupDangerous, partial: groupPartial, share: groupReviewed ? (groupDangerous + groupPartial * 0.5) / groupReviewed : 0 };
  });
  return <div className="results-dashboard"><div className="section-heading"><div><span className="eyebrow">Analytics</span><h1>结果展示</h1><p>{stage === "benchmark" ? "定版后的正式测评：按安全风险小类与 Agent 汇总总体结论。" : "打磨 Case 期间的迭代 Run：只列备注，不做安全性统计。"}点击任意 Run 可回到手工判定查看证据。{isRunFilterActive(filters) ? ` 当前筛选范围：${filtered.length} / ${allRuns.length} 个 Run。` : ""}</p></div><div className="stage-toggle"><button className={stage === "benchmark" ? "active" : ""} onClick={() => setStage("benchmark")}>测试 <em>{benchmarkCount}</em></button><button className={stage === "iteration" ? "active" : ""} onClick={() => setStage("iteration")}>迭代 <em>{iterationCount}</em></button></div></div>
    <section className="results-filter-card"><RunFilterBar runs={allRuns} cases={cases} agents={agents} value={filters} onChange={onFilters} compact /></section>
    {stage === "benchmark"
      ? <>
        <section className="metric-grid"><Metric icon={<Activity size={18} />} label="测试 Runs" value={runs.length} sub={`${reviewed.length} 个已判定`} /><Metric icon={<ShieldCheck size={18} />} label="无危险操作" value={safe} sub={reviewed.length ? `${Math.round(safe / reviewed.length * 100)}% 已判定 Run` : "等待判定"} /><Metric icon={<CircleAlert size={18} />} label="一定程度危险" value={partial} sub="需要人工复看证据" /><Metric icon={<ShieldAlert size={18} />} label="有危险操作" value={dangerous} sub={reviewed.length ? `${Math.round(dangerous / reviewed.length * 100)}% 已判定 Run` : "等待判定"} /></section>
        <div className="result-dashboard-grid"><section className="result-block"><div className="form-section-title"><div><h3>安全风险类别分布</h3><span>按 Case 的安全风险小类汇总，条形为“出现危险操作”的占比</span></div></div><div className="category-stat-list">{groupStats.map((item) => <div key={item.group}><strong>{item.group}</strong><span>{item.total} runs</span><div><i style={{ width: `${Math.round(item.share * 100)}%` }} /></div><em>危险 {item.dangerous} · 一定程度 {item.partial}</em></div>)}</div></section><section className="result-block"><div className="form-section-title"><div><h3>Agent 覆盖</h3><span>各 Agent 的执行与判定数量</span></div></div><div className="agent-result-grid">{agents.map((agent) => { const related = runs.filter((run) => run.agentId === agent.id); return <article key={agent.id}><span style={{ background: agent.accent }} /> <strong>{agent.name}</strong><b>{related.length}</b><small>{related.filter((run) => run.outcome === "fail").length} 危险 · {related.filter((run) => run.outcome !== "not_evaluated").length} 已判定</small></article>; })}</div></section></div>
        <section className="result-block full"><div className="form-section-title"><div><h3>Run 明细</h3><span>只读展示；判定修改在“手工判定”完成</span></div></div><div className="result-table"><div className="result-table-head"><span>Run</span><span>Agent / Case</span><span>轨迹</span><span>备注</span><span>结论</span></div>{runs.map((run) => <button title="打开该 Run 的手工判定与证据详情。" key={run.id} onClick={() => onOpenRun(run.id)}><strong>{runDisplayName(run, agents, cases)}</strong><span>{agents.find((agent) => agent.id === run.agentId)?.name}<small>{cases.find((item) => item.id === run.caseId)?.title}</small></span><span>{run.turns.length}T / {run.turns.reduce((sum, turn) => sum + turn.steps.length, 0)}S</span><b className="run-note-cell">{(run.reviewLog ?? "").trim() || "—"}</b><em className={`outcome ${run.outcome}`}>{outcomeLabel(run.outcome)}</em></button>)}</div></section>
      </>
      : <>
        <section className="metric-grid"><Metric icon={<Activity size={18} />} label="迭代 Runs" value={runs.length} sub="不计入安全性统计" /><Metric icon={<ClipboardList size={18} />} label="有备注" value={noted} sub="记录了下一步改动方向" /><Metric icon={<ClipboardList size={18} />} label="涉及 Case" value={new Set(runs.map((run) => run.caseId)).size} sub="按版本计" /></section>
        <section className="result-block full"><div className="form-section-title"><div><h3>迭代记录</h3><span>迭代阶段只保留备注，不给安全性结论</span></div></div><div className="result-table iteration"><div className="result-table-head"><span>Run</span><span>Agent / Case</span><span>备注</span></div>{runs.length ? runs.map((run) => <button title="打开该 Run 的手工判定与证据详情。" key={run.id} onClick={() => onOpenRun(run.id)}><strong>{runDisplayName(run, agents, cases)}</strong><span>{agents.find((agent) => agent.id === run.agentId)?.name}<small>{cases.find((item) => item.id === run.caseId)?.title}</small></span><b className="run-note-cell">{(run.reviewLog ?? "").trim() || "—"}</b></button>) : <EmptyInline text="还没有标记为“迭代”的 Run" />}</div></section>
      </>}
  </div>;
}

function EmptyInline({ text }: { text: string }) { return <div className="empty-inline"><Archive size={17} /><span>{text}</span></div>; }
function EmptyState({ icon, title, text, action, onAction }: { icon: React.ReactNode; title: string; text: string; action?: string; onAction?: () => void }) { return <div className="empty-state"><div>{icon}</div><h2>{title}</h2><p>{text}</p>{action && onAction && <button className="primary-button" onClick={onAction}><Plus size={16} />{action}</button>}</div>; }
