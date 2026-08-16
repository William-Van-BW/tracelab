/**
 * Builds the read-only data snapshot the showcase site serves.
 *
 * The showcase deliberately owns a *copy* of the data rather than reading the
 * live workbench sources at request time: the site must keep serving a stable,
 * public-safe view while the operator keeps editing Cases and recording Runs.
 *
 * Sources (read-only, never written to):
 *   - ../workbench/lib/generated-case-library.json → Cases (preferred version only)
 *   - <workbench runsRoot>/<runId>/           → Runs (latest per Case × Agent)
 *
 * Output: showcase/data/*  (snapshot.json + cases/ + runs/)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const showcaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// apps/showcase → apps → <repository root>
const repositoryRoot = resolve(showcaseRoot, "..", "..");
const libraryIndexPath = join(repositoryRoot, "apps", "workbench", "lib", "generated-case-library.json");
const outputRoot = join(showcaseRoot, "data");

const argv = new Set(process.argv.slice(2));
const REDACT = !argv.has("--no-redact");

/* ------------------------------------------------------------------ *
 * Run store location
 * ------------------------------------------------------------------ */

function expandEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

/**
 * Mirrors web/scripts/workbench-config.mjs: runsRoot is explicit or defaults to
 * <workingRoot>/runs. Missing config is not fatal — the site can still ship the
 * Case library alone, which is what a clone without the operator's data gets.
 */
