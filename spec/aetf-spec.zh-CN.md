# Agent 安全测评轨迹格式与人工测评工作台（AETF v0.3.5）

> AETF = Agent Evaluation Trace Format。本版首先服务于人工记录办公 Agent 的文件系统、浏览器、审批与沙箱测试，同时允许以后接入 API/CLI、桌面应用、虚拟机、Android、浏览器插件和自动评分器。

v0.3.0 在 v0.2 数据规范上增加了可运行的本地前后端 `web/`；v0.3.1 补充相邻目录快照比较；v0.3.2 增加授权范围与可复现 fixture；v0.3.3 增加统一 Case 生命周期和重点审查视图；v0.3.4 增加六个 Agent 的模块化日志自动导入；v0.3.5 修复推理文本非空回退并增加有边界、可持久化的 Step 卡片缩放。前端数据、截图、目录快照和导入的 Run 保存在本地开发存储中，不会自动上传到外部服务。

## 1. 本版的明确结论

### 1.1 逻辑层级与落盘单元

```text
run：一次测试、一个 Agent session、一个 case 的一次 attempt
└── turn：一次用户输入开始，到 Agent 给出本轮反馈并等待下一次输入
    └── step：本轮中的一个语义动作，如一次 thinking、一次工具调用、一次观察、一次回复
        └── event：step 内按时间追加的事实记录；它是 trajectory.jsonl 的最小落盘单元
```

这里特意不把 `span` 作为第五层：

- 一次工具调用是一个 `step`。
- 这个 step 可包含 `step.started`、`tool.call.requested`、`approval.requested`、`approval.decided`、`tool.call.completed`、`step.ended` 等多个 event。
- 这些 event 使用同一个 `step_id`，工具 request/result 再使用同一个 `span_id` 配对。
- `span_id` 只是技术关联标识，用于配对、计算耗时或导入厂商原生 trace；它不拥有独立的注释、总结或测试含义。
- 如果工具调用期间的审批只服务于该工具，审批 event 留在同一个工具 step；如果测试人员执行了独立的环境操作，才建立新的 step。

为什么 `trajectory.jsonl` 不以 step 为最小单元：如果等到工具结束后才整行写入 step，进程崩溃时会丢失“工具已请求但没有返回”的关键事实，也无法自然表达并发和持续观察。event 追加写能保留不完整操作；读取器再按 `run_id/turn_id/step_id` 聚合成层级视图。

### 1.2 case 中的“预期路径”与“判定要求”

v0.1 的 `steps`、`expected_policy` 和 `oracles` 已重构：

- `case.turns[]`：测试脚本中的预定轮次。
- `turn.expected_steps[]`：可能出现的语义步骤，用于引导操作者、关联实际 step 和安排观察；它本身不直接判定 pass/fail。
- `turn.acceptable_paths[]`：将 expected step 组合为一个或多个允许路径。例如“Agent 拒绝执行”和“Agent 请求审批后被拒绝”可分别是两条允许路径。
- `turn.assertions[]`：本 turn 的可判定安全要求，取代 `expected_policy + oracles`。
- `run_assertions[]`：跨 turn 的要求，例如“整个会话不得泄漏 canary”。
- `evaluation/*.json`：记录 assertion 的实际判定结果。

一个 turn 可以有任意多个 assertion；每个 assertion 可通过 `applies_to_path_ids` 只应用于特定路径。判定方法由 `evaluation.recommended_method` 声明为 `human | rule | llm | hybrid`，最终实际使用了什么则写进 evaluation 文件，不能只凭 case 的推荐值推断。

### 1.3 文件系统监控是白名单，不是全盘扫描

`case.monitored_resources.filesystem_roots` 只列出测试需要监控的目录，例如 Workspace、外部合成敏感目录、下载目录。case 使用变量化 `path_template` 保持跨机器复用；本次 run 在 `config.capture.root_bindings` 中将 root ID 绑定到实际原生路径。

未列出的系统盘区域默认是**未监控**，不能把“白名单目录没变化”表述为“整台机器没变化”。

### 1.4 所有实际监控都进入 trajectory

case 的 `observation_plan` 说明“何时、采什么”；真正发生的截图、文件快照、浏览器状态和系统采样均写成 trajectory event：

- 小型结构化结果直接放 event `payload`。
- 截图、视频、HAR、DOM、大型日志、原始工具输出等放 `artifacts/`，event 通过 `artifact_ref` 关联。
- 完整文件快照和变化集放 `fs/`，event 通过 `snapshot_id/change_set_id + manifest_path` 关联。
- 未采集成功也要写 event，并在 `capture.limitations` 或 payload 的 error/status 中说明。

### 1.5 run/turn/step 的人工注释与 LLM 总结

逻辑上每个 run、turn、step 都有：

```text
annotations: []
summaries: []
```

但它们不直接覆写到已经落盘的 started event 中。新增内容通过 `annotation.added` 或 `summary.generated` 事件追加，并在 `target.level` 指定 `run | turn | step | event`。读取器或未来前端把这些事件投影成对应层级的数组；没有相关事件时数组默认为空。

这样既允许运行后补注释，也保留作者、时间、版本和被替代关系。更正旧注释时新增一条并填写 `supersedes_annotation_id`，不修改历史。

### 1.6 闭源 Agent 的可扩展 step 类型

`step` 是“可被操作者单独描述、标注和复核的一个语义动作”，不应被限制为 thinking 和 tool call。v0.3 内置推荐类型包括：

`reasoning | tool_or_action | command_execution | skill_load | skill_call | mcp_discovery | web_search | browser_action | context_compaction | approval | file_operation | observation | assistant_response | custom`

Schema 的 `step_kind`/`expected_steps[].kind` 接受任意稳定的 snake_case 或带命名空间的类型，因此操作员可以增加 `vendor_specific_action`、`com.vendor.foo` 等类别。不要因为界面写着“获取 MCP 工具”就武断认定底层一定发生了标准 MCP 调用；同时记录以下字段：

- `step_kind_source`：`builtin | operator_custom | imported | derived | unknown`，说明类别从何而来。
- `step_label` / `custom_kind_label`：保留 Agent UI 展示的原始名称或人工名称。
- `observation_basis`：`native_protocol | agent_ui | system_ui | operator_inference | imported_log | unknown`，说明证据来源。
- `certainty`：`exact | approximate | inferred | unknown`，说明参数、结果和行为的确定程度。
- `operator_note`：自由备注，例如“只看到 UI 摘要，工具名及参数 schema 不可得”。

工具调用、命令执行、Skill 加载/调用、上下文压缩都可各自成为 step。一次闭源 UI 行为若无法区分“工具调用”还是“直接命令”，优先用 `tool_or_action` 或自定义类别，配合 `certainty: unknown/approximate`，不要伪造精确参数。

### 1.7 非预期路径不是无效数据

Case 中的 `acceptable_paths` 只描述测试设计时已知的预期分支，不要求穷举 Agent 的实际行为。每个 `case.turns[]` 可配置：

- `allow_unexpected_steps`：默认 `true`，允许实际轨迹出现未列入 expected steps 的动作。
- `unexpected_path_policy`：默认 `record_and_evaluate`；还可取 `manual_review | fail | ignore`。

实际 turn 通过 `path_match = matched | partial | unmatched | not_evaluated` 和 `unexpected_path_summary` 记录匹配情况；实际 step 永远照常写入轨迹。`unmatched` 不自动等于安全失败，最终仍由 assertions 与 evaluation 判定。这样既能发现未知行为路径，也不会因为 Case 设计不完整而丢失证据。

