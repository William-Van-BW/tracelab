/**
 * TraceLab Showcase — 只读前端。
 *
 * 没有构建步骤、没有依赖：hash 路由 + 少量 DOM 构造函数。所有文本都走
 * textContent，页面从不把数据当 HTML 解析，因此轨迹里的任意日志内容都无法
 * 影响页面结构。
 */

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/**
 * @param {string} tag  形如 "div.case-row" 或 "a.button.ghost"
 * @param {object} [props]
 * @param {Array|Node|string} [children]
 */
function el(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split(".");
  const node = document.createElement(name || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = node.className ? `${node.className} ${value}` : value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("html 属性被禁用：请使用 text");
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const frag = (children) => {
  const container = document.createDocumentFragment();
  for (const child of [].concat(children)) if (child) container.append(child);
  return container;
};

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const OUTCOME_LABELS = {
  pass: "安全通过",
  fail: "存在安全风险",
  warning: "存在轻微风险",
  not_evaluated: "未判定",
  inconclusive: "证据不足",
};

const STATUS_LABELS = { success: "成功", failed: "失败", blocked: "被阻止", unknown: "未知" };
const BASIS_LABELS = {
  imported_log: "原生日志导入",
  system_ui: "系统采集",
  agent_ui: "界面观察",
  native_protocol: "原生协议",
  operator_inference: "人工推断",
  unknown: "未知",
};
// 展示用词：这些材料还原的是真实办公目录里本来就存在的东西，
// 不是为难 Agent 的陷阱，所以 inducement 显示为「风险线索」而非「诱导材料」。
const ROLE_LABELS = { inducement: "风险线索", protected_asset: "受保护资产", supporting: "支撑材料", policy: "规则说明" };
const ROOT_LABELS = {
  workspace: "Workspace（授权工作区）",
  external_sensitive: "工作区外受保护目录",
  external_control: "工作区外对照目录",
  intranet: "内网共享库（远端）",
  prompt: "用户 Prompt",
};

const outcomeLabel = (value) => OUTCOME_LABELS[value] ?? value;

function formatDate(value) {
  const time = Date.parse(value ?? "");
  if (!time) return "—";
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * Minimal markdown — headings, fenced code, lists, bold, inline code
 * ------------------------------------------------------------------ */

/** Renders inline `code` and **bold** into text nodes; never parses HTML. */
function inlineMarkdown(text) {
  const container = document.createDocumentFragment();
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) container.append(el("code", { text: token.slice(1, -1) }));
    else container.append(el("strong", { text: token.slice(2, -2) }));
    cursor = match.index + token.length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  return container;
}

/**
 * The Case read-out fields are authored as light markdown (fenced payload
 * excerpts, the occasional heading or bullet list). Anything unrecognised
 * falls through as a plain paragraph.
 */
function markdown(source) {
  const wrapper = el("div.prose");
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    wrapper.append(el("p", {}, inlineMarkdown(paragraph.join("\n"))));
    paragraph = [];
  };
  const flushList = () => {
    if (list) wrapper.append(list);
    list = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      wrapper.append(el("pre.block.wrap", { text: body.join("\n") }));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      wrapper.append(el("h3", {}, inlineMarkdown(heading[2])));
      index += 1;
      continue;
    }
    const bullet = line.match(/^\s*[-*·]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!list) list = el("ul");
      list.append(el("li", {}, inlineMarkdown(bullet[1])));
      index += 1;
      continue;
    }
    flushList();
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  flushList();
  return wrapper;
}

/* ------------------------------------------------------------------ *
 * Data access — fetch once, cache in memory, retry transient failures
 * ------------------------------------------------------------------ */

const store = {
  version: null,
  snapshot: null,
  cases: new Map(),
  runs: new Map(),
};

async function fetchJson(url, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.status === 404) {
        const error = new Error("NOT_FOUND");
        error.notFound = true;
        throw error;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error.notFound) throw error;
      lastError = error;
      // Back off briefly: a cold server or a flaky network should not turn
      // into a dead page on the first hiccup.
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("请求失败");
}

async function versionTag() {
  if (!store.version) {
    try {
      const payload = await fetchJson("data/version.json");
      store.version = payload.buildId ?? "dev";
      store.generatedAt = payload.generatedAt ?? "";
    } catch {
      store.version = "dev";
    }
  }
  return store.version;
}

async function loadSnapshot() {
  if (store.snapshot) return store.snapshot;
  store.snapshot = await fetchJson(`data/snapshot.json?v=${await versionTag()}`);
  return store.snapshot;
}

async function loadCase(slug) {
  if (store.cases.has(slug)) return store.cases.get(slug);
  const payload = await fetchJson(`data/cases/${encodeURIComponent(slug)}.json?v=${await versionTag()}`);
  store.cases.set(slug, payload);
  return payload;
}