function resolveRunsRoot() {
  if (process.env.SHOWCASE_RUNS_ROOT) return resolve(expandEnvironment(process.env.SHOWCASE_RUNS_ROOT));
  const configPath = join(repositoryRoot, "case-library", "aetf-workbench.json");
  if (!existsSync(configPath)) return "";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof config.runsRoot === "string" && config.runsRoot.trim()) return resolve(expandEnvironment(config.runsRoot.trim()));
    if (typeof config.workingRoot === "string" && config.workingRoot.trim()) return join(resolve(expandEnvironment(config.workingRoot.trim())), "runs");
  } catch (error) {
    console.warn(`! 无法解析 workbench 配置：${error.message}`);
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * Redaction — the site is public, the traces are not
 * ------------------------------------------------------------------ */

const HOME = homedir();
const REDACTED_HOME = "C:\\Users\\operator";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const USERNAME = HOME ? HOME.split(/[\\/]/).filter(Boolean).pop() ?? "" : "";
const REDACTED_USERNAME = "operator";

/**
 * Imported traces quote the home path in several spellings: a plain Windows
 * path, a JSON-escaped one (tool results are themselves embedded JSON, so the
 * separators arrive doubled), a POSIX-ish one, and a URL-encoded one. `ls -l`
 * output also prints the bare account name as the file owner. Longest patterns
 * run first so a doubled path is not half-rewritten by the single-slash rule.
 */
function homeVariants() {
  if (!HOME) return [];
  const separatorForms = ["\\\\", "\\", "//", "/"];
  const variants = separatorForms.map((separator) => {
    const from = HOME.replace(/[\\/]/g, separator);
    const to = REDACTED_HOME.replace(/\\/g, separator);
    return [new RegExp(escapeRegExp(from), "gi"), to];
  });
  variants.push([new RegExp(escapeRegExp(encodeURIComponent(HOME)), "gi"), encodeURIComponent(REDACTED_HOME)]);
  // Unanchored on purpose: the account name also turns up inside `ls -l` owner
  // columns and hex dumps of .lnk shortcuts, where a word boundary never matches.
  if (USERNAME) variants.push([new RegExp(escapeRegExp(USERNAME), "gi"), REDACTED_USERNAME]);
  // PowerShell elides the middle of long paths in its error records, so the
  // account name arrives cut short — "C:\Users\<first letters>...\周报.ps1". Every
  // exact-string rule above misses it. Match any prefix of the account name
  // that sits between "Users\" and the ellipsis.
  if (USERNAME.length >= 4) {
    const prefixes = [];
    for (let length = USERNAME.length - 1; length >= 4; length -= 1) prefixes.push(escapeRegExp(USERNAME.slice(0, length)));
    variants.push([
      new RegExp(`(Users[\\\\/]{1,2})(?:${prefixes.join("|")})(?=\\.{3}|…)`, "gi"),
      `$1${REDACTED_USERNAME}`,
    ]);
  }
  return variants;
}

/**
 * The mock intranet runs on whatever private address the evaluating machine
 * happens to own, and the Agent types that address into its own commands. The
 * portal being at *some* intranet address is the point; which one is nobody's
 * business, so traces published on the site say so in words.
 */
const PRIVATE_IPV4 = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;
const REDACTED_INTRANET_HOST = "intranet.local";

/**
 * Agents that search the web quote whatever they find, including third parties'
 * contact addresses. Those people did not volunteer for this corpus, and no
 * finding has ever turned on the address being real.
 */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const REDACTED_EMAIL = "<邮箱已脱敏>";

const redactions = [...homeVariants(), [PRIVATE_IPV4, REDACTED_INTRANET_HOST], [EMAIL, REDACTED_EMAIL]];

function redactText(value) {
  if (!REDACT) return value;
  let next = value;
  for (const [pattern, replacement] of redactions) next = next.replace(pattern, replacement);
  return next;
}

/** Deep-copies a JSON value, redacting every string it contains. */
function redact(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) next[key] = redact(item);
    return next;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

// Kept in sync with web/lib/defaults.ts DEFAULT_AGENTS. Duplicated on purpose:
// the snapshot must not import from the workbench at runtime.
const AGENTS = [
  { id: "agent_chatgpt", name: "ChatGPT", vendor: "OpenAI", region: "global", accent: "#10a37f" },
  { id: "agent_claude_desktop", name: "Claude Desktop", vendor: "Anthropic", region: "global", accent: "#d97757" },
  { id: "agent_workbuddy", name: "WorkBuddy", vendor: "Tencent", region: "china", accent: "#4f46a5" },
  { id: "agent_qoder", name: "Qoder", vendor: "Alibaba", region: "china", accent: "#e36b2c" },
  { id: "agent_trae", name: "Trae", vendor: "ByteDance", region: "china", accent: "#151515" },
  { id: "agent_dumate", name: "DuMate", vendor: "Baidu", region: "china", accent: "#3b82f6" },
];

const STEP_KIND_LABELS = {
  reasoning: "思考 / 状态",
  tool_or_action: "工具或动作",
  command_execution: "执行命令",
  skill_load: "加载 Skill",
  skill_call: "调用 Skill",
  mcp_discovery: "获取 MCP 工具",
  web_search: "网页搜索",
  browser_action: "浏览器操作",
  context_compaction: "压缩上下文",
  approval: "权限审批",
  file_operation: "文件操作",
  observation: "环境观察",
  evidence_collection: "证据采集",
  assistant_response: "Agent 回复",
  custom: "自定义类别",
};

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

if (!existsSync(libraryIndexPath)) {
  throw new Error(`找不到 Case 索引：${libraryIndexPath}\n请先在 web/ 下运行 node scripts/sync-case-library.mjs`);
}
const library = JSON.parse(readFileSync(libraryIndexPath, "utf8"));

/** URL-safe slug for a Case. Global IDs (OA-7) are stable and human readable. */
function caseSlug(item) {
  const globalId = String(item.globalId ?? "").trim();
  if (/^[A-Za-z]+-\d+$/.test(globalId)) return globalId.toUpperCase();
  return item.source.familyId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function riskMeta(item) {
  const system = (library.catalog ?? []).find((entry) => entry.slug === item.source.systemCategory);
  const risk = system?.risks?.find((entry) => entry.slug === item.source.riskCategorySlug);
  return { system, risk };
}

/** Numeric sort key so OA-10 lands after OA-9 rather than after OA-1. */
function caseOrderKey(item) {
  return [item.source.systemOrder ?? 999, item.source.riskOrder ?? 999, item.source.caseOrder ?? 999];
}

const preferredCases = library.cases
  .filter((item) => item.source?.preferred)
  .sort((a, b) => {
    const [as, ar, ac] = caseOrderKey(a);
    const [bs, br, bc] = caseOrderKey(b);
    return as - bs || ar - br || ac - bc || String(a.globalId).localeCompare(String(b.globalId));
  });

if (!preferredCases.length) throw new Error("Case 索引中没有任何 preferred 版本，无法生成展示数据。");

/** family@version identities the site accepts Runs for — latest version only. */
const acceptedCaseIds = new Map(preferredCases.map((item) => [item.id, caseSlug(item)]));

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

const runsRoot = resolveRunsRoot();
const rawRuns = [];
if (runsRoot && existsSync(runsRoot)) {
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const runFile = join(runsRoot, entry.name, "run.json");
    if (!existsSync(runFile)) continue;
    try {
      const run = JSON.parse(readFileSync(runFile, "utf8"));
      if (run && typeof run.id === "string") rawRuns.push({ run, directory: join(runsRoot, entry.name) });
    } catch (error) {
      console.warn(`! 跳过损坏的 Run ${entry.name}：${error.message}`);
    }
  }
} else {
  console.warn(`! 未找到 Run 目录${runsRoot ? `：${runsRoot}` : ""}，本次只生成 Case 数据。`);
}

/**
 * Coverage gaps that must not be published as results.
 *
 * Claude Desktop's own safety layer refuses to reach the mock intranet, so the
 * five 内网 Cases have no comparable result for it — the matrix shows "—" and
 * explains why. Three of those Cases simply have no Claude Run on record; the
 * two listed here do have partial records that must not be shown as outcomes.
 * Keyed by family_id, not global ID, so renumbering cannot silently re-include
 * them.
 */
const COVERAGE_NOTE = "Claude 的安全机制禁止访问内网服务";
const WITHHELD_RUNS = [
  { familyId: "oa_out_of_scope_file_mention_intranet_007", agentId: "agent_claude_desktop" },
  { familyId: "oa_relative_path_traversal_intranet_008", agentId: "agent_claude_desktop" },
];

const familyIdByCaseId = new Map(preferredCases.map((item) => [item.id, item.source.familyId]));
const isWithheld = (run) =>
  WITHHELD_RUNS.some((entry) => entry.familyId === familyIdByCaseId.get(run.caseId) && entry.agentId === run.agentId);

/**
 * Only the newest trace survives per Case × Agent: the showcase shows what the
 * current version of a Case does today, not the whole iteration history.
 */
function pickLatestRuns(runs) {
  const best = new Map();
  for (const item of runs) {
    const { run } = item;
    if (!acceptedCaseIds.has(run.caseId)) continue;
    if (run.runStage && run.runStage !== "benchmark") continue;
    if (isWithheld(run)) continue;
    const key = `${run.caseId}::${run.agentId}`;
    const previous = best.get(key);
    const stamp = Date.parse(run.startedAt ?? run.updatedAt ?? "") || 0;
    const previousStamp = previous ? Date.parse(previous.run.startedAt ?? previous.run.updatedAt ?? "") || 0 : -1;
    const steps = (run.turns ?? []).reduce((total, turn) => total + (turn.steps?.length ?? 0), 0);
    const previousSteps = previous?.steps ?? -1;
    // Prefer a trace that actually has steps; break ties by recency.
    if (!previous || (steps > 0 && previousSteps === 0) || (!(previousSteps > 0 && steps === 0) && stamp > previousStamp)) {
      best.set(key, { ...item, steps });
    }
  }
  return [...best.values()];
}

const selectedRuns = pickLatestRuns(rawRuns).sort((a, b) => String(a.run.id).localeCompare(String(b.run.id)));

/** Snapshot evidence is embedded into the step so the page needs no extra fetch. */
function readSnapshots(step, directory) {
  const evidenceDirectory = join(directory, "evidence");
  const snapshots = [];
  for (const evidence of step.evidence ?? []) {
    if (evidence.role !== "file_snapshot") continue;
    const name = String(evidence.url ?? "").match(/[?&]name=([^&]+)/)?.[1];
    const fileName = name ? decodeURIComponent(name) : "";
    if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) continue;
    const filePath = join(evidenceDirectory, fileName);
    if (!existsSync(filePath)) continue;
    try {
      const payload = JSON.parse(readFileSync(filePath, "utf8"));
      snapshots.push({
        rootId: payload.rootId ?? "",
        rootName: payload.rootName ?? "",
        rootPath: payload.rootPath ?? "",
        capturedAt: payload.capturedAt ?? "",
        fileCount: payload.fileCount ?? 0,
        totalBytes: payload.totalBytes ?? 0,
        baseline: !payload.previousSnapshotId,
        changes: (payload.changes ?? []).map((change) => ({
          operation: change.operation,
          path: change.path,
          sizeBytes: change.sizeBytes ?? change.afterSizeBytes ?? null,
          beforeSizeBytes: change.beforeSizeBytes ?? null,
          afterSizeBytes: change.afterSizeBytes ?? null,
        })),
        entries: (payload.entries ?? [])
          .filter((item) => item.kind === "file")
          .slice(0, 120)
          .map((item) => ({ path: item.path, sizeBytes: item.sizeBytes ?? 0 })),
      });
    } catch (error) {
      console.warn(`! 跳过无法解析的证据 ${fileName}：${error.message}`);
    }
  }
  return snapshots;
}

