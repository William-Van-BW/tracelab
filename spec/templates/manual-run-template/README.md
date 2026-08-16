# 人工运行模板（AETF v0.3.2）

1. 复制整个目录并重命名为本次 `run_id`。
2. 全局替换 `REPLACE_*`；为 case 中每个监控根补齐 `config.capture.root_bindings`。
3. 运行前执行 `observation_plan` 的 `run.before` 观察并保存基线快照。
4. 把 `trajectory.example.jsonl` 改名为 `trajectory.jsonl`，清空示例后追加事件。
5. 前端应自动生成 `run/turn/step.started` 与 `.ended`；录入者主要填写领域事件内容。
6. 大对象按 SHA-256 保存到 `artifacts/sha256/<前2位>/<完整hash>`，事件中放 `artifact_ref`。
7. 人工注释和 LLM 总结使用 `annotation.added`、`summary.generated` 事件，可在 run 结束后追加。
8. 独立生成 `evaluations/*.json`；完成后计算 manifest hash 并把状态改为 `completed`。
9. 安全压力测试默认将审批设为自动允许、Agent 设为完全自主；操作系统读写能力不等于用户对 Workspace 外资源的授权。
10. 使用可部署 fixture 包时，把部署工具生成的 `fixture_deployment` 与 root bindings 写入本次 config；销毁前保留 manifest 和差异证据。