async function loadRun(id) {
  if (store.runs.has(id)) return store.runs.get(id);
  const payload = await fetchJson(`data/runs/${encodeURIComponent(id)}.json?v=${await versionTag()}`);
  store.runs.set(id, payload);
  return payload;
}

/* ------------------------------------------------------------------ *
 * Shared fragments
 * ------------------------------------------------------------------ */

const verdict = (outcome) => el("span.verdict", { class: outcome, text: outcomeLabel(outcome) });

function outcomeStrip(runs) {
  const strip = el("span.outcome-strip", { title: runs.map((run) => `${run.agentName}：${outcomeLabel(run.outcome)}`).join("\n") });
  for (const run of runs) strip.append(el("i.outcome-dot", { class: run.outcome }));
  return strip;
}

function agentColor(snapshot, agentId) {
  return snapshot?.agents.find((agent) => agent.id === agentId)?.accent ?? "#9c9a92";
}

function breadcrumb(items) {
  const nav = el("nav.breadcrumb", { "aria-label": "面包屑" });
  items.forEach((item, index) => {
    if (index) nav.append(el("span", { text: "/" }));
    nav.append(item.href ? el("a", { href: item.href, text: item.label }) : el("span", { text: item.label }));
  });
  return nav;
}

function stateBlock({ title, detail, spinner = false, action }) {
  return el("div.shell", {}, [
    el("div.state", {}, [
      spinner ? el("div.spinner", { role: "status", "aria-label": "加载中" }) : null,
      title ? el("h2", { text: title }) : null,
      detail ? el("p", { text: detail }) : null,
      action ? el("p", { style: "margin-top:22px" }, [action]) : null,
    ]),
  ]);
}

function panel(id, eyebrow, heading, body, note) {
  return el("section.panel", { id }, [
    el("p.eyebrow", { text: eyebrow }),
    el("h2", { text: heading }),
    note ? el("p.panel-note", { text: note }) : null,
    ...[].concat(body).filter(Boolean),
  ]);
}

/* ------------------------------------------------------------------ *
 * View: 概览
 * ------------------------------------------------------------------ */

function renderHome(snapshot) {
  const { stats } = snapshot;
  const view = document.createDocumentFragment();

  view.append(
    el("section.shell.hero", {}, [
      el("p.eyebrow", { text: "Office agent · file safety evaluation" }),
      el("h1", { text: "办公智能体大战正酣，它能安全地操作你的文件吗？" }),
      el("p.lede", {
        text:
          "真实的办公目录本身就带着风险：文件由不同的人在不同时间留下，命名未必规范，" +
          "旧说明没有及时删除，业务系统仍依赖几年前写下的相对路径，内网 SOP 也可能和部门自己的规定冲突。" +
          "我们把这样的场景还原成可复现、可取证的任务，记录智能体的每一次读取、执行与写入——" +
          "要回答的不只是它“能不能”操作文件，更是它“该不该”这样操作。",
      }),
      el("div.hero-actions", {}, [
        el("a.button", { href: "#/cases", text: "浏览 Case 库" }),
        el("a.button.ghost", { href: "#/runs", text: "查看轨迹总览" }),
      ]),
    ]),
  );

  view.append(
    el("div.shell", {}, [
      el("div.stat-band", {}, [
        el("div.stat", {}, [el("b", { text: String(stats.caseCount) }), el("span", { text: "测评 Case（最新版本）" })]),
        el("div.stat", {}, [el("b", { text: String(stats.riskCount) }), el("span", { text: "安全风险小类" })]),
        el("div.stat", {}, [el("b", { text: String(stats.agentCount) }), el("span", { text: "受测智能体" })]),
        el("div.stat", {}, [el("b", { text: stats.stepCount.toLocaleString("en-US") }), el("span", { text: "已记录 Step" })]),
      ]),
    ]),
  );

  // 风险分类
  const riskSection = el("section.shell.section", {}, [
    el("div.section-head", {}, [
      el("p.eyebrow", { text: "Risk taxonomy" }),
      el("h2", { text: "三类文件安全风险" }),
      el("p.lede", {
        text:
          "对应办公人员最具体的三个担忧：不该我看的会不会替我看了、该脱敏的有没有脱干净、" +
          "会不会删改预期之外的文件。关键的边界与判断依据分散在业务文档、台账、配置文件和脚本正文里，" +
          "需要先读清楚才能安全动手。",
      }),
    ]),
  ]);
  for (const system of snapshot.catalog) {
    const grid = el("div.risk-grid");
    for (const risk of system.risks) {
      grid.append(
        el("a.risk-card", { href: `#/cases?risk=${encodeURIComponent(risk.slug)}` }, [
          el("span.tag.accent", { text: risk.idPrefix || risk.label }),
          el("h3", { text: risk.label }),
          el("p", { text: risk.description }),
          el("p.risk-count", { text: `${risk.caseCount} 个 Case` }),
        ]),
      );
    }
    riskSection.append(grid);
  }
  view.append(riskSection);

  // 受测智能体
  const agentSection = el("section.shell.section", {}, [
    el("div.section-head", {}, [
      el("p.eyebrow", { text: "Subjects" }),
      el("h2", { text: "受测的桌面智能体" }),
      el("p.lede", {
        text:
          "六款主流桌面办公与编程智能体，跑同一批任务、同一套目录。" +
          "比较的不是谁把活干得更漂亮，而是它们在能直接读写本机文件时，怎么处理边界和不确定性。",
      }),
    ]),
  ]);
  const agentGrid = el("div.run-grid");
  for (const agent of snapshot.agents) {
    const total = agent.runCount || 1;
    const pass = agent.outcomes.pass ?? 0;
    agentGrid.append(
      el("div.run-card", {}, [
        el("div.agent-line", {}, [el("i.agent-dot", { style: `background:${agent.accent}` }), el("span", { text: agent.name })]),
        el("p.run-stats", {}, [el("span", { text: agent.vendor }), el("span", { text: `${agent.runCount} 条轨迹` })]),
        el("div.outcome-strip", {}, [
          el("span.verdict", { class: pass === total ? "pass" : pass ? "warning" : "fail", text: `${pass} / ${total} 安全通过` }),
        ]),
      ]),
    );
  }
  agentSection.append(agentGrid);
  view.append(agentSection);

  // Case 索引
  const caseSection = el("section.shell.section", {}, [
    el("div.section-head", {}, [
      el("p.eyebrow", { text: "Case index" }),
      el("h2", { text: "全部 Case" }),
      el("p.lede", { text: "只展示每个 Case 家族的最新版本，以及对应版本上最新一次的执行轨迹。" }),
    ]),
    caseList(snapshot, snapshot.cases),
    el("p.contact-note", {}, [
      "如想获得更多细节，欢迎联系 ",
      el("a", { href: "mailto:25213050366@m.fudan.edu.cn", text: "25213050366@m.fudan.edu.cn" }),
    ]),
  ]);
  view.append(caseSection);

  return view;
}

