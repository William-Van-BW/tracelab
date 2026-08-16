# TraceLab 前端工作台

[English](README.md) · **中文**

TraceLab 是本项目的本地前端，用于 Case 管理、人工录入 Agent 轨迹、证据采集和测评结果复核。

## 为什么 PowerShell 找不到 `pnpm` / `npm`

这通常不是项目故障，而是当前 PowerShell 的 `PATH` 没有配置 Node.js 和包管理器。项目要求 Node.js `>=22.13.0`，并使用 pnpm；如果系统没有安装 Node.js，或者安装目录没有加入 PATH，直接运行 `pnpm` 和 `npm` 都会出现“无法将其识别为 cmdlet”的提示。

## 推荐启动方式（正常安装 Node.js）

先安装 Node.js 22 LTS，并重新打开 PowerShell。clone 项目后，进入 `web` 目录执行：

```powershell
git clone git@github.com:William-Van-BW/tracelab.git
cd .\tracelab\apps\workbench
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm dev
```

启动后访问 <http://localhost:3000>。

也可以直接使用项目自带的启动脚本。它会优先使用系统 pnpm；如果系统没有 pnpm，则自动尝试 Codex 内置运行时：

```powershell
cd .\apps\workbench
.\start-local.ps1
```

如果 PowerShell 提示“在此系统上禁止运行脚本”，可以使用不受当前脚本策略影响的入口：

```powershell
.\start-local.cmd
```