## 2. 运行包目录

以下是 v0.3 定义的全部规范文件类型：

```text
runs/<run_id>/
├── manifest.json
├── config.json
├── case.json
├── trajectory.jsonl
├── fs/
│   ├── snapshots/<snapshot_id>.json
│   └── changes/<change_set_id>.json
├── artifacts/
│   └── sha256/<hash前2位>/<完整sha256>
└── evaluations/
    └── <evaluation_id>.json
```

`derived/` 可存前端缓存、HTML 报告或嵌套视图，但它不是规范数据源，其内部结构不属于 AETF。删除 derived 文件不得影响轨迹复核。除 `trajectory.jsonl` 外，规范 JSON 文件均为单个 JSON object；trajectory 每一非空行是一个 JSON object，不是 JSON 数组。

## 3. 必填、可选、未知和扩展的通用规则

- 下文“必填”指 Schema 要求存在；“可选”指没有适用信息时可省略。
- `null`：采集者确认该字段没有值，例如人工测试没有 random seed。
- `"unknown"`：概念适用，但当前不知道真实值。
- 字段缺失：此版本没有提供该信息，不能自动解释成 false、空或 unknown。
- 空数组：采集者明确表示当前没有条目，例如 `mcp_servers: []`。
- `extensions`：厂商或研究组扩展；键使用反向域名或稳定 URI，例如 `com.tencent.workbuddy`。读取器必须保留未知扩展。
- Schema 对很多 object 允许额外字段，这是为了兼容新平台；额外字段不得复用本文核心字段的名称或改变其语义。

## 4. 通用复合字段字典

### 4.1 `actor`

| 字段 | 要求 | 含义和取值 |
|---|---|---|
| `kind` | 必填 | `user` 用户；`agent` 被测 Agent；`tool` 工具；`environment` 文件系统/浏览器等环境；`operator` 测试操作者；`evaluator` 评分者；`system` Agent 或测试系统；`llm` 用于总结/评分的模型；`unknown`。 |
| `id` | 必填 | 本 run 内稳定标识，如 `subject`、`operator_01`。不要使用容易变化的显示名做关联。 |
| `display_name` | 可选 | 给人看的名称。 |
| `instance_id` | 可选 | 同一 actor 的具体进程、设备或实例 ID。 |
| `version` | 可选 | actor/采集器/模型版本。 |

### 4.2 `capture`

| 字段 | 要求 | 含义和取值 |
|---|---|---|
| `method` | 必填 | `native_api` 原生返回；`wrapper` 包装器截获；`os_audit` OS 审计；`ui_observation` 从界面观察；`manual` 人工录入；`imported` 外部导入；`derived` 由其他证据计算；`unknown`。 |
| `observer` | 可选 | 实际观察/录入者 ID。 |
| `collector_id` | 可选 | 对应 `config.capture.collectors[].collector_id`。 |
| `confidence` | 可选 | `high | medium | low | unknown`，表示该事实记录的可信度，不是 Agent 答案质量。 |
| `recorded_at` | 可选 | 记录进入日志的时间；可与事件实际发生时间不同。 |
| `limitations[]` | 可选 | 已知盲区，每项一条清晰描述。 |

### 4.3 `artifact_ref`

| 字段 | 要求 | 含义和取值 |
|---|---|---|
| `artifact_id` | 必填 | `sha256:<64位hex>`；校验 artifact 原始字节。 |
| `relative_path` | 可选但推荐 | 相对 run 根目录的路径。默认可由 hash 推导为 `artifacts/sha256/<前2位>/<完整hash>`。 |
| `media_type` | 可选但推荐 | MIME，如 `image/png`、`video/mp4`、`application/json`、`text/x-diff`。 |
| `size_bytes` | 可选但推荐 | artifact 的实际字节数。 |
| `role` | 可选 | `screenshot | screen_recording | tool_input | tool_output | stdout | stderr | file_before | file_after | diff | har | dom_snapshot | accessibility_tree | application_log | network_log | config_evidence | prompt | other`。 |
| `description` | 可选 | 给复核者看的证据说明，不能代替原件。 |
| `created_at` | 可选 | 证据对象产生时间。 |
| `slice.start_offset_ms/end_offset_ms` | 可选 | 引用视频或音频的时间片；单位毫秒。 |
| `slice.page` | 可选 | PDF/文档页码，从 1 开始。 |
| `slice.region` | 可选 | 截图裁剪区域，包含 `x/y/width/height`，坐标系应由相关 event payload 说明。 |
| `redaction.status` | 可选 | `none | redacted | encrypted | withheld | unknown`。 |
| `redaction.method/reason` | 可选 | 脱敏方法和原因。 |
| `redaction.source_artifact_id` | 可选 | 脱敏派生件对应的原件 ID；原件必须受访问控制。 |

### 4.4 `contentPart`

| 字段 | 要求 | 含义和取值 |
|---|---|---|
| `kind` | 必填 | `text | image | audio | video | file | structured | reference`。 |
| `text` | 条件必填 | 文本内容；kind=text 时使用。 |
| `data` | 条件可选 | 足够小的结构化 JSON 数据；不放二进制 base64。 |
| `artifact_ref` | 条件必填 | 图片、音视频、文件或大型结构化内容的引用。 |
| `media_type` | 可选 | 内容 MIME。 |
| `name` | 可选 | 附件文件名或内容名称。 |
| `redacted` | 可选 | 该 part 是否已脱敏。 |
| `language` | 可选 | BCP 47 语言标签，如 `zh-CN`。 |

### 4.5 `scopeRef`

| 字段 | 要求 | 含义和取值 |
|---|---|---|
| `level` | 必填 | `run | turn | step | event`。 |
| `run_id` | 必填 | 目标 run。 |
| `turn_id` | level=turn/step/event 时必需 | 目标实际 turn。 |
| `step_id` | level=step/event 时必需 | 目标实际 step。 |
| `event_id` | level=event 时必需 | 目标 event。 |

## 5. `manifest.json` 字段字典

manifest 是运行包入口和最终文件清单，不记录测试事实本身。

| 字段 | 要求 | 含义和取值 |
|---|---|---|
| `document_type` | 必填 | 固定 `manifest`。 |
| `format` | 必填 | 固定 `aetf-run-package`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；v0.3 reader 兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `run_id` | 必填 | 全局唯一 run ID；建议 UUIDv7 或 ULID 风格。 |
| `created_at` | 必填 | 创建运行包的 UTC ISO 8601 时间。 |
| `finalized_at` | 可选 | manifest 文件清单和 hash 最后封存时间。运行中不填。 |
| `status` | 必填 | `planned | in_progress | completed | aborted | crashed | invalid`。`completed` 只表示采集流程正常结束，不表示安全测试通过。 |
| `files[]` | 必填 | 包内规范文件和 artifact 的清单；运行中可以暂为空，封存后应完整。 |
| `files[].path` | 必填 | 使用 `/` 的 run 相对路径；不得逃逸 run 目录。 |
| `files[].media_type` | 必填 | 文件 MIME；JSONL 推荐 `application/x-ndjson`。 |
| `files[].size_bytes` | 可选但封存时必填 | 原始文件字节数。 |
| `files[].sha256` | 可选但封存时必填 | 原始文件字节 hash。manifest 自身通常排除。 |
| `files[].role` | 可选 | 如 `run_config`、`test_case`、`event_stream`、`fs_snapshot`、`fs_change_set`、`evaluation`、`artifact`。 |
| `integrity` | 可选 | 完整性算法、hash 范围、JSON hash 基础、可选签名或事件链说明。具体厂商字段允许扩展。 |
| `derived_from` | 可选 | 迁移/导入后的源包 ID、源 hash、迁移工具和版本；原包不应就地升级。 |
| `producer` | 可选 | 生成运行包的软件/人工流程名称、版本和 build。 |
| `extensions` | 可选 | 命名空间扩展。 |

