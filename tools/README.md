# Tools · 工具

[English](#english) · [中文](#中文)

## English

| Tool | What it does |
| --- | --- |
| `validate_run.py` | Validates an AETF run package: structure, cross-references, and — with `jsonschema` installed — the JSON Schema itself. |
| `refresh-fixture-hashes.mjs` | Recomputes every Case's declared fixture sizes and SHA-256 digests in both `case.json` and `fixture-manifest.json`. Run it after editing lure content by hand. |
| `scan-leaks.mjs` | Refuses to let operator- or site-specific strings reach the public repository: account names, home paths, private IPv4 addresses, email addresses. Exits non-zero on a hit, and runs in CI. |
| `intranet/Open-FirewallPorts.ps1` | Opens the workbench and mock-intranet ports to the private network on a test machine. |
| `intranet/Set-IntranetNoProxy.ps1` | Adds private ranges to `NO_PROXY` and the Windows proxy exception list, so an agent's HTTP client reaches the mock portal directly. |

```bash
python tools/validate_run.py spec/examples/example-run
node tools/refresh-fixture-hashes.mjs
node tools/scan-leaks.mjs .
```

Both PowerShell scripts change machine-level settings on the test host. Read
them before running; neither is needed to browse the corpus.

---

## 中文

| 工具 | 作用 |
| --- | --- |
| `validate_run.py` | 校验 AETF 运行包：结构、交叉引用；装了 `jsonschema` 时还会按 JSON Schema 校验。 |
| `refresh-fixture-hashes.mjs` | 重新计算每个 Case 在 `case.json` 与 `fixture-manifest.json` 中声明的夹具大小与 SHA-256。手工改过诱饵内容后必须运行。 |
| `scan-leaks.mjs` | 拦住会带进公开仓库的本机特征：账户名、家目录路径、私有网段 IPv4、邮箱地址。命中即非零退出，并在 CI 中运行。 |
| `intranet/Open-FirewallPorts.ps1` | 在测试机上把工作台与内网门户模拟服务的端口对私有网络放行。 |
| `intranet/Set-IntranetNoProxy.ps1` | 把私有网段写入 `NO_PROXY` 与 Windows 代理例外列表，让 Agent 的 HTTP 客户端能直连门户。 |

```bash
python tools/validate_run.py spec/examples/example-run
node tools/refresh-fixture-hashes.mjs
node tools/scan-leaks.mjs .
```

两个 PowerShell 脚本会修改测试机的系统设置，运行前请先读一遍；只想浏览 Case 库的话
不需要它们。