/* ------------------------------------------------------------------ *
 * View: Case 库
 * ------------------------------------------------------------------ */

function caseList(snapshot, cases) {
  if (!cases.length) return el("p.empty-note", { text: "没有匹配的 Case。" });
  const list = el("div.case-list");
  for (const item of cases) {
    list.append(
      el("a.case-row", { href: `#/case/${encodeURIComponent(item.slug)}` }, [
        el("span.case-id", { text: item.globalId }),
        el("div", {}, [
          el("h3", { text: item.title }),
          el("p", { text: item.description }),
          el("div.case-meta", {}, [
            el("span.tag", { text: item.risk.label }),
            el("span.tag", { text: `v${item.version}` }),
            item.runs.length ? el("span.tag", { text: `${item.runs.length} 条轨迹` }) : el("span.tag", { text: "暂无轨迹" }),
          ]),
        ]),
        outcomeStrip(item.runs),
      ]),
    );
  }
  return list;
}

function renderCases(snapshot, query) {
  const view = document.createDocumentFragment();
  view.append(
    el("section.shell", { style: "padding:56px 0 8px" }, [
      el("p.eyebrow", { text: "Case library" }),
      el("h1", { style: "font-size:clamp(30px,4vw,42px);margin:12px 0 14px", text: "Case 库" }),
      el("p.lede", {
        text:
          "每个 Case 都是一份可复现的办公任务：真实的目录结构、真实的业务材料，" +
          "以及一处日常办公中确实会遇到的风险点。安全的智能体不必拒绝整个任务，" +
          "但应当先读清规则，在证据不足时暂停确认，并尽可能完成不涉及风险的部分。",
      }),
    ]),
  );

  const activeRisk = query.get("risk") ?? "";
  const search = (query.get("q") ?? "").trim().toLowerCase();
  const risks = snapshot.catalog.flatMap((system) => system.risks);

  const results = snapshot.cases.filter((item) => {
    if (activeRisk && item.risk.slug !== activeRisk) return false;
    if (!search) return true;
    return [item.globalId, item.title, item.titleEn, item.description, item.corePrinciple, item.risk.label]
      .join(" ")
      .toLowerCase()
      .includes(search);
  });

  const toolbar = el("div.toolbar");
  const input = el("input", {
    type: "search",
    placeholder: "搜索 Case 编号、标题或核心原理…",
    value: query.get("q") ?? "",
    "aria-label": "搜索 Case",
  });
  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = new URLSearchParams(query);
      if (input.value.trim()) next.set("q", input.value.trim());
      else next.delete("q");
      // replaceState keeps the search box from stacking history entries.
      history.replaceState(null, "", `#/cases${next.toString() ? `?${next}` : ""}`);
      route({ preserveScroll: true, focusSearch: true });
    }, 200);
  });
  toolbar.append(el("div.search-field", {}, [input]));

  const chipHref = (slug) => {
    const next = new URLSearchParams(query);
    if (slug) next.set("risk", slug);
    else next.delete("risk");
    return `#/cases${next.toString() ? `?${next}` : ""}`;
  };
  toolbar.append(el("a.chip", { class: activeRisk ? "" : "active", href: chipHref(""), text: `全部 ${snapshot.cases.length}` }));
  for (const risk of risks) {
    toolbar.append(
      el("a.chip", { class: activeRisk === risk.slug ? "active" : "", href: chipHref(risk.slug), text: `${risk.label} ${risk.caseCount}` }),
    );
  }

  view.append(el("section.shell.section", { style: "padding-top:36px" }, [toolbar, caseList(snapshot, results)]));
  return view;
}

