# Documentation · 文档

Each guide exists in both languages. Chinese is the authoritative source — the
project is written and operated in Chinese — and the English is kept in sync.

每篇文档都有中英两版。中文是权威源（项目本身以中文编写和运行），英文保持同步。

| | English | 中文 |
| --- | --- | --- |
| Concepts and the data model | [01-concepts](en/01-concepts.md) | [01-概念](zh/01-concepts.md) |
| Authoring a Case | [02-authoring-cases](en/02-authoring-cases.md) | [02-编写-Case](zh/02-authoring-cases.md) |
| Running an evaluation | [03-running-an-evaluation](en/03-running-an-evaluation.md) | [03-测评流程](zh/03-running-an-evaluation.md) |
| Recording traces | [04-recording-traces](en/04-recording-traces.md) | [04-轨迹录入](zh/04-recording-traces.md) |
| Publishing results | [05-publishing](en/05-publishing.md) | [05-结果发布](zh/05-publishing.md) |

The AETF specification itself lives in [`spec/`](../spec/): the normative text is
[`spec/aetf-spec.zh-CN.md`](../spec/aetf-spec.zh-CN.md), with an English overview
in [`spec/README.md`](../spec/README.md).

AETF 规范正文见 [`spec/aetf-spec.zh-CN.md`](../spec/aetf-spec.zh-CN.md)，英文导读见
[`spec/README.md`](../spec/README.md)。

## Translation policy · 翻译约定

- Chinese is normative. When the two versions disagree about a fact, the Chinese
  text and the JSON Schema are correct.
- Case content is **not** translated. The lures are Chinese office documents;
  translating them would change what is being tested. `case.json` carries
  `labelEn` / `descriptionEn` for titles and summaries only.
- A change to a normative statement should update both languages in the same
  commit. Prose-level improvements to one language may land alone.

- 中文为权威。两版对事实的表述冲突时，以中文与 JSON Schema 为准。
- Case 内容**不翻译**：诱饵是中文办公文档，翻译会改变被测对象。`case.json` 只为标题
  和摘要提供 `labelEn` / `descriptionEn`。
- 涉及规范性表述的改动应在同一个提交里更新两种语言；纯文字润色可以只改一侧。
