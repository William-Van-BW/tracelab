# Contributing · 参与贡献

[English](#english) · [中文](#中文)

## English

Most valuable contributions fall into four kinds:

1. **New Cases** — a file-safety failure mode the corpus does not cover yet.
2. **Agent log adapters** — support for another desktop agent's local logs.
3. **Recorded runs** — results for an agent or version not yet covered.
4. **Translation** — keeping the English documentation in sync with the Chinese.

### Before you start

Read [SECURITY.md](SECURITY.md). This repository is a corpus of working lures;
they are only ever deployed on an isolated test machine.

### New Cases

Follow [docs/en/02-authoring-cases.md](docs/en/02-authoring-cases.md). The
essentials:

- The office task must be real and completable. A Case where refusing is the
  only safe move measures caution, not judgement.
- Lures read like real office material, never like instructions to a machine.
- All fixture data is synthetic; protected material carries a canary.
- No machine-specific paths or addresses — use the placeholder tokens.
- One risk per Case.

Then run, from `apps/workbench/`:

```bash
node ../../tools/refresh-fixture-hashes.mjs
pnpm validate:cases
pnpm sync:cases && pnpm validate:workbench
```

### Log adapters

Adapters live in `apps/workbench/build/agent-log-import/adapters/`. An adapter
discovers sessions, extracts one, and normalises it into Turns and Steps. Two
rules are absolute:

- **Never write to the agent's own data.** Copy a SQLite database and its WAL to
  a temporary read-only snapshot first, as the existing adapters do.
- **Never overstate provenance.** If the log only carries a summary, mark the
  extraction `partial` or `summary` and say so in the warnings. Trae is the
  reference case: its thinking text is not on disk, so the adapter reports
  `partial` rather than pretending otherwise.

### Recorded runs

Runs contain real paths from your machine. Contribute them through the redacted
snapshot (`apps/showcase/scripts/build-data.mjs`), never as raw run directories,
and confirm `node tools/scan-leaks.mjs .` passes.

### What CI checks

Every pull request runs: the AETF schema over every `case.json`; the workbench
model validators; the showcase data check; and the leak scanner. A red leak
scan is never merged — it means operator- or site-specific data is about to
become public.

### Commit messages

Conventional Commits, with the Case ID in the scope where one applies:

```text
feat(OA-11): add symlink-chain traversal Case
fix(showcase): keep the coverage note in sync with the matrix legend
docs(en): translate the publishing guide
```

---

## 中文

最有价值的贡献通常是四类：

1. **新 Case** —— 语料还没覆盖到的文件安全失效模式。
2. **Agent 日志适配器** —— 支持另一款桌面智能体的本地日志。
3. **测评轨迹** —— 尚未覆盖的 Agent 或版本的执行结果。
4. **翻译** —— 让英文文档跟上中文。

### 动手之前

请先读 [SECURITY.md](SECURITY.md)。这个仓库是一批真实有效的诱饵，只应部署在隔离
测试机上。

### 新 Case

按 [docs/zh/02-authoring-cases.md](docs/zh/02-authoring-cases.md) 写。要点：

- 办公任务必须真实、可完成。只有拒绝才安全的 Case，测的是保守程度不是判断力。
- 诱饵写得像真的办公材料，不要写成给机器看的指令。
- 夹具数据全部合成；受保护材料里放 canary。
- 不写本机路径与地址，一律用占位符。
- 一个 Case 一个风险。

然后在 `apps/workbench/` 下运行：

```bash
node ../../tools/refresh-fixture-hashes.mjs
pnpm validate:cases
pnpm sync:cases && pnpm validate:workbench
```

### 日志适配器

适配器在 `apps/workbench/build/agent-log-import/adapters/`。一个适配器负责发现会话、
提取会话、归并成 Turn 与 Step。两条铁律：

- **绝不写 Agent 自己的数据。** SQLite 要先把数据库和 WAL 复制成临时只读快照，
  照现有适配器的做法。
- **绝不夸大来源。** 日志里只有摘要，就把提取结果标成 `partial` 或 `summary` 并写进
  警告。Trae 是参照：它的思考正文不落盘，适配器就如实标 `partial`。

### 测评轨迹

Run 里有你机器上的真实路径。请通过脱敏快照（`apps/showcase/scripts/build-data.mjs`）
贡献，不要直接提交原始 Run 目录，并确认 `node tools/scan-leaks.mjs .` 通过。

### CI 会检查什么

每个 PR 都会跑：全部 `case.json` 的 AETF Schema 校验、工作台模型校验、展示站数据
校验、泄漏扫描。泄漏扫描红了绝不合并——那意味着本机或站点特征即将被公开。

### 提交信息

Conventional Commits，涉及具体 Case 时在 scope 里写 Case 号：

```text
feat(OA-11): add symlink-chain traversal Case
fix(showcase): keep the coverage note in sync with the matrix legend
docs(en): translate the publishing guide
```
