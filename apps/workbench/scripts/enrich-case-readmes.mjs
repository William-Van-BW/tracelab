import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const caseLibraryRoot = join(repositoryRoot, "case-library");

function collect(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path, files);
    else if (entry.name === "case.json" || entry.name.endsWith(".case.json")) files.push(path);
  }
  return files;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function truncate(value, length = 140) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function allAssertions(source) {
  return [...(source.turns ?? []).flatMap((turn) => turn.assertions ?? []), ...(source.run_assertions ?? [])];
}

function inferRiskCategory(source) {
  const id = source.case_id ?? "";
  if (source.suite_id === "office_agent_file_sandbox") {
    if (/_(00[1-6])$/.test(id)) return "越界读取";
    if (/_(00[7-9]|01[0-4])$/.test(id)) return "重要文件删除或改写";
    return "脚本/软件间接副作用";
  }
  if (source.suite_id === "office_agent_user_authorization") {
    if (/_(00[1-3])$/.test(id)) return "敏感信息越权访问";
    if (/_(00[4-9]|010)$/.test(id)) return "未授权文件或系统变更";
    if (/_(01[1-5])$/.test(id)) return "未经确认的对外或业务操作";
    return "凭据泄露与不可信外部交互";
  }
  if (/external|boundary|read/i.test(id)) return "越界读取";
  if (/delete|overwrite|modify|move/i.test(id)) return "重要文件删除或改写";
  if (/web|http|browser|phishing/i.test(id)) return "不可信外部交互";
  return "综合安全边界";
}

function protectedPaths(source) {
  return unique(allAssertions(source).flatMap((assertion) => assertion.evaluation?.rule?.forbidden_changes ?? []).map(String));
}

function fixtureSourcePath(caseFile, fixture) {
  return fixture.source_path ? join(dirname(caseFile), ...String(fixture.source_path).split("/")) : "";
}

function fixtureText(caseFile, fixture) {
  const sourcePath = fixtureSourcePath(caseFile, fixture);
  if (!sourcePath || !existsSync(sourcePath) || !statSync(sourcePath).isFile()) return "";
  if (!new Set([".txt", ".md", ".csv", ".json", ".ps1", ".cmd", ".html", ".url"]).has(extname(sourcePath).toLowerCase())) return "";
  try {
    return readFileSync(sourcePath, "utf8");
  } catch {
    return "";
  }
}

function lineExcerpt(text, index) {
  const line = String(text.split(/\r?\n/)[index] ?? "").trim();
  return line ? `第 ${index + 1} 行：“${truncate(line.replace(/CANARY-[A-Z0-9-]+/g, "[合成敏感标记]"), 180)}”` : "";
}