## 6. `config.json` 字段字典

config 是**本次 run 的实际配置快照**；case 描述测试意图，两者不能合并。

### 6.1 顶层与测试标识

| 字段 | 要求 | 含义 |
|---|---|---|
| `document_type` | 必填 | 固定 `run_config`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `run_id` | 必填 | 与 manifest 和事件一致。 |
| `test.suite_id` | 必填 | 测试套件 ID。 |
| `test.case_id` | 必填 | 使用的 case ID。 |
| `test.case_version` | 可选但推荐 | case 内容版本；与 AETF 格式版本不是同一概念。 |
| `test.attempt` | 必填 | 同一 case 的第几次独立运行，从 1 开始。 |
| `test.operator_id` | 可选 | 主要操作者 ID。自动化无人值守时可省略。 |
| `test.random_seed` | 可选/可为 null | 可复现实验的随机种子；不使用时为 null。 |
| `test.mode` | 必填 | `manual | semi_automated | automated`。 |

### 6.2 `subject`

| 字段 | 要求 | 含义 |
|---|---|---|
| `name` | 必填 | 被测 Agent 产品/项目名。 |
| `vendor` | 可选 | 供应商或组织。 |
| `version` | 可选 | 产品版本或 commit。 |
| `build` | 可选 | 更细 build ID。 |
| `access_mode` | 必填 | `api | cli | desktop_ui | mobile_ui | browser_extension | mini_program | library | other`。 |
| `source_availability` | 可选 | `open | closed | partial | unknown`。 |
| `launch` | 可选 object | 启动方式、入口、参数、工作目录、VM/模拟器启动信息；秘密参数必须脱敏。 |
| `account` | 可选 object | 测试账号类别、订阅/额度类别、租户；不保存密码、Cookie、Token 原文。 |

### 6.3 `platform`

| 字段 | 要求 | 含义 |
|---|---|---|
| `os.family` | 必填 | `windows | linux | macos | android | ios | other`。 |
| `os.version/build/arch` | 可选 | OS 版本、build、CPU 架构。 |
| `virtualization` | 可选 object | VM、容器、模拟器、快照、镜像等。裸机可为空 object。 |
| `locale` | 可选 | UI/系统 locale。 |
| `timezone` | 可选 | IANA 时区，例如 `Asia/Shanghai`。事件仍优先记录 UTC。 |
| `device` | 可选 object | 设备型号、显示器、分辨率、DPI/缩放、输入设备等。 |

### 6.4 `model` 与 `settingObservation`

`model`、审批、sandbox、网络和文件访问策略均可使用同一种三层观察结构：

| 字段 | 要求 | 含义 |
|---|---|---|
| `requested` | 可选 | 测试想要的值。 |
| `declared` | 可选 | 产品设置页、配置文件或文档声称的值。 |
| `observed` | 可选 | 本 run 实际探测到的值。 |
| `verification.method` | 可选 | `settings_ui`、`config_file`、`probe_case`、`api_response` 等自定义稳定字符串。 |
| `verification.event_id` | 可选 | 支撑 observed 值的事件。 |
| `verification.artifact_ref` | 可选 | 设置页截图等证据。 |
| `verification.confidence` | 可选 | `high | medium | low | unknown`。 |

模型值本身建议包含 `provider/name/version/parameters`；未知模型不得根据 UI 文案猜测真实后端。

### 6.5 `capabilities`

| 字段 | 要求 | 含义 |
|---|---|---|
| `skills[]` | 必填 | 每项建议含 `id/name/version/enabled/source/config_hash`。 |
| `mcp_servers[]` | 必填 | 每项建议含 `id/name/version/enabled/transport/server_identity/tool_ids/config_hash`；凭据只记引用或 hash。 |
| `plugins[]` | 可选 | 非 MCP 插件/扩展，建议同样记录 ID、版本、启用状态。 |
| `tools[]` | 必填 | Agent 可用工具目录；建议含 `id/raw_name/category/enabled/visibility/version`。 |

数组为空表示明确没有启用；`unknown` 应写在具体字段而不是伪造空数组。

### 6.6 `security`

| 字段 | 要求 | 含义 |
|---|---|---|
| `approval` | 必填 | settingObservation；审批模式、默认决定、持久授权策略。 |
| `sandbox` | 必填 | settingObservation；容器/Workspace 隔离、提权能力、挂载等。 |
| `filesystem.workspace_root_id` | 必填 | 指向 case 监控根与 capture binding 中的 Workspace root ID。 |
| `filesystem.access_policy` | 必填 | settingObservation；Workspace/外部目录的预期、声明、实测读写能力。 |
| `filesystem.command_policy` | 可选 | settingObservation；命令 allow/deny/approval、shell、提权规则。 |
| `network` | 必填 | settingObservation；联网开关、代理、DNS、域名 allow/deny、下载策略。 |
| `environment_variables` | 可选 object | 注入策略、允许名称、值的 hash/脱敏方式；不得保存秘密原文。 |

### 6.7 `capture`

| 字段 | 要求 | 含义 |
|---|---|---|
| `mode` | 必填 | `manual | semi_automated | automated`。 |
| `storage_policy.inline_max_bytes` | 可选但推荐 | 小于该阈值的结构化文本可直接放 payload；仍受敏感策略约束。 |
| `storage_policy.hash_algorithm` | 可选 | v0.2 固定建议 `sha256`。 |
| `storage_policy.artifact_layout` | 可选 | v0.2 固定建议 `sha256/<prefix2>/<digest>`。 |
| `root_bindings[]` | 必填 | 将 case 的监控 root ID 绑定到本机实际目录。只能绑定 case 已声明的白名单根。 |
| `root_bindings[].root_id` | 必填 | 对应 `case.monitored_resources.filesystem_roots[].root_id`。 |
| `root_bindings[].native_path` | 必填 | 本机/设备实际路径。分享时可脱敏，但内部原包应可复核。 |
| `root_bindings[].path_flavor` | 必填 | `windows | posix | android | uri | virtual | unknown`。 |
| `root_bindings[].case_sensitive` | 可选 | 路径大小写是否敏感；不知道时写 `unknown`。 |
| `root_bindings[].follow_symlinks` | 可选 | 采集器是否跟随符号链接/重解析点。安全测试通常 false。 |
| `root_bindings[].resolved_from` | 可选 | 来源变量，如 `${WORKSPACE}`。 |
| `root_bindings[].verification` | 可选 | 操作者检查/自动探测的方法、时间、置信度。 |
| `collectors[]` | 必填 | 本 run 可用采集器。 |
| `collectors[].collector_id` | 必填 | 事件 `capture.collector_id` 引用的稳定 ID。 |
| `collectors[].kind` | 必填 | 如 `filesystem_snapshot`、`screenshot`、`browser_state`、`system_sample`。 |
| `collectors[].enabled` | 必填 | 本次是否启用。 |
| `collectors[].settings` | 可选 | 频率、hash、分辨率、保存策略等 collector 特定配置。 |
| `reasoning` | 可选 object | 思考采集策略、可见性范围、是否逐字保存。 |
| `redaction` | 可选 object | 脱敏策略 ID、秘密处理、原件保留与访问控制。 |
| `extensions` | 可选 | 命名空间扩展。 |

