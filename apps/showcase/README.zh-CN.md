# TraceLab Showcase

[English](README.md) · **中文**

对外展示站：公开 TraceLab 的 **Case 设计** 与 **执行轨迹**。只读，不提供任何编辑能力。

与 `apps/workbench/`（TraceLab 工作台）完全解耦——本站服务的是一份**自己的数据副本**，
工作台继续改 Case、录 Run 都不会影响已经上线的展示内容。

## 快速开始

```bash
node scripts/build-data.mjs && node server.mjs
```

默认监听 `8000`；端口被占用时自动顺延到下一个可用端口（最多尝试 25 个）。
用 `PORT=9000 node server.mjs` 指定端口，`HOST=127.0.0.1` 限制为仅本机访问
（默认 `0.0.0.0`，同一局域网可访问）。

零依赖，不需要 `npm install`，Node 18+ 即可。

## 展示范围

| 内容 | 规则 |
| --- | --- |
| Case | 每个 Case 家族**只展示最新版本**（有 v1.0.1 就不展示 v1.0.0） |
| Run | 只展示**绑定最新 Case 版本**的轨迹，且每个 Case × Agent 只保留**最近一次**执行 |
| 阶段 | 只收录 `benchmark`（正式测评）Run，迭代 Run 不公开 |
| 覆盖度 | 没有可比结果的 Case × Agent 组合一律显示 `—` 并说明原因，不给出总轨迹数 |

空格的解释文案是 `scripts/build-data.mjs` 里的 `COVERAGE_NOTE`，随快照下发，
矩阵图例和 Case 页共用同一份措辞。需要屏蔽的组合写在 `WITHHELD_RUNS`，按
`family_id` + `agentId` 声明（按 family 而非 OA 编号，Case 重新编号不会误放行）。
当前的空格全部来自 Claude Desktop 在五个内网 Case 上——它的安全机制禁止访问内网服务。

## 部署

线上地址：<https://william-van-bw.github.io/tracelab/>

部署是自动的：push 到 `main` 且改动了 `case-library/`、`apps/showcase/` 或
`apps/workbench/lib/` 时，`.github/workflows/deploy-showcase.yml` 会重新构建
并发布到 GitHub Pages。不需要手工推送产物。

本地预览同一份产物：

```bash
node scripts/build-data.mjs && node scripts/build-site.mjs
```

`build-site.mjs` 会**清空重建** `dist/`（`dist/` 在 `.gitignore` 中，不进版本库）。

页面全部用相对路径 + hash 路由，所以同一份 `dist/` 放在域名根目录或
`user.github.io/<repo>/` 子路径下都能直接跑，不需要重新构建、也不需要
服务器改写规则。`build-site.mjs` 会扫描产物，发现以 `/` 开头的绝对引用就报错。
产物里自带 `.nojekyll`（否则 Pages 的 Jekyll 会吞掉部分文件）和 `404.html`。

`server.mjs` 只用于本地预览；静态托管上没有它，压缩和缓存头由托管方提供。

Case 详情页保留工作台的完整读物：核心原理、目录结构及解释、User Prompt、
关键文件及 payload、预期正确路径，以及可逐项展开查看真实文件内容的
「Case 目录结构与内容概括」。

## 目录

```
showcase/
├─ scripts/
│  ├─ build-data.mjs   生成 data/ 快照（唯一一处读取工作台数据的地方）
│  └─ check.mjs        数据完整性 + 服务器冒烟测试
├─ public/             前端（原生 HTML/CSS/JS，无构建步骤、无外部资源）
├─ data/               生成产物：snapshot.json + cases/ + runs/
└─ server.mjs          零依赖静态服务器
```

## 数据来源与脱敏

`build-data.mjs` 只读地读取两处：

1. `../workbench/lib/generated-case-library.json` — Case 索引。
   **改过 `case-library/` 后要先在 `apps/workbench/` 下跑 `node scripts/sync-case-library.mjs`**，
   否则展示的是旧内容。
2. Run 目录 — 从 `../case-library/aetf-workbench.json` 的 `runsRoot`/`workingRoot`
   解析，可用 `SHOWCASE_RUNS_ROOT` 覆盖。找不到时只生成 Case 数据并给出提示。

导出时会把操作者的本机 home 路径与账户名统一替换为 `C:\Users\operator`。
轨迹里的命令、目录树、`.lnk` 十六进制片段等各种拼写形式都会被覆盖；
`scripts/check.mjs` 会扫描整个 `data/` 复核。`--no-redact` 可关闭（不建议对外使用）。

Case 材料本身（金额、姓名、编号、canary 标记）在设计上就是合成数据。

## 面向公众的鲁棒性

- **不触碰磁盘**：`data/` 与 `public/` 在启动时整体读入内存并预压缩
  （brotli + gzip），请求路径不参与任何文件系统解析，路径穿越无从谈起。
- **缓存**：数据文件按构建指纹带 `?v=`，`Cache-Control: immutable` + ETag；
  `version.json` 强制回源，因此重新构建后客户端会自动拿到新数据。
- **只读**：仅接受 `GET` / `HEAD`，其余返回 405。CSP 只允许同源，禁止内联脚本、
  禁止被 iframe 嵌套。
- **不因单个请求崩溃**：未捕获异常只记录日志，进程继续服务；
  `SIGINT`/`SIGTERM` 优雅退出。
- **健康检查**：`GET /healthz`。

## 验证

```bash
node scripts/check.mjs
```

28 项检查：快照内部引用完整、每个家族只有一个版本、五段读物齐全、
每个 Case × Agent 只有一条轨迹、脱敏无残留，以及服务器的压缩 / 304 /
404 / 405 / 路径穿越 / 120 并发请求 / 40 次保活连续请求 / 畸形请求。

## 更新流程

```bash
# 1（可选）Case 有改动时先同步工作台索引
cd ../workbench && node scripts/sync-case-library.mjs && cd ../showcase

# 2 重新生成快照并重启
node scripts/build-data.mjs
node scripts/check.mjs
node server.mjs
```

`data/` 是构建产物，但**建议随仓库一起提交**：Run 记录存放在仓库之外
（`%USERPROFILE%\AgentRuns`），别的机器 clone 之后无法重新生成。
