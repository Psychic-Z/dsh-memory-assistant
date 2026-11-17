# 回滚指南（v0.3.4 四条改动）

> 2026-11-17 · 这版加的四件事都是「防线」，但防线自己也可能出错。
> 下面每条都写了**怎么单独关掉它**，不必整体回退。

## 0. 整体回退到 v0.3.3

```bash
cd memory-assistant
git revert dbc997c --no-edit     # 撤销 0.3.4 那一次提交
git tag -f v0.3.3-revert && git push --tags
```

数据文件不受影响（改动全是读时行为，没有批量改写）。

## 1. 凭据闸门挡住了正常内容（误杀）

**症状**：写卡时报「没写：这张卡里疑似含…」，但内容确实是正常的。

成因多半是这两条太宽：

- `内网 IP`：`192.168.x.x` 这类在技术笔记里很常见
- `疑似口令赋值`：`token = xxx` 这种写法也会被拦

**单独关掉某一条**：编辑 `lib/guard.js` 的 `PATTERNS`，把那行注释掉即可。例如：

```js
  // ['内网 IP', /\b(?:10\.\d{1,3}|...)\b/],
```

**整条闸门关掉**：`lib/store.js` 里 `appendCard` 的 `if (!chk.ok) {...}` 整段删掉。
（不建议——这是唯一防「凭据进记忆」的东西。）

## 2. pinned 卡不更新了

**症状**：跑了 `mark-importance` 之后，某张 pin 过的卡权重/关键词没变。

**这是设计如此**，不是 bug。要改它，先 `mem stale`？不行——正确做法是**先 unpin**：

```bash
node tools/pin.mjs --key w:xxx --off   # 若没有该脚本，手工改 cards.jsonl 里 pinned: false
node tools/mark-importance.mjs
```

## 3. stale 标错了，想把卡救回来

```bash
mem stale --key <卡号> --undo
```

条目一直在库里，`--undo` 只删 `stale` 与 `stale_since` 两个字段，不动内容。

## 4. 失败留痕写了太多行

`failures.jsonl` 只增不改，目前只保留读取时最近 500 条（读端截断），文件本身不轮转。

想清空：

```bash
rm ~/.dsh-memory-assistant/failures.jsonl
```

**不建议**——它是唯一能回答「上次为什么没工作」的东西。

## 5. 验证这版没把检索弄坏

任何改动之后都跑一次：

```bash
node bin/mem-probe.mjs        # 期望：C 6/6（首位命中）
```

`6/6` 掉了就说明动到了判态逻辑，优先怀疑第 4 条（stale 判定）和第 1 条（闸门误判）。