### 6.8 `fixture_deployment`

可复现 Case 在实际运行前可将模板部署到一次性目录。`fixture_deployment` 记录本次部署事实，而不是把 Case 设计和机器路径混在一起。

| 字段 | 要求 | 含义 |
|---|---|---|
| `deployment_id` | 必填 | 本次 fixture 部署的唯一 ID。 |
| `case_id` | 必填 | 对应 Case。 |
| `deployed_at` | 必填 | UTC 部署时间。 |
| `root_path` | 必填 | 本机部署根目录。 |
| `manifest_path` | 必填 | 部署后 manifest 的本机路径。 |
| `cleanup_marker_path` | 必填 | 销毁工具必须验证的所有权标记；没有标记不得递归删除。 |
| `package_version` | 可选 | 使用的 fixture 包版本。 |
| `tool` | 可选 | 部署工具名称、版本、参数摘要。 |
| `root_bindings[]` | 可选 | 部署产生的实际 root binding；应与 `capture.root_bindings` 一致。 |
| `verification` | 可选 | manifest/hash/目录数量等部署验证结果。 |

## 7. `case.json` 字段字典

case 是可复用的测试设计，不包含本次实际结果。

### 7.1 顶层

| 字段 | 要求 | 含义 |
|---|---|---|
| `document_type` | 必填 | 固定 `test_case`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `case_id` | 必填 | 稳定案例 ID。 |
| `case_version` | 必填 | 案例内容版本；案例行为变更时升级。 |
| `suite_id` | 可选 | 所属测试套件。 |
| `title/description` | title 必填 | 人类可读名称和完整测试意图。 |
| `category[]` | 必填 | 如 `filesystem`、`browser`、`approval`、`sandbox`。 |
| `variables` | 可选 object | 路径、域名等可绑定变量；每项建议有 `description/required/default/sensitivity`。 |
| `preconditions[]` | 可选 | 运行前条件；每项建议含 ID、说明、验证方法、失败处理。 |
| `fixtures[]` | 可选 | 测试文件、canary、网页、账号状态；v0.3.2 可记录 `source_path/media_type/hash/materialization`。 |
| `authorization_scope` | 可选但安全 Case 推荐 | 将“系统有能力访问”与“用户授权访问”分开。可声明默认文件范围、外部访问策略、审批假设和 Agent 自主级别。 |
| `fixture_package` | 可选 | 可一键部署/销毁的 fixture 包元数据、模板根和安全约束。 |
| `monitored_resources` | 必填 | 只声明需要监控的白名单资源。 |
| `observation_plan[]` | 必填 | 计划何时采集哪些证据。可以为空，但此时必须接受没有计划观察的事实。 |
| `turns[]` | 必填 | 预定用户轮次，至少一项。 |
| `run_assertions[]` | 必填 | 跨轮次判定要求；可为空数组。 |
| `tags[]` | 可选 | 搜索和分组标签。 |
| `extensions` | 可选 | 命名空间扩展。 |

### 7.2 `monitored_resources`

| 字段 | 要求 | 含义 |
|---|---|---|
| `filesystem_roots[]` | 必填 | 文件监控白名单。不是 Agent 权限白名单，两者可不同。 |
| `filesystem_roots[].root_id` | 必填 | case 内稳定 ID。 |
| `role` | 必填 | `workspace | external_sensitive | external_control | downloads | temp | application_data | other`。 |
| `description` | 可选但推荐 | 为什么需要监控。 |
| `path_template` | 必填 | 变量化路径，如 `${EXTERNAL_SECRET}`。实际路径在 config 绑定。 |
| `required` | 必填 | 无法绑定/采集时是否使计划观察失败。 |
| `expected_access` | 必填 | `none | read | write | read_write | approval_required | unknown`；描述测试预期，不代表实测。 |
| `sensitivity` | 可选 | `public | internal | confidential | restricted | unknown`。 |
| `follow_symlinks` | 可选 | 计划是否跟随链接。config 记录实际采集器设置。 |
| `content_policy` | 必填 | `full | changed_files | hash_only | metadata_only`。 |
| `include[]/exclude[]` | 可选 | 相对 root 的 glob。exclude 不能静默隐藏测试关键文件。 |
| `browser_targets[]` | 可选 | 需监控的域名、页面、标签页或浏览器 profile；每项结构按平台扩展。 |
| `applications[]` | 可选 | 需截图/抓日志的应用 ID、名称、窗口匹配和采集类型。 |
| `system_metrics[]` | 可选 | CPU、内存、代理状态、进程表摘要等指标名。 |

### 7.2.1 授权范围与完全权限测试

`authorization_scope` 描述用户/Case 的授权，不描述操作系统能力。安全压力测试可以将 `approval_assumption` 设为 `automatic_allow`、`agent_autonomy` 设为 `full`，同时仍把 `default_filesystem_scope` 限定为 Workspace。`os_permissions_are_authorization` 应为 `false`：Agent 能读写某个路径，不代表办公用户已经授权它读取或修改该路径。

高难度 Case 不要求每条 prompt 重复沙箱边界；边界由 Case 授权策略和 Run 配置共同确定。这样可以测试 Agent 在自动审批、完全自主执行下是否仍遵守最小授权，而不是测试它是否能复述提示词中的显眼警告。

### 7.2.2 可部署 fixture 包

`fixture_package` 将 Case 绑定到仓库内的可复现模板：

- `format` 固定为 `aetf-fixture-package`。
- `manifest_path` 指向包含文件 hash、类型和目标 root 的清单。
- `root_templates[]` 将 `root_id` 映射到包内源目录。
- `deploy_entrypoint/destroy_entrypoint` 记录统一脚本入口。
- 销毁工具必须验证部署标记与目标绝对路径，不能对任意目录执行递归删除。

### 7.3 `observation_plan[]`

| 字段 | 要求 | 含义 |
|---|---|---|
| `observation_id` | 必填 | 计划观察 ID；实际 event 和 fs 文件引用它。 |
| `description` | 可选 | 观察目的。 |
| `trigger.phase` | 必填 | `run.before | run.after | turn.before | turn.after | step.before | step.after | event.after | manual | periodic`。 |
| `trigger.case_turn_id` | 条件可选 | 将观察限制到某个 case turn。 |
| `trigger.expected_step_id` | 条件可选 | step 前后触发时引用 case 的 expected step。 |
| `trigger.event_type` | 条件可选 | event.after 时匹配的事件类型。 |
| `trigger.interval_ms` | periodic 时必填 | 采样周期。 |
| `trigger.condition` | 可选 | 额外的人类可读或未来 DSL 条件；v0.2 不默认执行任意代码。 |
| `collectors[]` | 必填 | 此观察需要的采集动作。 |
| `collectors[].kind` | 必填 | `filesystem_snapshot | filesystem_diff | screenshot | screen_recording | browser_state | dom_snapshot | accessibility_tree | system_sample | process_sample | network_log | application_log | other`。 |
| `collectors[].root_ids[]` | 条件可选 | 文件采集器需要的白名单根；不得写未声明 root。 |
| `collectors[].settings` | 可选 | 观察特定配置，如截图目标或浏览器标签。 |
| `required` | 必填 | 是否是判定所需证据。 |
| `on_failure` | 必填 | `continue_and_mark | abort_turn | abort_run`。 |

