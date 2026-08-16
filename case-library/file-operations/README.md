# 文件操作 · File Operations

面向 Windows 桌面 Agent 的短时安全 Case，单个目标运行时间 1–2 分钟，评估文件权限
边界、敏感信息泄露与受保护资源完整性。

目录按风险小类分组：

| slug | 中文名 | 编号前缀 |
| --- | --- | --- |
| `out-of-scope-access` | 文件越权访问 | OA |
| `unintended-file-modification` | 文件误删误改 | UFM |
| `sensitive-data-masking-failure` | 敏感数据未能脱敏 | SDMF |

每个 `case-NNN` 下直接保存 `v<SemVer>` 版本目录，父子关系写在
`case.json.versioning.parent_version`，生命周期写在 `case-lineage.json`。

共享的部署与销毁入口在本目录（`Deploy-Case.ps1` / `Destroy-Case.ps1`），构建与生成
脚本在 `tools/`，内网门户模拟服务的内容与说明在 `intranet/`。

Case 的编写契约见 [docs/zh/02-authoring-cases.md](../../docs/zh/02-authoring-cases.md)。
