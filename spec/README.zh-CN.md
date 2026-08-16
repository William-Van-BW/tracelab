# AETF — Agent 安全测评轨迹格式

[English](README.md) · **中文**

一套用于记录智能体在安全测评中**实际做了什么**的文件格式，详尽到足以让第三方复核结论。

当前版本 **v0.3.5**。规范正文见 [`aetf-spec.zh-CN.md`](aetf-spec.zh-CN.md)；本页是同一
模型的导读。规范正文与 [`agent-eval-trace.schema.json`](agent-eval-trace.schema.json)
是权威依据。

## 它解决什么问题

主流桌面智能体多为闭源：拿不到工具协议，很多时候唯一的证据就是界面显示了什么。
面向这种场景的轨迹格式，不仅要记录**发生了什么**，还要记录**你对它有多确定**——
否则从截图推测出来的东西，和协议层的事实，在数据里长得一模一样。

因此 AETF 给每个 Step 附带来源信息：

| 字段 | 回答什么 |
| --- | --- |
| `observation_basis` | `native_protocol` / `agent_ui` / `system_ui` / `operator_inference` / `imported_log` / `unknown` |
| `certainty` | `exact` / `approximate` / `inferred` / `unknown` |
| `step_kind_source` | `builtin` / `operator_custom` / `imported` / `derived` / `unknown` |
| `operator_note` | 自由备注，例如“只看到 UI 摘要，工具参数不可得” |

操作者看到界面写着“获取 MCP 工具”，应记为 `agent_ui` + `approximate`，而不是伪造一次
标准协议调用。

## 四个层级

```text
run     一次测评：一个 Agent session、一个 Case、一次 attempt
└── turn      一次用户输入，到 Agent 给出本轮反馈并等待下一次输入
    └── step        一个语义动作：一次思考、一次工具调用、一次观察、一次回复
        └── event         Step 内按时间追加的事实——落盘的最小单元
```

刻意不设第五层 `span`：一次工具调用就是一个 Step，它的 `step.started`、
`tool.call.requested`、`approval.requested`、`approval.decided`、
`tool.call.completed`、`step.ended` 共用一个 `step_id`，由 `span_id` 配对请求与结果。

以 event 而非 step 落盘，是因为“等 Step 结束再整行写入”会在进程崩溃时丢掉最关键的那
一条事实：工具已请求、但从未返回。

## 运行包结构

```text
<run-id>/
├── manifest.json          格式版本、Run 身份、完整性
├── config.json            Agent、模型、权限模式、采集根绑定
├── case.json              运行时刻的 Case 副本
├── trajectory.jsonl       事件日志，每行一个 JSON 对象
├── artifacts/             截图、HAR、DOM、原始工具输出
├── fs/snapshots/          完整目录快照
├── fs/changes/            快照之间计算出的变化集
└── evaluations/           每条 assertion 的判定结果
```

小型结构化结果内联在事件 `payload` 里；大的写进 `artifacts/` 或 `fs/` 并按 id 关联。
**采集失败同样要写成事件**，附上错误说明，绝不静默省略。

## 预期路径与判定

Case 不规定唯一正确剧本，而是声明：

- `turn.expected_steps[]`：可能出现的语义步骤；用于引导，不直接判定。
- `turn.acceptable_paths[]`：由这些步骤组成的允许路径。“Agent 拒绝执行”和
  “Agent 请求审批后被拒绝”可以各自成为一条允许路径。
- `turn.assertions[]`：本轮可判定的安全要求。
- `run_assertions[]`：跨轮次的要求，例如“整个会话不得泄漏 canary”。

未命中任何声明路径的真实行为记为 `path_match: unmatched`，照样纳入评估。Case 设计
不完整，不能成为丢弃证据的理由。

## 监控是白名单

`case.monitored_resources.filesystem_roots` 只列出本次测试监控的目录，机器上其余部分
一律视为**未监控**；“被监控目录没有变化”永远不能表述为“整台机器没有变化”。

## 校验运行包

```bash
python tools/validate_run.py spec/examples/example-run
```

校验器检查结构与交叉引用；装了 `jsonschema` 时还会用 JSON Schema 校验每份文档。

## 目录内容

| 路径 | 内容 |
| --- | --- |
| `agent-eval-trace.schema.json` | 全部文档类型的 JSON Schema（2020-12） |
| `aetf-spec.zh-CN.md` | 规范正文与完整字段字典 |
| `examples/example-run/` | 一个完整、合法的运行包 |
| `templates/manual-run-template/` | 供人工录入的空白运行包 |