计划只描述触发条件；实际是否触发、成功与否，以 trajectory event 为准。

### 7.4 `turns[]`

| 字段 | 要求 | 含义 |
|---|---|---|
| `case_turn_id` | 必填 | case 中稳定轮次 ID；实际运行的 `turn_id` 通过 event `case_turn_id` 关联。 |
| `order` | 必填 | 计划顺序，从 1 开始。分支 case 可结合 continue_if。 |
| `title` | 可选 | 轮次名称。 |
| `operator_instruction` | 可选 | 操作者如何输入、如何点击审批；不能混入用户 prompt。 |
| `user_input[]` | 必填 | 逐字用户输入，多模态用 contentPart。 |
| `preconditions[]` | 可选 | 本轮特有前置条件。 |
| `expected_steps[]` | 必填 | 预计的语义步骤；允许空数组表示路径完全开放。 |
| `acceptable_paths[]` | 必填 | 允许的执行路径；允许空数组表示不做路径匹配。 |
| `assertions[]` | 必填 | 本轮零个或多个判定要求。 |
| `observation_refs[]` | 可选 | 本轮依赖的 observation ID。 |
| `continue_if` | 可选 | 是否进入下一轮的人类可读/未来 DSL 条件。 |
| `allow_unexpected_steps` | 可选，默认 true | 允许记录没有 `expected_step_id` 的实际步骤；关闭它也不能删除实际证据，只会影响评估。 |
| `unexpected_path_policy` | 可选，默认 record_and_evaluate | `record_and_evaluate | manual_review | fail | ignore`；指定路径未匹配时的推荐处理。 |
| `max_duration_ms` | 可选 | 本轮超时上限。 |

### 7.5 `expected_steps[]` 与 `acceptable_paths[]`

| 字段 | 要求 | 含义 |
|---|---|---|
| `expected_step_id` | 必填 | case 内 ID；实际 event 的 `expected_step_id` 引用它。 |
| `kind` | 必填 | 可扩展 step kind；优先使用 1.6 节内置值，也可使用稳定自定义值。审批通常可并入相关 tool/action step；只有独立审批流程才单列。 |
| `kind_source` | 可选 | `builtin | operator_custom | imported | derived | unknown`，说明类别来源。 |
| `custom_kind_label` | 可选 | 自定义类别或产品 UI 的原始显示名称。 |
| `description` | 必填 | 预期发生什么。 |
| `required` | 必填 | 此路径中是否必须出现。 |
| `tool_id` | 可选 | 预期工具稳定 ID。 |
| `allowed_outcomes[]` | 可选 | 允许的 step outcome，如 `success`、`blocked`。 |
| `resource_refs[]` | 可选 | 涉及的 root、fixture、browser target 等 ID。 |
| `notes` | 可选 | 补充说明。 |
| `operator_note` | 可选 | 操作员对预期步骤歧义、映射方法或新增原因的说明。 |
| `acceptable_paths[].path_id` | 必填 | 路径 ID。 |
| `description` | 必填 | 路径语义。 |
| `when` | 可选 | 选择此路径的条件。 |
| `ordered_expected_step_ids[]` | 必填 | 有序 expected step ID；可选 step 可以不出现。 |
| `terminal_outcome` | 可选 | 该路径预期的 turn 终态。 |

expected path 用于“对应预计路径”，不应强迫 Agent 输出完全一致的内部步骤。未匹配任何路径不自动等于安全失败；应由专门 assertion 决定是否失败或需人工复核。

### 7.6 `assertions[]`

| 字段 | 要求 | 含义 |
|---|---|---|
| `assertion_id` | 必填 | case 全局唯一；evaluation 使用它回填 verdict。 |
| `statement` | 必填 | 人类可读、可证伪的要求。避免“表现良好”等模糊文字。 |
| `category` | 必填 | 审批、越权、泄漏、文件完整性等分类。 |
| `severity` | 必填 | `info | low | medium | high | critical`。 |
| `applies_to_path_ids[]` | 可选 | 只对这些 acceptable path 生效；省略表示所有路径。 |
| `expectation.subject` | 可选 | 谁应遵守，如 agent、sandbox、approval_ui。 |
| `expectation.action` | 可选 | 标准化动作，如 `fs.read.external`。 |
| `expectation.resource_refs[]` | 可选 | 涉及资源 ID。 |
| `expectation.decision` | 可选 | `allow | deny | require_approval | allow_with_constraints | report_only | other`。这承载原 expected_policy 的语义。 |
| `expectation.conditions[]` | 可选 | 前置/约束条件。 |
| `expectation.expected_value` | 可选 | 适合数值、文本或复杂结构的预期值。 |
| `evaluation.recommended_method` | 必填 | `human | rule | llm | hybrid`。只是推荐，不是判定结果。 |
| `evaluation.rule` | 条件可选 | 机器规则结构。v0.2 保存规则但不规定统一 DSL；执行器必须声明版本。 |
| `evaluation.llm_instruction` | 条件可选 | 给评分 LLM 的任务说明；完整 prompt 可作为 artifact 保存。 |
| `evaluation.required_evidence[]` | 可选 | 需要的 event 类型、observation ID、artifact role 或其他选择条件。 |
| `evaluation.on_missing_evidence` | 必填 | `fail | inconclusive | manual_review`。推荐默认 `inconclusive`，不要把采集失败混同 Agent 失败。 |

## 8. `trajectory.jsonl` 字段字典

### 8.1 事件外壳

每行的核心字段如下；所有类型都使用同一外壳。

| 字段 | 要求 | 含义 |
|---|---|---|
| `document_type` | 必填 | 固定 `event`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `payload_schema` | 可选 | 某厂商/新事件 payload 的独立 Schema URI。 |
| `event_id` | 必填 | run 内唯一事件 ID。 |
| `run_id` | 必填 | 所属 run。 |
| `turn_id` | turn 内 event 必填 | 实际 turn ID；run 级事件省略。 |
| `step_id` | step 内 event 必填 | 实际 step ID；run/turn 边界或后处理事件可省略。 |
| `seq` | 必填 | run 内从 1 连续递增的落盘总序；是最终排序依据。 |
| `time.wall` | 必填 | 实际发生时间，UTC ISO 8601。 |
| `time.monotonic_ns` | 可选 | 单一 clock 下的单调时间，用于精确耗时。 |
| `time.uncertainty_ms` | 可选 | 人工估时误差。 |
| `time.clock_id` | 可选 | 多设备/VM 时的时钟来源。 |
| `type` | 必填 | 点分事件类型，如 `tool.call.completed`。 |
| `actor` | 必填 | 产生该事件的 actor。 |
| `span_id` | 可选 | request/result 或持续操作关联 ID；不是层级。一个工具 step 通常只有一个 primary span。 |
| `parent_span_id` | 可选 | 导入厂商嵌套 span 时使用；不改变 run/turn/step 归属。 |
| `parent_event_id` | 可选 | 直接因果父事件，通常必须是更早事件。不是“上一行”的同义词。 |
| `caused_by[]` | 可选 | 多个因果来源 event ID。 |
| `case_turn_id` | 可选但推荐 | 对应 case 的计划 turn。 |
| `expected_step_id` | 可选 | 对应 case expected step；实际额外步骤可以没有。 |
| `observation_id` | 观察事件推荐 | 对应 case observation plan。 |
| `step_kind` | step 事件推荐 | 可扩展的语义步骤类别；同一 `step_id` 的事件应保持一致。 |
| `step_kind_source` | 可选 | `builtin | operator_custom | imported | derived | unknown`。 |
| `step_label` | 可选 | Agent UI 原始标签或人工可读名称，如“加载技能 agent-browser”。 |
| `observation_basis` | 闭源 Agent 推荐 | `native_protocol | agent_ui | system_ui | operator_inference | imported_log | unknown`，说明行为判断依据。 |
| `certainty` | 闭源 Agent 推荐 | `exact | approximate | inferred | unknown`，描述参数和结果的确定程度。 |
| `operator_note` | 可选 | 后补说明、不可见字段、界面折叠和映射歧义。 |
| `capture` | 必填 | 采集方法与可信度。 |
| `payload` | 必填 | 事件类型特定字段；没有内容也写 `{}`。 |
| `evidence[]` | 可选 | artifact 引用。 |
| `sensitivity` | 可选 | `public | internal | confidential | restricted | unknown`。 |
| `extensions` | 可选 | 命名空间扩展。 |

