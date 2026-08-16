# 结果发布

[English](../en/05-publishing.md) · **中文**

Run 记录存放在仓库之外，包含测试机上的真实路径。公开的是一份**经过脱敏、经过筛选**
的快照。

## 发布流程

```bash
# 1 Case 有改动时，先重建工作台索引
cd apps/workbench && node scripts/sync-case-library.mjs

# 2 生成快照（脱敏在这一步发生）
cd ../showcase && node scripts/build-data.mjs

# 3 检查
node scripts/check.mjs
node ../../tools/scan-leaks.mjs ../..

# 4 提交
git add apps/showcase/data apps/workbench/lib/generated-case-library.json
git commit -m "chore(showcase): update snapshot"
git push
```

push 到 `main` 后，`.github/workflows/deploy-showcase.yml` 会自动重建并发布到
GitHub Pages。不需要手工推送产物。

## 筛选规则

`build-data.mjs` 不是把所有东西都发出去：

| 内容 | 规则 |
| --- | --- |
| Case | 每个家族只发**最新版本**。有 v1.0.1 就不发 v1.0.0。 |
| Run | 只发绑定最新 Case 版本的，且每个 Case × Agent 只留**最近一次**。 |
| 阶段 | 只发 `benchmark`。`iteration` Run 不公开。 |
| 覆盖度 | 没有可比结果的组合显示 `—` 并说明原因，**不给出总轨迹数**。 |

最后一条是刻意的：把“没有结果”混进总数会让覆盖度看起来比实际好。需要主动屏蔽的组合
写在 `WITHHELD_RUNS`，按 `family_id` + `agentId` 声明——按家族而不是 OA 编号，这样
Case 重新编号不会误放行。

## 脱敏

`build-data.mjs` 在导出时替换：

| 内容 | 替换为 |
| --- | --- |
| 操作者 home 路径与账户名 | `C:\Users\operator` |
| 私有网段 IPv4 | `intranet.local` |
| 邮箱地址 | `<邮箱已脱敏>` |

轨迹里的路径有多种拼法——原样 Windows 路径、JSON 转义（工具结果本身是嵌套 JSON，
分隔符会翻倍）、POSIX 风格、URL 编码，以及 PowerShell 错误信息里被截断成
`C:\Users\<前几位>...` 的形式。每一种都要覆盖，最长的规则先跑。

邮箱一并脱敏，是因为 Agent 联网时会引用第三方的联系方式——那些人没有自愿参与这份
语料，而且没有任何结论依赖地址是真的。

两道把关：`scripts/check.mjs` 复核快照，`tools/scan-leaks.mjs` 扫全仓库，两者都在
CI 里跑。`--no-redact` 只用于本地排查，**绝不能用于对外发布**。

## 为什么快照要提交进仓库

`data/` 是构建产物，但它进版本库：Run 存在仓库之外（`%USERPROFILE%\AgentRuns`），
别人 clone 之后没有原始数据，重新生成不出来。提交快照是让结果可被独立查看的唯一办法。

## 站点本身

- 零依赖，原生 HTML/CSS/JS，无构建步骤、无外部资源。
- 全部相对路径 + hash 路由，因此同一份 `dist/` 放在域名根目录或 `<user>.github.io/<repo>/`
  子路径下都能跑。`build-site.mjs` 会扫描产物，发现以 `/` 开头的绝对引用就报错。
- `server.mjs` 只用于本地预览。