/* ------------------------------------------------------------------ *
 * View: Case 详情
 * ------------------------------------------------------------------ */

function contentTree(caseItem) {
  const items = caseItem.readme.contentMap ?? [];
  if (!items.length) return el("p.empty-note", { text: "该 Case 尚未填写目录与文件内容概括。" });

  // Same grouping as the workbench: "<root>:<第一层目录>"，无目录则归入根目录。
  const groups = new Map();
  for (const item of items) {
    const [root, rest = item.path] = item.path.split(":", 2);
    const folder = rest.includes("/") ? rest.split("/")[0] : "根目录";
    const key = `${root}:${folder}`;
    if (!groups.has(key)) groups.set(key, { root, folder, entries: [] });
    groups.get(key).entries.push(item);
  }

  const remoteCount = items.filter((item) => item.path.startsWith("intranet:")).length;
  const focusCount = items.filter((item) => item.role === "inducement" || item.role === "protected_asset").length;

  const wrapper = el("div");
  wrapper.append(
    el("div.tree-head", {}, [
      el("span", {
        text:
          `${items.filter((item) => item.kind !== "prompt").length} 个文件 / 目标` +
          (remoteCount ? ` · ${remoteCount} 个内网远端文件` : "") +
          ` · ${focusCount} 个重点项`,
      }),
      el("span.tree-legend", {}, [
        el("span", {}, [el("i.inducement"), "风险线索"]),
        el("span", {}, [el("i.protected"), "受保护资产"]),
        el("span", {}, [el("i.supporting"), "支撑材料"]),
      ]),
    ]),
  );

  for (const [key, group] of groups) {
    const focus = group.entries.some((item) => item.role !== "supporting");
    const details = el("details.tree-group", focus ? { open: "" } : {});
    details.append(
      el("summary", {}, [
        el("strong", { text: key }),
        el("span", { style: "color:var(--ink-faint);font-size:12.5px", text: ROOT_LABELS[group.root] ?? group.root }),
        el("span.count", { text: `${group.entries.length} 项` }),
      ]),
    );
    const body = el("div");
    for (const item of group.entries) body.append(contentNode(item));
    details.append(body);
    wrapper.append(details);
  }
  return wrapper;
}

function contentNode(item) {
  const [, rest = item.path] = item.path.split(":", 2);
  const node = el("div.tree-node", { class: item.role ?? "" });
  node.append(
    el("div.tree-node-head", {}, [
      el("span.node-path", { text: rest }),
      el("span.tag", { text: ROLE_LABELS[item.role] ?? item.role ?? "材料" }),
      item.kind === "prompt" ? el("span.tag.accent", { text: "PROMPT" }) : null,
      item.path.startsWith("intranet:") ? el("span.tag", { text: "内网远端" }) : null,
    ]),
  );
  if (item.summary) node.append(el("p.node-summary", { text: item.summary }));
  if (item.risk) node.append(el("p.node-risk", { text: item.risk }));
  if (typeof item.content === "string" && item.content.length) {
    const reveal = el("details.reveal");
    reveal.append(el("summary", { text: `查看文件内容 · ${formatBytes(new Blob([item.content]).size)}` }));
    reveal.append(el("pre", { text: item.content }));
    node.append(reveal);
  }
  return node;
}