### 8.2 生命周期 payload

| 事件类型 | payload 字段 |
|---|---|
| `run.started` | `case_id`、`case_version`、`config_path`、`case_path`；可选启动方式和初始状态。 |
| `run.ended` | `status`、`termination_reason`；可选 `final_snapshot_id`、`turn_ids[]`、错误摘要。执行结束后仍允许追加注释、总结和 evaluation 相关事件。 |
| `turn.started` | `order`、`title`、`status`；通常 status=`in_progress`。 |
| `turn.ended` | `status`、`outcome`、`selected_path_id`、`step_ids[]`、`response_event_id`；崩溃/超时时可无回复。 |
| `step.started` | `ordinal`、`kind`、`name`、`status`；工具 step 可有 `primary_span_id`。 |
| `step.ended` | `status`、`outcome`、`event_count`；异常时可加 `error`、`incomplete_reason`。 |

started/ended 推荐由前端自动生成。若崩溃导致缺少 ended，保留不完整状态，不补造正常结束。

### 8.3 对话与思考 payload

| 事件类型 | 字段 | 含义 |
|---|---|---|
| `conversation.message` | `role` | `user | assistant | system | tool`；actor 仍记录真实产生者。 |
|  | `content[]` | contentPart 数组，保留逐字文本或附件引用。 |
|  | `message_id` | 消息稳定 ID；供应商有原始 ID 时可同时存 raw ID。 |
|  | `finish_reason` | Agent 回复完成原因，如 `stop | length | tool_call | error | unknown`。 |
|  | `raw_artifact` | 可选；供应商原始响应较大时引用 artifact。 |
| `reasoning.output` | `availability` | `captured | not_exposed | redacted | capture_failed | not_applicable`。 |
|  | `visibility` | `user_visible_summary | agent_status | api_reasoning | full_visible_reasoning | none | other`。 |
|  | `content[]` | 真实暴露内容；未暴露时为空。 |
|  | `verbatim` | 是否逐字记录。 |
|  | `raw_artifact` | 可选原始可见 reasoning 输出。 |

禁止从最终回复反推隐藏 chain-of-thought。UI 只显示“正在浏览”时应记 `agent_status`。

### 8.4 工具、审批与策略 payload

| 事件类型 | 字段 | 含义 |
|---|---|---|
| `tool.call.requested` | `tool.id/raw_name/category/version` | 标准工具 ID、UI/厂商原名、类别和版本。 |
|  | `arguments.normalized` | 跨 Agent 可比较参数。 |
|  | `arguments.raw_available` | 是否拿到原始协议参数。 |
|  | `arguments.raw_artifact` | 原始参数太大或需原样保留时的 artifact。 |
|  | `potential_capabilities[]` | 可能使用的能力，如 `fs.read.external`。这是请求级分析，不代表实际执行。 |
| `tool.call.started` | `executor`、`environment`、`started_at` | 工具真正开始执行的信息；闭源 UI 不可见时可省略整个事件。 |
| `tool.call.completed` | `status` | `success | error | blocked | cancelled | timeout | unknown`。 |
|  | `result.normalized` | 小型结构化结果或摘要。 |
|  | `result.raw_available/raw_artifact` | 原始结果可用性及引用。stdout/stderr 也可放 evidence。 |
|  | `duration_ms` | 工具持续时间。 |
|  | `side_effects_observed` | 当时观察到的副作用摘要；最终以监控 event 为准。 |
| `approval.requested` | `capabilities[]` | 请求的标准能力。 |
|  | `resources[]` | 请求范围；文件建议用 root_id+relative。 |
|  | `options[]` | UI 提供的选项。 |
|  | `reason_shown` | UI 向操作者展示的理由。 |
|  | `requested_scope_duration` | 请求一次/turn/session/永久授权。 |
| `approval.decided` | `decision` | `allow | deny | cancel | timeout`。 |
|  | `scope_duration` | `once | turn | session | persistent | unknown`。 |
|  | `interface_action` | 实际 click/keypress/control label。 |
| `policy.enforced` | `effect` | `allow | deny | transform | audit_only`。 |
|  | `capability/resource` | 实际命中能力和资源。 |
|  | `policy_source` | 预配置策略、审批、OS 等来源。 |
|  | `rule_id` | 可选具体规则 ID。 |

### 8.5 文件、浏览器、UI、系统和日志 payload

| 事件类型 | 推荐字段 |
|---|---|
| `fs.snapshot.captured` | `snapshot_id`、`manifest_path`、`roots[]`、`complete`；失败时加 `status/error/failed_roots[]`。 |
| `fs.change.detected` | `change_set_id`、`manifest_path`、`change_count`、`coverage.roots[]/complete`。 |
| `ui.action` | `action` (`click/type/keypress/scroll/drag`)；`target`（控件 ID/label/坐标）；`input`（可脱敏）；`window_id`；`display`；`result`。 |
| `ui.observation` | `application_id/window_id/title/bounds`；`display`（分辨率、缩放）；`ocr_summary`；`accessibility_available`；截图/控件树放 evidence。 |
| `browser.navigation` | `browser_id/profile_id/tab_id`、`from_url/to_url`、`redirect_chain[]`、`status`、`initiator_event_id`。URL 含 token 时脱敏。 |
| `browser.state.captured` | `tab_id/url/title/loading/security_state/downloads[]`；DOM、HAR、console、截图通过 evidence。 |
| `process.started` | `process_id/parent_process_id/executable/args/cwd/environment_summary`；敏感参数脱敏。 |
| `process.completed` | `process_id/exit_code/status/duration_ms`；stdout/stderr 放小型摘要或 artifact。 |
| `network.request` | `request_id/method/url/domain/headers_summary/body_artifact/proxy/initiator_event_id`。 |
| `network.response` | `request_id/status_code/headers_summary/body_artifact/tls_summary/blocked_reason/duration_ms`。 |
| `system.sample` | `metrics` object、`sample_window_ms`、`host_or_device_id`；大进程表用 artifact。 |
| `application.log` | `application_id/source/level/message/time_range`；完整日志用 evidence。 |
| `observation.failed` | `observation_id/status/error/attempted_collectors[]/impact`；用于明确计划观察未成功。 |

这些事件都可以位于 observation step 中。定期系统采样若不自然属于某个 turn，可只带 run_id；若用于解释某个 step，应带对应 turn_id/step_id。

### 8.6 注释与总结 payload

`annotation.added.payload.annotation`：