或者只对当前 PowerShell 进程临时放行后再执行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\start-local.ps1
```

上述方式不会修改系统级执行策略。

如需换端口：

```powershell
.\start-local.ps1 -Port 3001
```

可以先确认命令是否已经可用：

```powershell
node --version
pnpm --version
npm --version
```

如果 `node` 也找不到，请重新安装 Node.js，并在安装程序中启用“Add to PATH”，然后重开 PowerShell。

## 无法使用系统 Node.js 时

`start-local.ps1` 会优先使用系统 pnpm；如果你的 Codex 环境提供了内置运行时，它也会尝试自动发现。内置运行时的位置由本机安装决定，不能作为项目的固定路径写入文档。

## 常用命令

```powershell
pnpm dev          # 启动开发服务器
pnpm build        # 生产构建
pnpm test         # 执行当前构建验证
pnpm lint         # ESLint 检查
pnpm sync:cases   # 按工作台配置扫描 Case Library 并生成前端 Case 索引
pnpm validate:workbench # 验证排序、具体设计说明、Fork 谱系、默认目录与敏感信号
pnpm db:generate  # 生成 D1 migration
```

启动和构建时会自动读取 `../case-library/aetf-workbench.json`。默认 Case Library 是该配置文件所在目录，也可以在前端右上角“工作台设置”中修改；保存后重启前端即可重新同步 Case。

统一的 Case 生命周期入口位于 Case Library 根目录：

```powershell
.\Initialize-Case.ps1 -CaseId <case-id>
.\Initialize-Case.ps1 -CaseId <case-id> -Version 1.0.1
.\Destroy-Case.ps1 -DeploymentPath <deployment-path>
```

Case Library 的物理目录与界面一致：`安全体系大类 / 安全风险小类 / case-NNN / vX.Y.Z`。省略 `-Version` 时初始化入口优先使用 `case-lineage.json` 中的当前默认版。

前端 Run 页面提供同样的“初始化 Case”和“销毁 Case”按钮。生成目录默认位于 `%USERPROFILE%\AgentRuns`，配置与服务端都会拒绝包含 `test` 或 `bench` 的工作目录片段。

每个 Turn 顶部提供目录采样、准确窗口截取和截屏上传入口。目录默认值直接来自 Case.json，可像自定义目录一样启用、停用或删除；每次采样都保存目录的完整绝对快照，并以该 Run 中最早的一次快照为稳定基线生成累计 Diff（删除任意后续快照都不会影响基线）。采集动作都作为当前 Turn 时间线中的 Evidence Step 保存。

Run 与 Turn、Step 均支持“多选”批量删除；手工录入与手工判定的 Run 列表按 Case 分组折叠（组头显示安全体系大类 · 安全风险小类），便于在上百个 Run 中定位。

Case 管理按“大类 → 小类 → Case 家族 → 版本”组织，版本谱系以父子关系渲染为树，同一父版本可 Fork 出多条并行分支（例如一条改 Prompt、一条改文件），互不覆盖。版本生命周期为“工作版 → 候选版 →（设为）当前默认版 / 归档”；这些操作都不会删除其它分支或改写历史 Run，只有没有 Run 的工作版可以移入可恢复目录。详见 [Case 版本与 Fork 管理](./docs/case-versioning.md)。

## 中文使用说明

### 一次完整测评怎么做

1. 启动前端后，先在右上角“设置”确认 **Case 库路径** 和 **生成工作目录**。保存设置后必须重启前端，Case 索引才会按新路径生成。
2. 打开“Case 管理”，按 Case 家族选择当前定版或某个历史版本。先阅读 Prompt 边界、诱导文件与形式、违规路径和正确路径；版本谱系会显示每个 Fork 的状态和所属 Run。
3. 选择录入方式：已有 Agent 本地对话记录时，使用右上角“导入 Agent 日志”；只能观察 Agent 界面、或需要边执行边记录时，使用“新建 Run”并在“手工录入”中补录。
4. 若 Case 有 fixture，在 Run 顶部点击“初始化”。确认页面显示实际工作目录后再让 Agent 执行；不要在同一 Run 中重复初始化。执行完成且证据已采集后点击“销毁”。
5. 每个 Turn 结束后，在 Turn 顶部按需使用“采样目录”“选择窗口截屏”或“上传截屏”。首次目录采样会按 Case.json 自动初始化默认目录；后续采样以最早一次快照为基线生成累计 Diff。Trae 等界面思考请用“思考 / 状态”类型的 Step 手工粘贴（见下文“可见思考”说明）。
6. 自动导入的 Step 默认折叠，逐条展开后复核 Thinking、工具调用、命令和结果；必要时补充备注、截图或目录快照。Step 右下角可拖动调整大小。
7. 全部 Turn 完成后，在“测评结果”填写总体结论并保存判定。`completed` 只代表录入完成，不代表测评通过。

### 何时用自动导入，何时用手工录入

| 情况 | 建议 |
|---|---|
| Agent 的本地日志能找到，且希望批量还原长对话、Thinking 与工具调用 | 使用“导入 Agent 日志” |
| 只看得到桌面 UI，或日志不完整/提示为降级源 | 用自动导入生成基础轨迹，再在“手工录入”补证据和修正；必要时完全手工新建 Run |
| 需要执行一个尚未开始的新 Case | “新建 Run”→“初始化”→执行→逐 Turn 补录 |
| 要再次读取同一原生会话的新日志 | 重新扫描后再次导入同一会话；它会更新同一个 Run，不会额外创建副本 |

## 自动导入 Agent 日志

前端右上角“导入 Agent 日志”会扫描七个模块化适配器，并把选中的原生会话自动归并为 Run、Turn 和 Step。对话打开时默认选中当前 Run 所属 Agent 的模块，无需再点一次；一个 Agent 有多个模块时按 `PREFERRED_LOG_ADAPTER_BY_AGENT` 指定首选（Qoder 首选国内版）：

- ChatGPT / Codex：Codex rollout JSONL；另支持 ChatGPT `conversations.json` 导出。
- Claude Desktop：优先读取 `conversations.json` 导出；没有导出时使用诊断日志生成降级观察记录。
- WorkBuddy：项目会话 JSONL。
- Trae：优先扫描持久 `ai-agent*_stdout.log`，按原生 session ID 恢复 Prompt、工具名称和完整工具结果；旧版 `session_memory` 仅作摘要降级源。
- Qoder（国际版）：`%APPDATA%\QoderWork\data\agents.db`，数据库不可用时降级到 `~\.qoderwork\projects` 的项目 JSONL。
- QoderWorkCN（国内版）：同一产品的国内构建，表结构与落盘形态一致，只是根目录换成 `%APPDATA%\QoderWork CN\data\agents.db` 与 `~\.qoderworkcn\projects`；与国际版共用 `agent_qoder` 这一个 Agent 档案。
- DuMate：`opencode.db`。

SQLite 适配器先复制数据库和 WAL 到临时只读快照，不直接修改 Agent 数据。导入记录保存原始来源、SHA-256、原生事件数、归并事件数、完整度和警告；工具调用与结果会按 call ID 合并，连续推理和诊断观察也会压缩，减少人工整理数量。

推理文本按候选字段的“首个非空文本”提取，避免 Qoder 等来源中空 `output` 遮蔽 `input.text`。Claude 优先读取真实项目 JSONL 中的 thinking、assistant、tool_use 与 tool_result，诊断日志只作为会话发现线索。

**Trae 可见思考：** 经核查，Trae 新版并未把界面中的思考正文持久化到磁盘（`~/.trae-cn` 只有生成物与配置；`TRAE SOLO CN` 的 `ai-agent` stdout 日志只记录首个思考 token 作为延迟埋点，没有完整思考流）。因此 Trae 日志导入仅能恢复 Prompt 与工具调用/结果，明确标为 `partial`；界面上看到的思考正文需要在对应 Turn 手工新增一个“思考 / 状态”Step 粘贴。此前依赖窗口截图 + OCR 的“捕获 Trae 思考”按钮已移除。

默认按首轮 Prompt 自动匹配 Case；匹配失败时界面会要求手动选择，不会静默写入错误 Case。同一 Agent 原生会话使用稳定 Run ID，重复导入会更新已有记录。

### 一个 Agent 有很多日志时，如何选对正确对话

导入对话框不是随机挑选文件，而是先按 Agent 分组、再按会话的**最后更新时间倒序**列出。推荐按下面的顺序确认：

1. 在右上角点击“导入 Agent 日志”，等待扫描完成；先点击正确的 Agent 卡片。卡片上的数字是发现的会话数；“完整源”表示可以读取原生日志，“降级源”表示只拿到了摘要或诊断信息。
2. 在“会话”下拉框中，从最接近实际执行时间的一项开始看。每一项显示“会话标题 · 最后更新时间”；标题可能是 Agent 自动生成的通用名称，**不要只凭标题判断**。
3. 选中一项后，核对下方预览中的来源类型、完整度、原始路径、文件大小（或“数据库会话”）和原生会话 ID。项目路径、工作区目录或文件名通常最能区分同一时间附近的对话；Qoder、DuMate 等数据库来源尤其应以会话 ID 和时间为准。
4. “映射到 Case”若能明确判断，直接手动选本次 Case；不确定时可保留“根据首轮 Prompt 自动匹配”。自动匹配不到时不会写入数据，界面会要求手动选择。
5. 点击“提取、映射并保存 Run”后，页面会跳到“手工录入”。立即检查第一轮的“用户 Prompt”、Agent/Case、来源路径和 Turn 数是否与实际任务一致；这一步是最终确认。若不能确认候选会话，请先关闭对话框并到 Agent 应用中核对执行时间或会话标题，不要把猜测的日志写入测评库。

选择时的快速判断表：

| 线索 | 可信度 | 使用方式 |
|---|---|---|
| 最后更新时间 | 高 | 与实际开始/结束时间相符时优先选择 |
| 原始路径中的项目或工作区名称 | 高 | 同一 Agent 多项目并行时最有效 |
| 原生会话 ID | 高 | 用于回到 Agent 数据库或日志文件交叉核对 |
| 会话标题 | 中 | 仅作为辅助；不少 Agent 会生成“新对话”等通用标题 |
| 文件大小 | 低到中 | 长任务通常较大，但压缩、摘要或 SQLite 会影响此线索 |
| 完整度/警告 | 必看 | `full` 优先；`summary`、`partial`、`unknown` 只能作为近似记录使用 |

“重新扫描”适用于 Agent 仍在继续写日志、刚结束对话，或你新放入 Claude `conversations.json` 导出文件的情况。扫描和提取只读原始日志；SQLite 适配器会先建立临时只读快照，不会修改 Agent 的数据库。

当前前端会保留每次成功导入的 Run，尚未提供“删除 Run”按钮。因此，无法确认来源的候选会话应先在 Agent 应用中核对，不建议为了试错而连续导入多个候选。若同一原生会话后来有新内容，直接再次导入即可更新原 Run。

每张 Step 卡片右下角都可拖动调整大小：宽度限制在 360px（窄屏自动采用容器宽）到当前容器宽，高度限制在 150–760px。尺寸按 Run/Turn/Step 保存在浏览器本地；双击拖动柄或聚焦后按 Esc 可恢复默认大小，方向键可微调。

## 如果 3000 端口已被占用

```powershell
pnpm dev -- --hostname 0.0.0.0 --port 3001
```

然后访问 <http://localhost:3001>。

## 数据位置

- Case、Agent、Run 等结构化记录：本地 Cloudflare D1 开发存储。
- 截图和目录快照：本地 R2 开发存储。
- 绑定配置：`hosting.json`（只写 D1 / R2 的 binding 名）。
