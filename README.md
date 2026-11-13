# 记忆助理 · dsh-memory-assistant

把过去的对话整理成**记忆卡片**，需要时用关键词检索定位，再回到原始对话取时间、原话和上下文。
**找不到就说找不到，不确定就追问，不编。**

适合这些场合：用户说「当初」「上次」「之前那个」，要具体日期/数字/原话，或者要引用旧决定。

---

## 它怎么工作

```
写入端：对话 → 切成段 → 每段抽 1–3 张卡（标题 / 一句话 / 三行大纲 / 关键词 / 段号）
检索端：2–3 个关键词 → 卡片打分（关键词 + 全文 + 概念码）→ 「精确 / 相关 / 没有」三态
读出端：命中就回原文取那一段；没命中就说没找到，或追问
```

卡片本身**不存日期**，只存「哪一段」；要时间就按段号回原文取——**一处真源，不会两处打架**。

## 三态输出

| 状态 | 含义 | 助手怎么做 |
|---|---|---|
| **精确命中** | 问句里的名词都出现在同一张卡上 | 回原文，直接答，带出处 |
| **无精确命中** | 没有卡讲到同一件事，但有几张沾到一两个词 | 明说「没找到 X，但提到 Y 的有这几件」，再问一句 |
| **没有** | 这些词库里从没出现过 | 反问，不拿相近话题凑 |

判「精确」**只看字面**，不看分数——分数会被概念码抬高，这正是「自信地答错」的来源。

## 安装

在 DSH 的 **设置 → 插件** 里搜索 `dsh-memory-assistant` 安装，或：

```bash
dsh plugin --profile desktop add dsh-memory-assistant
```

装完重启 DSH，设置页会出现「记忆助理」一栏。

## 第一次用

1. 打开 设置 → 记忆助理 → **只整理当前对话**（先拿一小批验证）
2. 确认能看到卡片数、关键词数
3. 回到对话里问一件刚聊过的事，看它能不能定位

全部对话整理会按段调模型，**按实际用量计费**；每整理完一段就落盘，可以随时暂停、下次接着来。

## 隐私与存储

- 只读 `~/.dsh/sessions` 里的会话文件，**不改动任何对话**
- 卡片、日志、概念表都存本地：`~/.dsh-memory-assistant`（可在设置里改目录）
- 检索本身**不调模型**，0 token；只有整理新对话和建关键词表时才调
- 附件只记「名字 + 大小」一行，内容不入库

## 成本

单张卡约 40 token。检索 0 token，花的是读片段 1–2k。
中等场景（300 条记忆 / 10 万字 / 每天 20 轮）一个月约 18 万 token，比常驻摘要省约 5 倍。

## 命令

```bash
mem recall "公告板 怎么丢的" --top 3      # 检索（三态 + 候选）
mem feedback --key w:0086 --verdict good  # 记一条满意度
mem stats                                 # 卡片数 / 查询数 / 需追问率 / 满意率
mem import status                         # 导入进度
mem concepts audit --tier B               # 关键词体检（只看不改）
mem concepts restore --v 12               # 回滚到某个历史版本
```

`mem` 不在 PATH 时，直接跑 `node <插件目录>/bin/mem.js`。

## 开发

```bash
node --check lib/*.js bin/*.js client.js
node bin/mem-probe.mjs        # 6 道探针回放，对比三种配置的命中率
```

- 数据：`~/.dsh-memory-assistant/{cards.jsonl, ask_log.jsonl, feedback.jsonl, concepts.json}`
- 卡片字段：`key / title / one_line / outline[3] / keywords[3-6] / codes / entities / pointer{u,quote,project}`
- 修改概念表一律走 `writeConcepts()`：先备份 `concepts.bak-vN.json`，版本 +1

## 许可

MIT