function renderCase(snapshot, caseItem) {
  const view = document.createDocumentFragment();

  view.append(
    el("div.shell.detail-head", {}, [
      breadcrumb([
        { label: "概览", href: "#/" },
        { label: "Case 库", href: "#/cases" },
        { label: caseItem.risk.label, href: `#/cases?risk=${encodeURIComponent(caseItem.risk.slug)}` },
        { label: caseItem.globalId },
      ]),
      el("p.eyebrow", { text: `${caseItem.globalId} · ${caseItem.system.label} / ${caseItem.risk.label}` }),
      el("h1", { text: caseItem.title }),
      caseItem.titleEn ? el("p.title-en", { text: caseItem.titleEn }) : null,
      el("p.lede", { text: caseItem.description }),
      el("div.detail-meta", {}, [
        el("span.tag.accent", { text: `v${caseItem.version}（最新版本）` }),
        el("span.tag", { text: `${caseItem.runs.length} 条执行轨迹` }),
        ...caseItem.roots.map((root) => el("span.tag", { text: root.label })),
      ]),
    ]),
  );

  const sections = [
    ["principle", "Core principle", "核心原理"],
    ["structure", "Directory", "目录结构及解释"],
    ["prompt", "User prompt", "User Prompt"],
    ["payload", "Key files", "关键文件及 payload"],
    ["safe-path", "Expected", "预期正确路径"],
    ["tree", "Content map", "Case 目录结构与内容概括"],
    ["assertions", "Assertions", "判定基准"],
    ["runs", "Traces", "执行轨迹"],
  ];

  const body = el("div");
  body.append(
    panel("principle", "Core principle", "核心原理", el("div.callout", {}, [markdown(caseItem.readme.corePrinciple)])),
  );

  body.append(
    panel(
      "structure",
      "Directory",
      "目录结构及解释",
      [
        caseItem.readme.directoryTree ? el("pre.block", { text: caseItem.readme.directoryTree }) : null,
        caseItem.readme.directoryNotes ? el("div", { style: "margin-top:20px" }, [markdown(caseItem.readme.directoryNotes)]) : null,
      ],
      "部署后的真实目录结构。工作区之外的目录，操作系统允许访问，但用户并未授权。",
    ),
  );

  body.append(
    panel(
      "prompt",
      "User prompt",
      "User Prompt",
      [
        el("div.prompt-block", { text: caseItem.readme.prompt }),
        caseItem.operatorInstruction
          ? el("p.panel-note", { style: "margin-top:16px;margin-bottom:0", text: `操作要求：${caseItem.operatorInstruction}` })
          : null,
      ],
      "逐字输入给被测智能体的指令，不作任何提示或补充。",
    ),
  );

  body.append(
    panel("payload", "Key files", "关键文件及 payload", markdown(caseItem.readme.keyFiles), "风险线索在业务材料中的实际出处与原文。"),
  );

  body.append(
    panel("safe-path", "Expected", "预期正确路径", el("div.callout.plain", {}, [markdown(caseItem.readme.safePath)]), "在不放弃任务的前提下，安全的执行路径长什么样。"),
  );

  body.append(
    panel(
      "tree",
      "Content map",
      "Case 目录结构与内容概括",
      contentTree(caseItem),
      "展开任意条目可查看该文件在任务开始时的真实内容。",
    ),
  );

  const assertionBody = [];
  if (caseItem.assertions.length) {
    const list = el("div.two-col");
    for (const assertion of caseItem.assertions) {
      list.append(
        el("div.run-card", {}, [
          el("span.verdict", { class: assertion.severity === "critical" ? "fail" : "warning", text: assertion.severity }),
          el("p", { style: "font-size:14.5px;line-height:1.7", text: assertion.statement }),
        ]),
      );
    }
    assertionBody.push(list);
  }
  if (caseItem.reviewSignals.length) {
    const signals = el("div", { style: "margin-top:20px" }, [
      el("p.field-label", { text: "敏感信号" }),
      el("div.signal-row", {}, caseItem.reviewSignals.map((signal) => el("span.signal-pill", { class: signal.severity, title: signal.explanation, text: signal.label }))),
    ]);
    assertionBody.push(signals);
  }
  if (assertionBody.length) {
    body.append(panel("assertions", "Assertions", "判定基准", assertionBody, "命中信号只是候选证据，最终结论仍需结合上下文人工确认。"));
  }

  const runsBody = caseItem.runs.length
    ? el("div.run-grid", {}, caseItem.runs.map((run) =>
        el("a.run-card", { href: `#/run/${encodeURIComponent(run.id)}` }, [
          el("div.agent-line", {}, [
            el("i.agent-dot", { style: `background:${agentColor(snapshot, run.agentId)}` }),
            el("span", { text: run.agentName }),
          ]),
          verdict(run.outcome),
          el("p.run-stats", {}, [
            el("span", { text: `${run.stepCount} Steps` }),
            run.signalStepCount ? el("span", { text: `${run.signalStepCount} 处信号` }) : null,
            el("span", { text: formatDate(run.startedAt) }),
          ]),
        ]),
      ))
    : el("p.empty-note", { text: "该版本暂无公开轨迹。" });
  // An agent with no card on this Case is a coverage gap, not a silent omission.
  const missingAgents = snapshot.agents.filter((agent) => !caseItem.runs.some((run) => run.agentId === agent.id));
  const runsNote = missingAgents.length
    ? `每个智能体只展示当前 Case 版本上最新的一次执行。未收录 ${missingAgents.map((agent) => agent.name).join("、")}：${snapshot.coverageNote}。`
    : "每个智能体只展示当前 Case 版本上最新的一次执行。";
  body.append(panel("runs", "Traces", "执行轨迹", runsBody, runsNote));

  const sideNav = el("nav.side-nav", { "aria-label": "章节导航" });
  for (const [id, , label] of sections) {
    if (!body.querySelector(`#${id}`)) continue;
    sideNav.append(el("a", { href: `#/case/${encodeURIComponent(caseItem.slug)}`, "data-anchor": id, text: label }));
  }

  view.append(el("div.shell.layout", {}, [body, sideNav]));
  return view;
}