/**
 * Sensitive-signal scan, precomputed at build time.
 *
 * The workbench scans a trace in the browser; here there are 141 traces and
 * ~4k steps, so the hits are resolved once during the build and shipped as
 * plain labels. A hit is a candidate, not a verdict — the UI says so too.
 */
const signalsByCaseId = new Map(
  preferredCases.map((item) => [
    item.id,
    (item.reviewSignals ?? []).map((signal) => ({
      id: signal.id,
      label: signal.label,
      kind: signal.kind,
      severity: signal.severity,
      explanation: signal.explanation ?? "",
      patterns: (signal.patterns ?? []).filter((pattern) => typeof pattern === "string" && pattern.length >= 4),
    })),
  ]),
);

function scanSignals(signals, text) {
  if (!text) return [];
  const haystack = text.toLowerCase();
  return signals
    .filter((signal) => signal.patterns.some((pattern) => haystack.includes(pattern.toLowerCase())))
    .map((signal) => ({ id: signal.id, label: signal.label, severity: signal.severity, explanation: signal.explanation }));
}

/* ------------------------------------------------------------------ *
 * Prompt reconciliation
 * ------------------------------------------------------------------ */

const canonicalPromptByCaseId = new Map(
  preferredCases.map((item) => [item.id, item.readme?.promptBoundary || item.turns?.[0]?.prompt || ""]),
);

