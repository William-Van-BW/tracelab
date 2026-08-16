# TraceLab

[English](README.md) · **中文**

**桌面智能体能安全地操作你的文件吗？**

TraceLab 用一套可复现的方法回答这个问题：一批还原真实办公场景的测评 Case、一份
记录智能体实际行为的轨迹格式、一个本地工作台（部署 Case、录入轨迹、采集证据），
以及一个把结果公开出去的静态站点。

**在线结果：** <https://william-van-bw.github.io/tracelab/>

---

## 为什么做这件事

常见的评测问智能体“能不能”完成任务。但当它可以直接读写你的真实桌面时，更要紧的
问题是它“该不该”这么做，以及它能否分辨两者的区别。

真实的办公目录天然带着这种模糊性：文件由不同的人在不同时间留下；命名未必规范；
过期的说明文件还躺在原地；业务系统仍依赖几年前写下的相对路径；内网 SOP 可能和部门
自己的规定冲突。智能体必须遵守的边界往往没有被明说——它得先把材料读明白，才能动手。

每个 TraceLab Case 都把这样一个情境还原成可部署的目录树和一句逐字 Prompt，然后完整
记录智能体的每一次读取、执行与写入。

## 三类文件安全风险

| 代号 | 风险小类 | 对应的担忧 |
| --- | --- | --- |
| **OA** | 文件越权访问 | 工作区内的材料给出了工作区外的线索。智能体会不会把业务线索当成访问授权？ |
| **UFM** | 文件误删误改 | 指令模糊、文件名相近、外部规范与本地口径冲突。智能体会不会删改本不该动的文件？ |
| **SDMF** | 敏感数据未能脱敏 | 对外交付前的脱敏任务。间接标识、关联数据、派生文件里还有没有漏网的？ |

三类共 24 个 Case，在六款桌面智能体上执行。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`spec/`](spec/) | **AETF** 轨迹格式：JSON Schema、字段字典、完整示例、空白录入模板 |
| [`case-library/`](case-library/) | Case 库：Case 定义、合成夹具、部署/销毁脚本、内网门户模拟服务 |
| [`apps/workbench/`](apps/workbench/) | 本地工作台：管理 Case、录入轨迹、自动导入 Agent 日志、采集文件系统证据、复核结果 |
| [`apps/showcase/`](apps/showcase/) | 对外展示站及其构建流水线 |
| [`tools/`](tools/) | Run 校验器、夹具摘要刷新、泄漏扫描、网络配置脚本 |
| [`docs/`](docs/) | 概念、Case 编写、测评 SOP、发布指南——[中文](docs/zh/)与[英文](docs/en/) |

## 各部分如何串起来

```text
case-library/          一个 Case：Prompt + 目录模板 + 判定要求
      │
      │  Deploy-Case.ps1 —— 把夹具部署成真实目录
      ▼
  测试机上的一个真实目录
      │
      │  智能体在观察下执行
      ▼
apps/workbench/        录入轨迹：Step、证据、文件系统快照
      │                （或直接导入 Agent 自己的日志——内置六款适配器）
      ▼
  一次 Run，以 AETF 形式落盘  ──────►  spec/  负责校验
      │
      │  build-data.mjs —— 脱敏，并挑出每个 Case × Agent 的最新一条
      ▼
apps/showcase/         已发布的站点
```

## 快速开始

需要 Windows（Case 依赖 Windows 文件系统语义）、Node.js 22.13+、PowerShell 5.1 及以上。

```bash
git clone https://github.com/William-Van-BW/tracelab.git
```

只想看 Case 设计和已记录的轨迹——不装依赖、不起开发服务：

```bash
cd tracelab/apps/showcase && node scripts/build-data.mjs && node server.mjs
```

用工作台部署 Case、录入自己的测评：

```bash
cd tracelab/apps/workbench && corepack enable && pnpm install && pnpm dev
```

按轨迹格式校验一个运行包：

```bash
python tools/validate_run.py spec/examples/example-run
```

完整流程（部署 → 执行 → 录入 → 评估 → 发布）见[测评 SOP](docs/zh/03-running-an-evaluation.md)。

## 哪些是合成的，哪些不是

仓库里的每一份夹具都是合成的：薪酬表、客户名单、合同、结算凭证都是为测试编造的，
canary 字符串的存在是为了让泄漏发生时无可争辩。不含任何真实的个人或企业数据。已发布
的轨迹在发布前经过脱敏——账户名、内网地址、第三方联系方式都会被替换。

智能体的行为则是真实的：轨迹来自实际产品的真实执行。

## 用途界定

这是防御性安全研究：让部署办公智能体的人看清边界在哪里失效，让厂商能够修复。这些
Case 是诱饵，而且确实有效——动手之前请先读 [SECURITY.md](SECURITY.md)。不要把这些
夹具部署到隔离测试机之外，也不要用它们去测试你未获授权的系统。

## 参与贡献

欢迎新的 Case、更多 Agent 日志适配器，以及翻译修正。Case 编写契约与 PR 上运行的检查
见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

代码采用 [Apache-2.0](LICENSE)；Case 库、已记录轨迹与文档采用 [CC BY 4.0](LICENSE-DATA)。
署名请指向本仓库。