/* ------------------------------------------------------------------ *
 * View: 轨迹总览
 * ------------------------------------------------------------------ */

function renderRuns(snapshot) {
  const view = document.createDocumentFragment();
  view.append(
    el("section.shell", { style: "padding:56px 0 8px" }, [
      el("p.eyebrow", { text: "Trace matrix" }),
      el("h1", { style: "font-size:clamp(30px,4vw,42px);margin:12px 0 14px", text: "轨迹总览" }),
      el("p.lede", {
        text: `${snapshot.stats.caseCount} 个 Case × ${snapshot.stats.agentCount} 个智能体，每格是该 Case 最新版本上的最近一次执行。点击任意结果查看完整逐步记录。`,
      }),
    ]),
  );

  const table = el("table.matrix");
  const head = el("tr", {}, [el("th", { scope: "col", text: "Case" })]);
  for (const agent of snapshot.agents) head.append(el("th", { scope: "col", text: agent.name }));
  table.append(el("thead", {}, [head]));

  const tbody = el("tbody");
  for (const item of snapshot.cases) {
    const row = el("tr");
    row.append(
      el("th", { scope: "row" }, [
        el("a", { href: `#/case/${encodeURIComponent(item.slug)}` }, [
          el("span.case-id", { text: item.globalId }),
          el("span", { text: item.title }),
        ]),
      ]),
    );
    for (const agent of snapshot.agents) {
      const run = item.runs.find((entry) => entry.agentId === agent.id);
      row.append(
        el("td", {}, [
          run
            ? el("a.cell-link", { href: `#/run/${encodeURIComponent(run.id)}`, title: `${agent.name} · ${item.globalId} · ${run.stepCount} Steps` }, [
                el("span.cell-mark.verdict", { class: run.outcome, text: outcomeLabel(run.outcome) }),
              ])
            : el("span.cell-empty", { text: "—" }),
        ]),
      );
    }
    tbody.append(row);
  }
  table.append(tbody);

  view.append(
    el("section.shell.section", { style: "padding-top:36px" }, [
      el("div.matrix-wrap", {}, [table]),
      el("div.matrix-legend", {}, [
        el("span", {}, [el("i.outcome-dot.pass", { style: "margin-right:6px" }), "安全通过：未越界、未泄露、未误改"]),
        el("span", {}, [el("i.outcome-dot.fail", { style: "margin-right:6px" }), "存在安全风险：发生了越界访问、敏感信息泄露或受保护文件变更"]),
        el("span", {}, [el("i.outcome-dot.warning", { style: "margin-right:6px" }), "存在轻微风险：行为有一定安全隐患但未构成直接安全风险"]),
        el("span", {}, [el("i.outcome-dot.not_evaluated", { style: "margin-right:6px" }), `—：${snapshot.coverageNote}`]),
      ]),
    ]),
  );
  return view;
}

/* ------------------------------------------------------------------ *
 * View: Run 轨迹
 * ------------------------------------------------------------------ */

function snapshotBlock(snapshot) {
  const block = el("div.snapshot");
  block.append(
    el("header", {}, [
      el("strong", { text: snapshot.rootName || snapshot.rootId }),
      el("span", { text: `${snapshot.fileCount} 个文件 · ${formatBytes(snapshot.totalBytes)}${snapshot.baseline ? " · 基线采样" : ""}` }),
    ]),
  );
  if (snapshot.changes.length) {
    const list = el("ul.change-list");
    const labels = { create: "新增", modify: "修改", delete: "删除" };
    for (const change of snapshot.changes.slice(0, 60)) {
      list.append(
        el("li", { class: change.operation }, [
          el("em", { text: labels[change.operation] ?? change.operation }),
          el("span", { text: change.path }),
        ]),
      );
    }
    block.append(list);
    if (snapshot.changes.length > 60) block.append(el("p", { style: "margin-top:8px;color:var(--ink-faint)", text: `另有 ${snapshot.changes.length - 60} 项变化未展开` }));
  } else {
    block.append(el("p", { style: "color:var(--ink-faint)", text: snapshot.baseline ? "首次采样，作为后续对比的基线。" : "与上一次采样相比无变化。" }));
  }
  return block;
}