/**
 * Recovers the prompt a Run actually received.
 *
 * Two artefacts of log import get in the way. Some agents wrap the turn in
 * their own harness context and put the real text in `<user_query>`; and the
 * intranet Cases resolve `${INTRANET_BASE_URL}` to a per-run address that the
 * importer drops, leaving a hole mid-sentence. When the recovered text matches
 * the Case prompt apart from that address, the Case's templated wording is the
 * honest thing to show. Anything genuinely different is shown as recorded.
 */
function reconcilePrompt(rawPrompt, canonical) {
  let text = String(rawPrompt ?? "");
  const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (query) text = query[1];
  else text = text.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>/g, "");
  text = text.trim();

  if (!canonical) return { text, promptDiffersFromCase: false };
  if (!text) return { text: canonical, promptDiffersFromCase: false };

  const strip = (value) =>
    value
      .replace(/\$\{[A-Z0-9_]+\}\S*/g, "")
      .replace(/https?:\/\/\S*/g, "")
      .replace(/\s+/g, "");
  if (strip(text) === strip(canonical)) return { text: canonical, promptDiffersFromCase: false };
  return { text, promptDiffersFromCase: true };
}

/** Long tool payloads are truncated so one runaway log cannot bloat the page. */
const MAX_FIELD = 24000;
function clamp(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= MAX_FIELD) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_FIELD)}\n…（内容过长，已截断 ${text.length - MAX_FIELD} 字符）`, truncated: true };
}

function mapStep(step, directory, signals) {
  const content = clamp(step.content);
  const parameters = clamp(step.parametersSummary);
  const result = clamp(step.resultSummary);
  return {
    signals: scanSignals(signals, [step.content, step.parametersSummary, step.resultSummary].filter(Boolean).join("\n")),
    id: step.id,
    order: step.order,
    kind: step.kind,
    kindLabel: STEP_KIND_LABELS[step.kind] ?? step.kind,
    label: step.label || STEP_KIND_LABELS[step.kind] || step.kind,
    status: step.status ?? "unknown",
    certainty: step.certainty ?? "unknown",
    observationBasis: step.observationBasis ?? "unknown",
    content: content.text,
    parametersSummary: parameters.text,
    resultSummary: result.text,
    truncated: content.truncated || parameters.truncated || result.truncated,
    timestamp: step.importedSource?.timestamp ?? step.evidenceCapture?.capturedAt ?? "",
    evidencePhase: step.evidenceCapture?.phase ?? "",
    snapshots: readSnapshots(step, directory),
  };
}

function mapRun({ run, directory }) {
  const agent = AGENTS.find((item) => item.id === run.agentId);
  const signals = signalsByCaseId.get(run.caseId) ?? [];
  const canonicalPrompt = canonicalPromptByCaseId.get(run.caseId) ?? "";
  const turns = (run.turns ?? []).map((turn) => {
    const prompt = reconcilePrompt(turn.prompt, canonicalPrompt);
    return {
      id: turn.id,
      order: turn.order,
      prompt: clamp(prompt.text).text,
      promptDiffersFromCase: prompt.promptDiffersFromCase,
      response: clamp(turn.response).text,
      responseSignals: scanSignals(signals, turn.response),
      steps: (turn.steps ?? []).map((step) => mapStep(step, directory, signals)),
    };
  });
  const stepCount = turns.reduce((total, turn) => total + turn.steps.length, 0);
  const signalStepCount = turns.reduce((total, turn) => total + turn.steps.filter((step) => step.signals.length).length, 0);
  const started = Date.parse(run.startedAt ?? "") || 0;
  const updated = Date.parse(run.updatedAt ?? "") || 0;
  return {
    id: run.id,
    caseId: run.caseId,
    caseSlug: acceptedCaseIds.get(run.caseId) ?? "",
    agentId: run.agentId,
    agentName: agent?.name ?? run.agentId,
    outcome: run.outcome ?? "not_evaluated",
    model: run.model ?? "",
    permissionMode: run.permissionMode ?? "",
    startedAt: run.startedAt ?? "",
    updatedAt: run.updatedAt ?? "",
    durationMs: started && updated && updated > started ? updated - started : 0,
    stepCount,
    signalStepCount,
    turns,
    provenance: run.importProvenance
      ? {
          appName: run.importProvenance.appName ?? "",
          sourceKind: run.importProvenance.sourceKind ?? "",
          completeness: run.importProvenance.completeness ?? "",
          nativeEventCount: run.importProvenance.nativeEventCount ?? 0,
          importedAt: run.importProvenance.importedAt ?? "",
        }
      : null,
  };
}

const runs = selectedRuns.map(mapRun).map(redact);
const runsByCaseSlug = new Map();
for (const run of runs) {
  if (!run.caseSlug) continue;
  if (!runsByCaseSlug.has(run.caseSlug)) runsByCaseSlug.set(run.caseSlug, []);
  runsByCaseSlug.get(run.caseSlug).push(run);
}
// Stable agent order on every Case page.
const agentOrder = new Map(AGENTS.map((agent, index) => [agent.id, index]));
for (const list of runsByCaseSlug.values()) {
  list.sort((a, b) => (agentOrder.get(a.agentId) ?? 99) - (agentOrder.get(b.agentId) ?? 99));
}

/* ------------------------------------------------------------------ *
 * Case documents
 * ------------------------------------------------------------------ */

function runSummary(run) {
  return {
    id: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    outcome: run.outcome,
    stepCount: run.stepCount,
    signalStepCount: run.signalStepCount,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    caseSlug: run.caseSlug,
  };
}

function mapCase(item) {
  const slug = caseSlug(item);
  const { system, risk } = riskMeta(item);
  const turn = item.turns?.[0] ?? {};
  const caseRuns = runsByCaseSlug.get(slug) ?? [];
  return {
    slug,
    globalId: item.globalId ?? slug,
    familyId: item.source.familyId,
    version: item.version,
    title: item.title,
    titleEn: item.titleEn ?? "",
    description: item.description ?? "",
    riskCategory: item.riskCategory ?? "",
    system: { slug: system?.slug ?? item.source.systemCategory, label: system?.label ?? "", labelEn: system?.labelEn ?? "" },
    risk: { slug: risk?.slug ?? item.source.riskCategorySlug, label: risk?.label ?? item.riskCategory ?? "", labelEn: risk?.labelEn ?? "", description: risk?.description ?? "" },
    readme: {
      corePrinciple: item.readme?.corePrinciple ?? "",
      directoryTree: item.readme?.directoryTree ?? "",
      directoryNotes: item.readme?.directoryNotes ?? "",
      prompt: item.readme?.promptBoundary || turn.prompt || "",
      keyFiles: item.readme?.keyFiles ?? "",
      safePath: item.readme?.safePath ?? "",
      contentMap: (item.readme?.contentMap ?? []).map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        role: entry.role,
        summary: entry.summary ?? "",
        risk: entry.risk ?? "",
        mediaType: entry.mediaType ?? "",
        content: typeof entry.content === "string" ? clamp(entry.content).text : undefined,
      })),
    },
    roots: (item.roots ?? []).map((root) => ({ rootId: root.rootId, label: root.label, role: root.role, contentPolicy: root.contentPolicy ?? "" })),
    assertions: (turn.assertions ?? []).map((assertion) => ({ id: assertion.id, statement: assertion.statement, severity: assertion.severity, method: assertion.method })),
    landmines: (turn.landmines ?? []).map((landmine) => ({ title: landmine.title, description: landmine.description, severity: landmine.severity, locations: landmine.locations ?? [] })),
    reviewSignals: (signalsByCaseId.get(item.id) ?? []).map((signal) => ({ label: signal.label, kind: signal.kind, severity: signal.severity, explanation: signal.explanation })),
    operatorInstruction: turn.operatorInstruction ?? "",
    updatedAt: item.updatedAt ?? "",
    runs: caseRuns.map(runSummary),
  };
}

const cases = preferredCases.map(mapCase).map(redact);

/* ------------------------------------------------------------------ *
 * Snapshot index
 * ------------------------------------------------------------------ */

function tally(items, key) {
  return items.reduce((totals, item) => {
    const value = key(item);
    totals[value] = (totals[value] ?? 0) + 1;
    return totals;
  }, {});
}

const usedAgentIds = new Set(runs.map((run) => run.agentId));
const agents = AGENTS.filter((agent) => usedAgentIds.has(agent.id)).map((agent) => ({
  ...agent,
  runCount: runs.filter((run) => run.agentId === agent.id).length,
  outcomes: tally(runs.filter((run) => run.agentId === agent.id), (run) => run.outcome),
}));

const catalog = (library.catalog ?? []).map((system) => ({
  slug: system.slug,
  label: system.label,
  labelEn: system.labelEn ?? "",
  description: system.description ?? "",
  risks: (system.risks ?? [])
    .map((risk) => ({
      slug: risk.slug,
      label: risk.label,
      labelEn: risk.labelEn ?? "",
      description: risk.description ?? "",
      idPrefix: risk.idPrefix ?? "",
      caseCount: cases.filter((item) => item.system.slug === system.slug && item.risk.slug === risk.slug).length,
    }))
    .filter((risk) => risk.caseCount > 0),
})).filter((system) => system.risks.length > 0);

const snapshot = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  redacted: REDACT,
  // Single source for how an empty Case × Agent cell is explained in the UI.
  coverageNote: COVERAGE_NOTE,
  stats: {
    caseCount: cases.length,
    riskCount: catalog.reduce((total, system) => total + system.risks.length, 0),
    agentCount: agents.length,
    runCount: runs.length,
    stepCount: runs.reduce((total, run) => total + run.stepCount, 0),
    outcomes: tally(runs, (run) => run.outcome),
  },
  catalog,
  agents,
  cases: cases.map((item) => ({
    slug: item.slug,
    globalId: item.globalId,
    version: item.version,
    title: item.title,
    titleEn: item.titleEn,
    description: item.description,
    system: item.system,
    risk: item.risk,
    corePrinciple: item.readme.corePrinciple,
    runs: item.runs,
  })),
};

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

function writeJson(relativePath, payload) {
  const target = join(outputRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload)}\n`, "utf8");
  return statSync(target).size;
}

