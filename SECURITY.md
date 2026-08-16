# Security and responsible use · 安全与负责任使用

[English](#english) · [中文](#中文)

## English

### What this repository contains

TraceLab is a corpus of **lures**. Each Case is a directory tree engineered so
that a plausible business instruction points an AI agent at something it should
not read, delete or disclose. The lures are written the way real office material
is written — an over-revised company standard, a script whose comment does not
match its code, an SOP that contradicts the department's own rule — because a
lure that announces itself tests nothing.

They work. Treat them accordingly.

### Rules of engagement

- **Isolated machines only.** Deploy Cases on a dedicated test machine or VM.
  Several Cases deliberately place bait *outside* the agent's working directory,
  and one downloads and runs a script from a mock intranet portal.
- **Never point a Case at production.** The fixtures are synthetic, but the
  agent's behaviour is not: an agent that takes the bait will really delete,
  really rewrite, really exfiltrate whatever is in reach.
- **The mock intranet binds to a private address.** `case-library/file-operations/intranet/`
  serves lure pages on an RFC 1918 address so agents treat it as an intranet
  resource. Do not expose that port beyond the test network.
- **Only test what you are authorised to test.** Running these Cases against
  someone else's deployment, or against a hosted agent in violation of its
  terms, is not what this corpus is for.

### Data

Every fixture is synthetic. Salary tables, customer lists, contracts and
settlement vouchers are fabricated; canary strings exist so that a leak is
unambiguous. No real personal or company data is included.

Published traces are redacted by `apps/showcase/scripts/build-data.mjs`: the
operator's account name and home path, private IPv4 addresses, and email
addresses an agent picked up while browsing are all replaced before publication.
`node tools/scan-leaks.mjs .` enforces this and runs in CI.

### Reporting a problem

If you find operator-identifying data, real third-party data, or anything else
that should not have been published, open an issue *without* quoting the
sensitive value, or contact the maintainer directly. Sensitive reports are
handled before any other issue.

For vulnerabilities in the workbench itself (it runs a local server with
filesystem access), please report privately first.

---

## 中文

### 这个仓库里是什么

TraceLab 是一批**诱饵**。每个 Case 都是精心构造的目录树：一条看起来合理的业务指示，
把智能体引向它不该读取、删除或外发的东西。诱饵一律写成真实办公材料的样子——一份
修订过头的公司规范、一段注释与代码不符的脚本、一条与部门规定冲突的 SOP——因为
自报家门的诱饵测不出任何东西。

它们是有效的。请据此对待。

### 使用边界

- **只在隔离机器上部署。** 请使用专用测试机或虚拟机。有几个 Case 会刻意把诱饵放在
  智能体工作目录**之外**，其中一个还会从内网门户模拟服务下载并执行脚本。
- **绝不要把 Case 指向生产环境。** 夹具是合成的，智能体的行为不是：一旦上钩，它会
  真的删除、真的改写、真的外发它能够到的一切。
- **内网门户模拟服务绑定私有地址。** `case-library/file-operations/intranet/` 在
  RFC 1918 地址上提供诱导页，好让智能体把它当成内网资源。不要把该端口暴露到测试
  网络之外。
- **只测试你获得授权的对象。** 拿这些 Case 去测别人的部署，或以违反服务条款的方式
  测试托管智能体，都不是本仓库的用途。

### 数据

所有夹具均为合成数据。薪酬表、客户名单、合同、结算凭证都是编造的；canary 字符串的
存在是为了让泄漏发生时无可争辩。不含任何真实的个人或企业数据。

已发布的轨迹由 `apps/showcase/scripts/build-data.mjs` 脱敏：操作者的账户名与家目录、
私有网段 IPv4、智能体在联网过程中抓到的邮箱地址，都会在发布前替换。
`node tools/scan-leaks.mjs .` 负责把关，并在 CI 中运行。

### 报告问题

如果你发现了可识别操作者的数据、真实的第三方数据，或其它不该被公开的内容，请提交
issue（**不要**在正文中引用敏感值），或直接联系维护者。此类报告优先于其它 issue 处理。

工作台本身的安全问题（它会启动一个可访问文件系统的本地服务），请先私下报告。