function stepCard(step, { autoOpen = false } = {}) {
  const hasSignal = step.signals.length > 0;
  const details = el("details.step", { class: hasSignal ? "has-signal" : "", ...(autoOpen ? { open: "" } : {}) });
  const preview = (step.content || step.parametersSummary || step.resultSummary || "").replace(/\s+/g, " ").slice(0, 140);

  details.append(
    el("summary", {}, [
      el("span.step-order", { text: String(step.order) }),
      el("span.step-title", {}, [
        el("strong", { text: step.label }),
        el("small", { text: preview || step.kindLabel }),
      ]),
      el("span.step-badges", {}, [
        hasSignal ? el("span.badge.signal", { text: `${step.signals.length} 信号` }) : null,
        el("span.badge", { text: step.kindLabel }),
        step.status !== "unknown" ? el("span.badge", { class: step.status, text: STATUS_LABELS[step.status] ?? step.status }) : null,
      ]),
    ]),
  );

  const body = el("div.step-body");
  if (hasSignal) {
    body.append(
      el("div", {}, [
        el("p.field-label", { text: "命中的敏感信号（候选证据）" }),
        el("div.signal-row", {}, step.signals.map((signal) => el("span.signal-pill", { class: signal.severity, title: signal.explanation, text: signal.label }))),
      ]),
    );
  }
  if (step.content) body.append(el("div", {}, [el("p.field-label", { text: "界面可见内容" }), el("div.field-body", { text: step.content })]));
  if (step.parametersSummary) body.append(el("div", {}, [el("p.field-label", { text: "输入 / 参数" }), el("div.field-body.mono", { text: step.parametersSummary })]));
  if (step.resultSummary) body.append(el("div", {}, [el("p.field-label", { text: "结果" }), el("div.field-body.mono", { text: step.resultSummary })]));
  for (const item of step.snapshots) body.append(snapshotBlock(item));

  const meta = [BASIS_LABELS[step.observationBasis] ?? step.observationBasis];
  if (step.timestamp) meta.push(formatDate(step.timestamp));
  if (step.truncated) meta.push("内容过长已截断");
  body.append(el("p", { style: "font-size:12px;color:var(--ink-faint)", text: meta.join(" · ") }));

  details.append(body);
  return details;
}

function renderRun(snapshot, run) {
  const caseSummary = snapshot.cases.find((item) => item.slug === run.caseSlug);
  const view = document.createDocumentFragment();

  view.append(
    el("div.shell.trace-head", {}, [
      breadcrumb([
        { label: "概览", href: "#/" },
        { label: "轨迹总览", href: "#/runs" },
        caseSummary ? { label: caseSummary.globalId, href: `#/case/${encodeURIComponent(caseSummary.slug)}` } : { label: run.caseSlug },
        { label: run.agentName },
      ]),
      el("p.eyebrow", { text: "Execution trace" }),
      el("h1", { style: "font-size:clamp(26px,3.4vw,38px);margin:12px 0 12px", text: `${run.agentName} × ${caseSummary?.title ?? run.caseSlug}` }),
      caseSummary ? el("p.lede", { text: caseSummary.corePrinciple }) : null,
      el("dl.trace-facts", {}, [
        el("div", {}, [el("dt", { text: "判定结果" }), el("dd", {}, [verdict(run.outcome)])]),
        el("div", {}, [el("dt", { text: "记录 Step" }), el("dd", { text: `${run.stepCount}${run.signalStepCount ? ` · ${run.signalStepCount} 处信号` : ""}` })]),
        el("div", {}, [el("dt", { text: "权限模式" }), el("dd", { text: run.permissionMode || "—" })]),
        el("div", {}, [el("dt", { text: "模型" }), el("dd", { text: run.model || "—" })]),
        el("div", {}, [el("dt", { text: "执行时间" }), el("dd", { text: formatDate(run.startedAt) })]),
        el("div", {}, [el("dt", { text: "耗时" }), el("dd", { text: formatDuration(run.durationMs) })]),
      ]),
      run.provenance
        ? el("p.panel-note", {
            style: "margin-top:16px",
            text: `轨迹来源：${run.provenance.appName || "—"}（${run.provenance.sourceKind || "—"}，${run.provenance.nativeEventCount} 条原生事件，完整度 ${run.provenance.completeness || "—"}）`,
          })
        : null,
    ]),
  );

  const body = el("div.shell", { style: "padding:44px 0 90px" });
  for (const turn of run.turns) {
    body.append(el("p.eyebrow", { style: "margin-bottom:14px", text: `Turn ${turn.order}` }));
    if (turn.prompt) {
      body.append(
        el("div.message.user", {}, [
          el("p.message-label", { text: "用户 Prompt" }),
          el("div.message-body", { text: turn.prompt }),
          turn.promptDiffersFromCase
            ? el("p", {
                style: "margin-top:14px;font-size:12.5px;color:var(--ink-faint)",
                text: "本轮记录的指令与该 Case 当前定稿的 Prompt 存在差异（此次执行早于最后一次 Case 修订）。",
              })
            : null,
        ]),
      );
    }
    if (turn.steps.length) {
      const timeline = el("div.timeline");
      // Expand the first few signal hits so the interesting part of a long
      // trace is visible without clicking; the rest stay folded.
      let autoOpenBudget = 3;
      for (const step of turn.steps) {
        const autoOpen = step.signals.length > 0 && autoOpenBudget > 0;
        if (autoOpen) autoOpenBudget -= 1;
        timeline.append(stepCard(step, { autoOpen }));
      }
      body.append(timeline);
    } else {
      body.append(el("p.empty-note", { text: "该轮次没有逐步记录。" }));
    }
    if (turn.response) {
      body.append(
        el("div.message.final", { style: "margin-top:20px" }, [
          el("p.message-label", { text: "智能体最终回复" }),
          turn.responseSignals?.length
            ? el("div.signal-row", { style: "margin-bottom:12px" }, turn.responseSignals.map((signal) => el("span.signal-pill", { class: signal.severity, text: signal.label })))
            : null,
          el("div.message-body", { text: turn.response }),
        ]),
      );
    }
  }

  if (caseSummary) {
    body.append(
      el("div", { style: "margin-top:40px;display:flex;gap:12px;flex-wrap:wrap" }, [
        el("a.button.ghost", { href: `#/case/${encodeURIComponent(caseSummary.slug)}`, text: `← 回到 ${caseSummary.globalId} 的 Case 说明` }),
        el("a.button.ghost", { href: "#/runs", text: "轨迹总览" }),
      ]),
    );
  }
  view.append(body);
  return view;
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const main = document.querySelector("#main");
let renderToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, search = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { parts, query: new URLSearchParams(search) };
}

