# 轨迹录入

[English](../en/04-recording-traces.md) · **中文**

轨迹是整套方法的产出物。判定可以被质疑、可以被推翻，但只有轨迹完整，质疑才有依据。

## 两条录入路径

| 路径 | 适用 | 得到什么 |
| --- | --- | --- |
| **自动导入** | Agent 在本机留下了会话日志 | 完整的 Prompt、Thinking、工具调用与结果，逐条可复核 |
| **手工录入** | 只看得到界面，或日志是降级源 | 操作者观察到的语义 Step，来源与确定性如实标注 |

多数正式测评是两者结合：先自动导入生成骨架，再手工补上界面里才有的证据。

## 自动导入

工作台右上角“导入 Agent 日志”会扫描七个模块化适配器：

| Agent | 日志来源 | 说明 |
| --- | --- | --- |
| ChatGPT / Codex | Codex rollout JSONL；ChatGPT `conversations.json` 导出 | 完整源 |
| Claude Desktop | `conversations.json` 导出优先；否则用诊断日志 | 有导出时完整，否则降级 |
| WorkBuddy | 项目会话 JSONL | 完整源 |
| Trae | 持久 `ai-agent*_stdout.log`，按原生 session ID 恢复 | **partial**：思考正文不落盘 |
| Qoder（国际版） | `%APPDATA%\QoderWork\data\agents.db` | 完整源，降级到项目 JSONL |
| QoderWorkCN（国内版） | 同一产品的国内构建，根目录不同 | 与国际版共用一个 Agent 档案 |
| DuMate | `opencode.db` | 完整源 |

SQLite 适配器会先把数据库和 WAL 复制成临时只读快照——**不会修改 Agent 自己的数据**。

每次导入都记录：原始来源路径、SHA-256、原生事件数、归并后事件数、完整度、警告。
工具调用与结果按 call ID 合并，连续推理会被压缩，减少人工整理量。

### 选对会话

会话按 Agent 分组、按最后更新时间倒序。**不要只看标题**——很多 Agent 只会生成
“新对话”。可靠性排序：

1. 最后更新时间（与实际执行时间相符）
2. 原始路径里的项目 / 工作区名
3. 原生会话 ID（可回到 Agent 数据库交叉核对）
4. 完整度标记：`full` 优先；`summary` / `partial` / `unknown` 只能作近似记录

保存后页面会跳到手工录入。**立即核对第一轮的 Prompt、Agent、Case 和 Turn 数**——这是
最后一道确认。核对不上就不要把它写进测评库，先回 Agent 应用里查清楚。

同一原生会话使用稳定 Run ID：重复导入会更新同一个 Run，不会产生副本。

## 手工录入

按语义动作建 Step，每个 Step 如实标注：

- **`kind`** —— `reasoning`、`tool_or_action`、`command_execution`、`skill_load`、
  `skill_call`、`mcp_discovery`、`web_search`、`browser_action`、`approval`、
  `file_operation`、`observation`、`assistant_response`，或自定义类型。
- **`observation_basis`** —— 这条记录的证据来自哪：`native_protocol`、`agent_ui`、
  `system_ui`、`operator_inference`、`imported_log`、`unknown`。
- **`certainty`** —— `exact` / `approximate` / `inferred` / `unknown`。
- **`operator_note`** —— 一切影响解读的限制，例如“只看到 UI 摘要，工具参数不可得”。

**最容易犯的错是把界面摘要记成协议事实。** 界面写着“获取 MCP 工具”，不代表底层真的
发生了一次标准 MCP 调用。这种情况用 `tool_or_action` + `agent_ui` + `approximate`，
不要伪造精确参数。这不是记录得潦草，而是记录得诚实——事后能分清哪些结论建立在
可靠证据上。

## 证据 Step

目录采样、截图、上传都会作为当前 Turn 的 Evidence Step 落进轨迹。

目录快照保存的是**完整绝对快照**；本 Run 中最早的一次作为稳定基线，之后每次采样都
生成相对基线的累计 Diff。删掉任何后续快照都不会移动基线。

**采集失败也要记。** 写成 Step 并说明原因（权限不足、目录已被销毁、截图工具报错）。
静默省略会让后来的人误以为当时一切正常。

## 校验

```bash
python tools/validate_run.py <run-directory>
```

检查结构、交叉引用；装了 `jsonschema` 时按 [AETF Schema](../../spec/agent-eval-trace.schema.json)
逐份文档校验。`spec/examples/example-run/` 是一个完整合法的样例，
`spec/templates/manual-run-template/` 是空白模板。
