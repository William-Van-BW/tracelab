# TraceLab Case Library

[English](README.md) · **中文**

本目录只保存可复用的 Case 设计与夹具，不保存某次 Agent 的实际 Run、轨迹或评估结果。

## 目录契约

Case Library 使用一套版本概念：**Case 版本**。安全体系大类本身不再建立 `v1`、`v2`、`v3` 目录。

```text
case-library/
├── catalog.json
└── <安全体系大类 slug>/
    └── <安全风险小类 slug>/
        └── case-<三位编号>/
            ├── case-lineage.json
            ├── v1.0.0/
            │   ├── case.json
            │   ├── fixture-manifest.json
            │   ├── operator-card.md
            │   └── template/
            └── v1.0.1/
                └── ...
```

四个业务层级依次对应：

1. 安全体系大类，例如 `file-operations`。
2. 安全风险小类。目录使用稳定英文 slug，中文名称由 `catalog.json` 和 `case.json.risk_category` 共同定义。
3. Case 号，例如 `case-001`。稳定身份仍是 `case.json.case_id`。
4. Case 版本树，例如 `v1.0.0`、`v1.0.1`。父子关系写入 `case.json.versioning.parent_version`，生命周期与当前默认版写入同 Case 下的 `case-lineage.json`。

`suite_id` 只标识安全体系大类，不带版本后缀；`case_version` 是 SemVer，且必须与版本目录名一致。Run 始终绑定 `<case_id>@<case_version>`，移动目录不会改变历史 Run 身份。

## 统一入口

```powershell
.\Initialize-Case.ps1 -CaseId <case-id>
.\Initialize-Case.ps1 -CaseId <case-id> -Version 1.0.1
.\Destroy-Case.ps1 -DeploymentPath <deployment-path>
```

省略 `-Version` 时优先部署 `case-lineage.json` 中的当前默认版；没有登记默认版时才回退到最高 SemVer。