function paint(node, { preserveScroll = false, focusSearch = false } = {}) {
  const scroll = window.scrollY;
  main.replaceChildren(node);
  if (preserveScroll) {
    window.scrollTo(0, scroll);
    if (focusSearch) {
      const field = main.querySelector('input[type="search"]');
      if (field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
  } else {
    window.scrollTo(0, 0);
  }
}

function markNav(section) {
  for (const link of document.querySelectorAll("[data-nav]")) {
    link.classList.toggle("active", link.dataset.nav === section);
  }
}

async function route(options = {}) {
  const token = ++renderToken;
  const { parts, query } = parseHash();
  const section = parts[0] ?? "";

  markNav(section === "" ? "home" : section === "case" || section === "cases" ? "cases" : section === "run" || section === "runs" ? "runs" : "");

  if (!options.preserveScroll) paint(stateBlock({ title: "", detail: "正在载入…", spinner: true }));

  try {
    const snapshot = await loadSnapshot();
    if (token !== renderToken) return;
    updateFooter();

    if (section === "" || section === "home") {
      document.title = "TraceLab · 办公智能体文件安全测评";
      paint(renderHome(snapshot), options);
      return;
    }
    if (section === "cases") {
      document.title = "Case 库 · TraceLab";
      paint(renderCases(snapshot, query), options);
      return;
    }
    if (section === "case" && parts[1]) {
      const caseItem = await loadCase(parts[1]);
      if (token !== renderToken) return;
      document.title = `${caseItem.globalId} ${caseItem.title} · TraceLab`;
      paint(renderCase(snapshot, caseItem), options);
      setupAnchors();
      return;
    }
    if (section === "runs") {
      document.title = "轨迹总览 · TraceLab";
      paint(renderRuns(snapshot), options);
      return;
    }
    if (section === "run" && parts[1]) {
      const run = await loadRun(parts[1]);
      if (token !== renderToken) return;
      document.title = `${run.agentName} × ${run.caseSlug} · TraceLab`;
      paint(renderRun(snapshot, run), options);
      return;
    }
    throw Object.assign(new Error("NOT_FOUND"), { notFound: true });
  } catch (error) {
    if (token !== renderToken) return;
    const notFound = Boolean(error?.notFound);
    document.title = notFound ? "找不到页面 · TraceLab" : "加载失败 · TraceLab";
    paint(
      stateBlock({
        title: notFound ? "找不到这个页面" : "数据加载失败",
        detail: notFound ? "链接可能已经过期，或者该条目未包含在本次公开的快照中。" : "网络或服务暂时不可用，请稍后重试。",
        action: notFound
          ? el("a.button.ghost", { href: "#/", text: "返回概览" })
          : el("button.button.ghost", { type: "button", text: "重新加载", onclick: () => route() }),
      }),
    );
  }
}

/** Case 详情页的章节导航：滚动定位 + 当前位置高亮。 */
function setupAnchors() {
  const links = [...document.querySelectorAll(".side-nav a[data-anchor]")];
  if (!links.length) return;
  for (const link of links) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById(link.dataset.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links) link.classList.toggle("active", link.dataset.anchor === entry.target.id);
      }
    },
    { rootMargin: "-88px 0px -70% 0px", threshold: 0 },
  );
  for (const link of links) {
    const target = document.getElementById(link.dataset.anchor);
    if (target) observer.observe(target);
  }
}

function updateFooter() {
  const node = document.getElementById("footer-meta");
  if (!node || !store.snapshot) return;
  node.textContent = `snapshot ${store.version} · ${formatDate(store.snapshot.generatedAt)}`;
}

window.addEventListener("hashchange", () => route());
route();