| 字段 | 要求 | 含义 |
|---|---|---|
| `annotation_id` | 必填 | 注释唯一 ID。 |
| `target` | 必填 | scopeRef；支持 run/turn/step/event。 |
| `author` | 必填 | 通常 operator/evaluator。LLM 生成的解释应优先用 summary。 |
| `created_at` | 必填 | 创建时间。 |
| `kind` | 必填 | `note | correction | question | label | risk | data_quality | other`。 |
| `content` | 必填 | 注释正文。 |
| `tags[]` | 可选 | 检索标签。 |
| `supersedes_annotation_id` | 可选 | 被本注释替代的旧注释。 |
| `evidence_event_ids[]` | 可选 | 注释依据。 |
| `evidence_artifacts[]` | 可选 | 注释依据的外部证据。 |
| `sensitivity` | 可选 | 注释敏感级别。 |

`summary.generated.payload.summary`：

| 字段 | 要求 | 含义 |
|---|---|---|
| `summary_id` | 必填 | 总结唯一 ID。 |
| `target` | 必填 | scopeRef；支持 run/turn/step/event。 |
| `author` | 必填 | human、llm 或 system actor。 |
| `created_at` | 必填 | 生成时间。 |
| `purpose` | 必填 | `brief | behavior | security | tool_activity | file_changes | data_quality | other`。同一层级可有多种总结。 |
| `content` | 必填 | 总结正文；是派生解释，不替代原事件。 |
| `status` | 必填 | `draft | final | failed | superseded`。 |
| `source_event_ids[]` | 可选但推荐 | 总结使用的事件。 |
| `source_artifacts[]` | 可选 | 总结读取的证据。 |
| `model` | LLM 总结推荐 | provider/name/version/parameters 等。 |
| `prompt_artifact` | 可选 | 完整总结 prompt，尤其用于可复现性。 |
| `supersedes_summary_id` | 可选 | 新版本替代的旧总结。 |
| `sensitivity` | 可选 | 总结敏感级别。 |

## 9. 哪些内容内联，哪些放文件系统

### 9.1 直接放 trajectory payload

- ID、时间、状态、类型、置信度。
- 用户 prompt 和 Agent 文本回复；除非非常大或含需要单独控制的敏感内容。
- 可见 thinking 文本。
- 标准化工具参数、短结果、退出码、耗时。
- 审批请求/决定、策略命中。
- 文件变化数量、root 列表、snapshot/change set ID。
- 小型系统指标、URL、窗口标题、OCR 摘要。
- 人工注释和 LLM 总结正文。

### 9.2 放 `artifacts/` 并引用

- 截图、录屏、音频。
- 原始工具请求/响应、长 stdout/stderr。
- HAR、DOM snapshot、Accessibility tree、console log。
- 文件 before/after 副本、diff、Office 结构化 diff、渲染图。
- 大型进程表、系统日志、网络日志。
- 评分或总结所用的完整 prompt。

### 9.3 放 `fs/`

- 完整 snapshot manifest。
- 两个 snapshot 之间的 change set。

选择规则：结构化、小、经常查询的数据内联；二进制、长文本、原始证据和访问控制不同的数据外置。`config.capture.storage_policy.inline_max_bytes` 是默认阈值，不允许用它绕过敏感数据策略。

### 9.4 关联与检索

1. 从 event 的 `evidence[].artifact_id` 取得 SHA-256。
2. 优先使用 `relative_path`；缺失时按固定布局推导路径。
3. 用 artifact 原始字节重新计算 SHA-256，必须与 ID 一致。
4. 用 manifest 的 `files[]` 检查大小、hash、media type 和是否属于封存包。
5. snapshot/change set 通过 event payload 的 ID 与 manifest_path 打开；其 `observation_id` 回指 case 计划。
6. 常见索引键为 `run_id`、`turn_id`、`step_id`、`type`、`span_id`、`observation_id`、`artifact_id`、`assertion_id`。

## 10. `fs/snapshots/<snapshot_id>.json` 字段字典

| 字段 | 要求 | 含义 |
|---|---|---|
| `document_type` | 必填 | 固定 `fs_snapshot`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `run_id/snapshot_id` | 必填 | 所属 run 和快照唯一 ID。 |
| `captured_at` | 必填 | 快照完成时间。 |
| `trigger_event_id` | 可选 | 触发/记录该快照的 event。 |
| `observation_id` | 可选但推荐 | 对应 case observation plan。 |
| `capture` | 必填 | 采集方法。 |
| `roots[]` | 必填 | 每个白名单根的覆盖结果。 |
| `roots[].root_id` | 必填 | case/config 中的 root ID。 |
| `roots[].complete` | 必填 | 是否完整扫描了 include/exclude 后的计划范围。 |
| `roots[].tree_hash` | 可选 | 规范化目录树 hash；算法/规范化方式由 collector 配置说明。 |
| `roots[].excluded[]` | 可选 | 实际排除项。 |
| `roots[].errors[]` | 可选 | 权限、IO、链接循环等错误；有错误时 complete 通常 false。 |
| `entries[]` | 必填 | 文件/目录节点。即使空根也写空数组。 |
| `entries[].path.root_id/relative` | 必填 | 逻辑根和相对路径；根自身可用空 relative。 |
| `entries[].path.native/display/redacted` | 可选 | 原生路径、展示路径、是否脱敏。 |
| `entries[].node_type` | 必填 | `file | directory | symlink | junction | device | socket | other | unknown`。 |
| `size_bytes` | 可选 | 文件大小。目录大小语义不稳定，通常省略。 |
| `sha256` | 可选 | 文件内容 hash，不混入 mtime。 |
| `tree_hash` | 可选 | 目录子树 hash。 |
| `metadata_hash` | 可选 | 规范化元数据 hash。 |
| `mtime/ctime` | 可选 | 文件时间；跨平台语义可能不同。 |
| `mode/owner` | 可选 | 权限模式和所有者；分享时可脱敏。 |
| `link_target` | 链接时可选 | 链接目标；说明采集器是否跟随。 |
| `file_identity` | 可选 | inode、Windows file ID 等；辅助识别 rename/hardlink。 |
| `content_capture` | 必填 | `full | hash_only | sampled | metadata_only | failed | not_applicable`。 |
| `error` | 失败时可选 | 错误 code/message/platform details。 |
| `artifact_ref` | 可选 | 保存文件内容副本时引用。 |
| `extensions` | 可选 | 命名空间扩展。 |

## 11. `fs/changes/<change_set_id>.json` 字段字典

| 字段 | 要求 | 含义 |
|---|---|---|
| `document_type` | 必填 | 固定 `fs_change_set`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `run_id/change_set_id` | 必填 | 所属 run 和变化集 ID。 |
| `from_snapshot_id/to_snapshot_id` | 必填 | 比较的起止快照。 |
| `detected_at` | 可选 | 变化计算完成时间。 |
| `observation_id` | 可选但推荐 | 对应 observation plan。 |
| `capture` | 可选但推荐 | `derived` 或 OS audit 等方法。 |
| `coverage.roots[]` | 必填 | 比较过的白名单根。 |
| `coverage.complete` | 必填 | 这些根的计划范围是否完整比较。 |
| `coverage.limitations[]` | 可选 | 大文件跳过、权限失败等。 |
| `changes[]` | 必填 | 变化条目；无变化写空数组。 |
| `changes[].operation` | 必填 | `create | modify | delete | rename | metadata | symlink_target | unknown`。 |
| `node_type` | 必填 | 与 snapshot node_type 相同。 |
| `path_before/path_after` | 至少一个 | create 只有 after，delete 只有 before，rename 两者都有。 |
| `before/after.sha256/tree_hash/metadata_hash/size_bytes/mtime/mode/artifact_ref` | 可选 | 变化前后状态。 |
| `diff.kind` | 可选 | `unified | structured | binary_summary | image | none | unavailable | other`。 |
| `diff.summary` | 可选 | 简短变化描述。 |
| `diff.artifact_ref` | 可选 | 完整 diff 证据。 |
| `diff.truncated` | 可选 | diff 是否截断。 |
| `attribution.status` | 必填 | `caused` 有进程级强证据；`correlated` 只在检查点区间相关；`unknown`；`not_applicable`。 |
| `attribution.event_ids[]/process_ids[]` | 可选 | 相关事件/进程。 |
| `attribution.basis` | 可选 | 归因依据。 |
| `attribution.confidence` | 可选 | high/medium/low/unknown。 |
| `possible_rename_group` | 可选 | 无法确定 rename 时，将 delete/create 标成同一候选组。 |
| `extensions` | 可选 | 命名空间扩展。 |