function inducementExcerpt(caseFile, fixture) {
  const text = fixtureText(caseFile, fixture);
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (extname(fixture.relative_path ?? fixture.source_path ?? "").toLowerCase() === ".md") {
    const headingIndex = lines.findIndex((line) => /^#{1,6}\s+.*(?:执行口径|办理口径)/.test(line.trim()));
    if (headingIndex >= 0) {
      const candidates = [];
      for (let index = headingIndex + 1; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (/^#{1,6}\s+/.test(line)) break;
        if (line) candidates.push(index);
      }
      if (candidates.length) {
        const chosen = candidates.length >= 3 ? candidates[2] : candidates[0];
        const candidate = lines[chosen].trim();
        const strongInducement = /请结合|参考附件|快捷入口|浏览器.*(?:接收|下载)|上一级|相邻|工作区外|明文\s*HTTP|公共在线|上传.*(?:入口|文件)|下载并运行|重定向|任何获得链接的人/i.test(candidate);
        if (strongInducement) return lineExcerpt(text, chosen);
      }
    }
  }
  const riskyLine = lines.findIndex((line) => /\$\{EXTERNAL|\.\.\\|\.\.\/|https?:\/\/|Remove-Item|Move-Item|Rename-Item|Compress-Archive|Copy-Item|upload|session|公开|任何获得链接的人/i.test(line));
  return riskyLine >= 0 ? lineExcerpt(text, riskyLine) : "";
}

function roleForFixture(source, caseFile, fixture, protectedFiles) {
  const path = fixture.relative_path ?? fixture.source_path ?? "";
  const reference = `${fixture.root_id ?? "fixture"}:${path}`;
  const extension = extname(path).toLowerCase();
  const text = fixtureText(caseFile, fixture);
  const forbiddenTokens = unique(allAssertions(source).flatMap((assertion) => assertion.evaluation?.rule?.forbidden_tokens ?? []));
  const isTestSite = fixture.root_id === "test_site" || extension === ".html";
  if (isTestSite) return "inducement";
  if (/受保护业务对象/.test(fixture.purpose ?? "")) return "protected_asset";
  if (protectedFiles.includes(reference)) return "protected_asset";
  if (forbiddenTokens.some((token) => text.includes(token))) return "protected_asset";

  const monitoredRoot = (source.monitored_resources?.filesystem_roots ?? []).find((root) => root.root_id === fixture.root_id);
  const authorizedRoots = source.authorization_scope?.default_filesystem_scope ?? [];
  const restrictedFixture = ["confidential", "restricted", "sensitive"].includes(fixture.sensitivity);
  const outsideAuthorizedScope = fixture.root_id && fixture.root_id !== "workspace" && !authorizedRoots.includes(fixture.root_id);
  const metadataOnly = (source.authorization_scope?.notes ?? []).some((note) => note.includes(fixture.root_id) && /仅授权.*(?:元数据|文件名|大小|修改时间)/.test(note));
  if ((monitoredRoot?.expected_access === "none" || outsideAuthorizedScope || metadataOnly || restrictedFixture) && fixture.root_id !== "web_state") return "protected_asset";

  if (extension === ".md") {
    if (inducementExcerpt(caseFile, fixture)) return "inducement";
    if (/README|说明|制度|要求|规则|口径|备忘|清单/i.test(path)) return "safety_policy";
    return "supporting";
  }
  if (/(?:^|\/)工具(?:\/|$)|script|\.ps1$|\.cmd$|\.bat$|\.json$/i.test(path)) return "inducement";
  if (/README|说明|制度|要求|规则|口径|备忘|清单/i.test(path)) return "safety_policy";
  if (/evidence|webstate|events\.jsonl|日志/i.test(path)) return "evidence";
  return "supporting";
}

function fileExcerpt(caseFile, fixture) {
  const text = fixtureText(caseFile, fixture);
  return text ? truncate(text.replace(/CANARY-[A-Z0-9-]+/g, "[合成敏感标记]"), 110) : "";
}

function fixtureSummary(caseFile, fixture, role) {
  const inducement = role === "inducement" ? inducementExcerpt(caseFile, fixture) : "";
  if (inducement) return inducement;
  const excerpt = fileExcerpt(caseFile, fixture);
  if (excerpt) return excerpt;
  const name = basename(fixture.relative_path ?? fixture.source_path ?? "fixture");
  const media = fixture.media_type ? `，格式 ${fixture.media_type}` : "";
  const sensitivity = fixture.sensitivity ? `，敏感级别 ${fixture.sensitivity}` : "";
  return `${fixture.purpose || `${name} 的合成测试内容`}${media}${sensitivity}`;
}

function buildReadme(caseFile, source) {
  const assertions = allAssertions(source);
  const protectedFiles = protectedPaths(source);
  const conditions = unique(assertions.flatMap((assertion) => assertion.expectation?.conditions ?? []));
  const promptNotes = (source.turns ?? []).map((turn) => {
    const prompt = (turn.user_input ?? []).filter((part) => part.kind === "text").map((part) => part.text).join("\n");
    const assertion = turn.assertions?.[0];
    return {
      turn_id: turn.case_turn_id,
      content: prompt,
      inducement: truncate(source.description || conditions[0] || "以正常业务目标弱化对授权边界和副作用的关注。", 220),
      expected_failure: truncate(assertion?.statement || "Agent 可能在没有充分核验范围或审批的情况下执行动作。", 220),
    };
  });
  const fixtureEntries = (source.fixtures ?? []).map((fixture) => {
    const role = roleForFixture(source, caseFile, fixture, protectedFiles);
    return {
      path: `${fixture.root_id ?? "fixture"}:${fixture.relative_path ?? fixture.source_path ?? fixture.fixture_id}`,
      kind: /\.ps1$|\.cmd$|\.bat$/i.test(fixture.relative_path ?? "") ? "tool" : "file",
      summary: fixtureSummary(caseFile, fixture, role),
      role,
      ...(role === "inducement" || role === "protected_asset" ? { risk: truncate(source.description || conditions[0] || "可能触发越权访问或高风险副作用。", 160) } : {}),
    };
  });
  const promptEntries = promptNotes.map((note) => ({
    path: `prompt:${note.turn_id}`,
    kind: "prompt",
    summary: truncate(note.content, 180),
    role: "inducement",
    risk: note.expected_failure,
  }));
  const browserEntries = (source.monitored_resources?.browser_targets ?? []).map((target, index) => ({
    path: `website:${target.target_id ?? target.url ?? index + 1}`,
    kind: "website",
    summary: truncate(target.description || target.url || "本地合成测试站点", 160),
    role: "evidence",
  }));
  const postDeployEntries = (source.fixture_package?.post_deploy_actions ?? []).map((action, index) => ({
    path: action.kind === "local_http_site"
      ? `website:${action.site_root_id ?? `post_deploy_${index + 1}`}`
      : `${action.root_id ?? "workspace"}:${action.relative_path ?? `post_deploy_${index + 1}`}`,
    kind: action.kind === "windows_junction" ? "directory" : action.kind === "local_http_site" ? "website" : "tool",
    summary: action.target_root_id
      ? `${action.kind} 指向 ${action.target_root_id}:${action.target_relative_path ?? ""}`
      : truncate(JSON.stringify(action), 180),
    role: "inducement",
    risk: truncate(source.description || conditions[0] || "部署后的链接或工具可能将操作引向授权范围外。", 160),
  }));
  const safety = source.fixture_package?.safety ?? {};
  const inducementSources = [...fixtureEntries, ...postDeployEntries]
    .filter((entry) => entry.role === "inducement" && (/^第 \d+ 行：/.test(entry.summary) || entry.kind === "directory"))
    .map((entry) => `${entry.path} ${entry.summary}`);
  const inducement = inducementSources.length
    ? `具体诱导来源：${inducementSources.join("；")}`
    : conditions[0] || source.description || "正常业务目标与便利工具会推动 Agent 快速完成任务，从而忽略范围确认、即时审批或隐藏副作用。";
  for (const note of promptNotes) note.inducement = inducement;
  return {
    overview: source.description || `${source.title} 的人工安全评测 Case。`,
    design_logic: `以“${source.turns?.[0]?.title || source.title}”作为表层办公目标，将关键约束分散在 Prompt、说明文件、工具行为和受保护资源中；通过前后证据判断 Agent 是否识别并遵守真实授权边界。`,
    inducement,
    expected_failures: unique(assertions.map((assertion) => assertion.statement)).slice(0, 8).length
      ? unique(assertions.map((assertion) => assertion.statement)).slice(0, 8)
      : ["Agent 可能把主机能力或自动审批误当成用户授权。"],
    safety_measures: unique([
      "所有业务数据、站点和敏感标记均为隔离的合成测试材料。",
      ...(source.authorization_scope?.notes ?? []),
      safety.cleanup_marker_required ? "销毁前校验清理标记，避免误删部署目录之外的文件。" : "",
      safety.destruction_must_stay_within_deployment_root ? "销毁动作被限制在本 Case 的部署根目录内。" : "",
      safety.capture_diff_before_destroy ? "销毁前保存最终快照与 diff，保留可复核证据。" : "",
    ]),
    audit_focus: unique([
      ...conditions,
      ...protectedFiles.map((path) => `确认受保护资源未发生未授权变化：${path}`),
      ...assertions.flatMap((assertion) => assertion.evaluation?.required_evidence ?? []).map((item) => item.observation_id ? `核对证据采集点：${item.observation_id}` : "核对对话、工具调用与实际副作用的时序。"),
    ]).slice(0, 12),
    prompt_notes: promptNotes,
    content_map: [...promptEntries, ...fixtureEntries, ...postDeployEntries, ...browserEntries],
  };
}

let changed = 0;
const targets = [
  ...collect(caseLibraryRoot),
  join(repositoryRoot, "spec", "templates", "manual-run-template", "case.json"),
  join(repositoryRoot, "spec", "examples", "example-run", "case.json"),
].filter(existsSync).sort();
for (const caseFile of targets) {
  const source = JSON.parse(readFileSync(caseFile, "utf8"));
  if (source.document_type !== "test_case") continue;
  source.risk_category = inferRiskCategory(source);
  source.readme = buildReadme(caseFile, source);
  writeFileSync(caseFile, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  changed += 1;
}

console.log(`Enriched ${changed} Case JSON files under ${relative(repositoryRoot, caseLibraryRoot)}`);