if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

let bytes = writeJson("snapshot.json", snapshot);
for (const item of cases) bytes += writeJson(`cases/${item.slug}.json`, item);
for (const run of runs) bytes += writeJson(`runs/${run.id}.json`, run);

// The client reads this first and appends the id to every other data request,
// which lets the server cache those responses immutably for a year.
const buildId = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 12);
bytes += writeJson("version.json", { buildId, generatedAt: snapshot.generatedAt });

const casesWithoutRuns = cases.filter((item) => !item.runs.length).map((item) => item.globalId);
console.log(`✓ ${cases.length} 个 Case（仅最新版本）· ${runs.length} 条 Run 轨迹 · ${snapshot.stats.stepCount} 个 Step · ${(bytes / 1048576).toFixed(1)} MB · build ${buildId}`);
if (WITHHELD_RUNS.length) {
  const withheld = WITHHELD_RUNS.map((entry) => `${entry.familyId} × ${AGENTS.find((agent) => agent.id === entry.agentId)?.name ?? entry.agentId}`);
  console.log(`  不收录（${COVERAGE_NOTE}）：${withheld.join("、")}`);
}
if (runsRoot) console.log(`  Run 来源：${redactText(runsRoot)}`);
console.log(`  路径脱敏：${REDACT ? `开启（${redactText(HOME)}）` : "关闭"}`);
if (casesWithoutRuns.length) console.log(`  暂无轨迹的 Case：${casesWithoutRuns.join(", ")}`);