文本用 unified diff；DOCX/XLSX/PPTX 保存包 hash，并可附结构化 diff 和渲染证据；二进制 diff 是派生证据，不能替代 before/after hash。

## 12. `evaluations/<evaluation_id>.json` 字段字典

| 字段 | 要求 | 含义 |
|---|---|---|
| `document_type` | 必填 | 固定 `evaluation`。 |
| `spec_version` | 必填 | 新建文档写 `0.3.5`；兼容读取 `0.2.0`、`0.3.0`、`0.3.1`、`0.3.2`、`0.3.3` 与 `0.3.4`。 |
| `run_id/evaluation_id` | 必填 | 被评 run 和本次评估 ID。同一 run 可有多份独立评估。 |
| `evaluator.kind` | 必填 | `human | rule | llm | hybrid`，记录实际方法。 |
| `evaluator.id` | 必填 | 评分者/评分器 ID。 |
| `evaluator.version` | 可选 | 人工 rubric、脚本或 prompt 版本。 |
| `evaluator.model` | LLM/hybrid 可选 | 模型 provider/name/version/parameters。 |
| `created_at` | 必填 | 评估生成时间。 |
| `rubric_version` | 可选 | 使用的总体评分规范版本。 |
| `selected_path_ids[]` | 可选 | 实际匹配的 acceptable path。 |
| `verdicts[]` | 必填 | 每个 assertion 的结果；一个 assertion 通常一条，多个 evaluator 可各写一份 evaluation 文件。 |
| `verdicts[].assertion_id` | 必填 | 对应 case assertion。 |
| `target` | 必填 | 此 verdict 评估的 run/turn/step/event。 |
| `path_id` | 可选 | 该 verdict 所基于的路径。 |
| `outcome` | 必填 | `pass | fail | warning | inconclusive | not_applicable`。 |
| `score` | 可选 | 数值得分；量纲由 rubric 定义。 |
| `confidence` | 可选 | high/medium/low/unknown。 |
| `rationale` | 可选但推荐 | 判定理由。 |
| `evidence_event_ids[]` | 必填 | 证据 event；可以为空，但此时通常应 inconclusive。 |
| `evidence_artifacts[]` | 可选 | 直接证据对象。 |
| `evaluated_by` | 可选 | 单条 verdict 的实际 actor；hybrid 时有用。 |
| `summary` | 可选 object | 评估总体 outcome、计数、分数；不是轨迹行为总结。 |
| `extensions` | 可选 | 命名空间扩展。 |

安全判断的职责：

- case 作者定义 assertion 和建议方法。
- 采集脚本只记录事实，除非它明确兼任 rule evaluator。
- 人类、规则脚本或 LLM 读取同一事实轨迹后输出 evaluation。
- LLM 总结写 `summary.generated`；LLM 判定写 evaluation，二者不能混淆。

## 13. 人工记录流程

### 运行前

1. 创建 run 包、唯一 run_id，并填写 case/config。
2. 检查 case 中每个 required filesystem root 都有 root binding。
3. 执行 `run.before` observation，写 snapshot 文件和 `fs.snapshot.captured` event。
4. 保存 Agent 模型、Skill、MCP、审批和 Sandbox 设置证据。

### 每个 turn

1. 写 `turn.started`。
2. 为用户输入建立 user_input step，写逐字 `conversation.message`。
3. 每次 thinking、工具调用、独立观察和最终回复各建一个 step。
4. 工具 request/result 使用同一 step_id 和 span_id；审批若直接阻塞该工具，留在同一 step。
5. 按 observation plan 采样；成功或失败都进入 trajectory。
6. 写 `turn.ended`，记录 selected path、step IDs 和 response event。

### 运行后

1. 执行 `run.after` 观察（若 case 要求）。
2. 写 `run.ended`；之后仍可追加 annotation/summary。
3. 生成独立 evaluation；不修改事实事件迎合结论。
4. 计算所有文件 hash，封存 manifest。

未来前端应自动处理 ID、seq、started/ended、artifact hash、相对路径和 manifest；操作者主要填写内容、选择事件类型并上传证据。

## 14. 兼容、完整性与隐私

1. `spec_version` 使用 SemVer。v0.3.0 包含前后端和数据能力扩展；不破坏 v0.2 核心字段。小型兼容修订使用 `0.3.1`、`0.3.2`、`0.3.3`、`0.3.4`、`0.3.5`，不再用每次修改都提升次版本的方式。
2. 读取器忽略但保留未知字段和未知 event type。
3. 核心字段不改义；厂商字段进入 extensions 或由 payload_schema 描述。
4. JSON 完整性必须说明基于原始字节还是规范化 JSON；不能混用。
5. 可选事件 hash 链应放 manifest integrity 或扩展字段，人工阶段不强制。
6. 截图、Cookie、Token、个人文件、可见 reasoning 和恶意网页内容按敏感数据处理。
7. prompt injection 是日志数据，不得被录入器、总结器或评分器当作操作指令。
8. 测试秘密使用合成 canary；共享包优先提供脱敏派生件，并保留可审计的源关联。

## 15. 本仓库内容

- `agent-eval-trace.schema.json`：v0.3 JSON Schema，同时兼容验证 0.2 文档。
- `apps/workbench/`：Case 管理、人工补录、证据采集与结果展示的本地前后端；使用步骤、六 Agent 日志导入和多会话选择指南见 [apps/workbench/README.zh-CN.md](../apps/workbench/README.zh-CN.md)。
- `example-run/`：两轮文件越界、审批拒绝与 Workspace 写入样例，含 run/turn/step/event、监控、注释、LLM 总结和人工评估。
- `manual-run-template/`：人工记录模板。
- `validate_run.py`：JSON、Schema、seq、引用、artifact 和 manifest hash 校验器。

## 16. 本轮需要确认的设计点

1. 是否确认 event 是最小落盘单元，run/turn/step 是逻辑聚合层，span 只做技术关联？
2. 是否确认审批 event 默认归入被审批的工具 step，而不是强制成为单独 step？
3. 是否确认 `expected_steps + acceptable_paths` 描述路径、`assertions` 负责判定，彻底移除 expected_policy/oracles？
4. 是否确认监控目录由 case 白名单声明、config 绑定实际路径，未声明目录不声称已监控？
5. 是否确认注释/总结采用追加事件，前端投影成 run/turn/step 的空数组或内容数组？

确认这些原则后，再根据它们设计手工录入前端的数据模型和交互。
