#!/usr/bin/env node
/**
 * 给各领域包起草 `states`（2026-11-17，主人令「都做」）
 *
 * 铁律：**只写能指回出处的状态**，全部标 `status: "draft"` / `verified: false`。
 * 市场数字、持仓数字一律不收——它们会过期，进 states 就变成"库里说现在是这样"。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DIRS = [
  join(homedir(), '.dsh-memory-assistant', 'domains'),
  'C:/Users/ZXC/Coze/Drive/基金投资/vault/共享/领域',
]

const DRAFTS = {
  记忆架构: [
    { text: '检索分三态：精确命中 / 无精确但有相关 / 没有；判「精确」只看字面覆盖，不看分数', as_of: '261115', from: '议题/记忆助理-共享方案.md 轮次 20–23' },
    { text: '卡片只做索引，原文留在会话文件；命中后按指针回原文取那一段', as_of: '261115', from: '共享记忆手册 / 记忆助理设计' },
    { text: '检索开销与库大小无关：只读前 3 张卡 + 一节原文', as_of: '261117', from: '数据/跨库探针/B/dsh.md' },
    { text: '领域是另一条轴：按主题分，只放术语/规则/状态/摘要与指针，不复制原文', as_of: '261117', from: '记忆卡 w:0133 / w:0094' },
  ],
  数据口径: [
    { text: '写基金成绩必须注明「这个数里算不算分红」', as_of: '261115', from: '公告/主人裁定.md 261115' },
    { text: 'B 档收益/回撤引用时必须标后复权口径；用前复权须并列对照', as_of: '261109', from: '规范/调整机制.md §11.1' },
    { text: '两源差异超一跳才报错，每个数要标源与复权', as_of: '261107', from: '记忆卡（交叉校验四条）' },
  ],
  评测实验: [
    { text: '探针回放 6 道（5 有答案 + 1 库内没有），C 配置为首位命中 6/6', as_of: '261117', from: 'bin/mem-probe.mjs' },
    { text: '议题词探针有选择偏差：真实业务词覆盖远低于议题词（实测差 22–35 个百分点）', as_of: '261116', from: '数据/跨库探针/A/round23_business_words_workbuddy.md' },
    { text: '验收指标用 recall@10 里的 content 卡张数，不用 top-3（受并列排序影响）', as_of: '261115', from: '议题/记忆助理-共享方案.md 轮次 21' },
  ],
  工程工具: [
    { text: '插件发版前必须核对三处：package.json 版本 / 面板显示 / Release 说明', as_of: '261117', from: 'README 开发段' },
    { text: '改完必须重启应用；插件热重载不会重新加载模块', as_of: '261117', from: 'README / 三次重启实测' },
    { text: '仓库文件名一律 ASCII（推送脚本不支持中文名）', as_of: '261117', from: 'ROLLBACK.md 改名事件' },
  ],
  协作治理: [
    { text: '跨库只读：别人的库不改；检索用库主自己的词表', as_of: '261115', from: '议题/记忆助理-共享方案.md §一·3' },
    { text: '每轮续写必须报「现在该谁」；主人按这一行决定激活谁', as_of: '261115', from: '议题/记忆助理-共享方案.md 摘要区 E' },
    { text: '请主人裁定：由智能体代笔、用人话、给选项', as_of: '261115', from: '议题/记忆助理-共享方案.md 第 18 条' },
    { text: '重要问题引用主人原话要逐字照抄，转述只能写在原话之后', as_of: '261115', from: '议题/记忆助理-共享方案.md 第 17 条' },
  ],
  写作方法: [
    { text: '文档里给结论要能指回出处；指不回去的不要写', as_of: '261117', from: '本领域规则（跨文档通用）' },
    { text: '疑似笔误保留原文并旁注，不直接改字', as_of: '261115', from: '议题/记忆助理-共享方案.md F 区' },
  ],
  成本: [
    { text: '检索单次约 600–700 token（3 张卡 + 一节原文），与库大小无关', as_of: '261117', from: '数据/跨库探针/B/dsh.md' },
    { text: '全量建索引是一次性成本，按卡片数线性增长', as_of: '261115', from: 'README 成本段' },
  ],
  AI交互: [
    { text: '检索触发分四类：问 / 令 / 述 / 纠，不是只有提问才查', as_of: '261115', from: '记忆卡 w:0554' },
    { text: '动手改一个机制之前，先查「<机制名> 原则」', as_of: '261115', from: 'SKILL 纪律' },
  ],
}

let n = 0
for (const dir of DIRS) {
  if (!existsSync(dir)) continue
  for (const [domain, list] of Object.entries(DRAFTS)) {
    const p = join(dir, `${domain}.json`)
    if (!existsSync(p)) continue
    const pack = JSON.parse(readFileSync(p, 'utf8'))
    pack.slots = pack.slots || {}
    const existing = pack.slots.states || []
    const have = new Set(existing.map((s) => s.text))
    const add = list
      .filter((s) => !have.has(s.text))
      .map((s) => ({ ...s, status: 'draft', verified: false }))
    if (!add.length) continue
    pack.slots.states = [...existing, ...add]
    pack.slots.note = 'states 全部是草稿（status=draft / verified=false）：每条都指回出处，但未替主人确认是否仍成立。'
    writeFileSync(p, JSON.stringify(pack, null, 1), 'utf8')
    console.log(`${dir.includes('vault') ? '共享' : '本地'} ${domain.padEnd(6)} +${add.length} 条`)
    n += add.length
  }
}
console.log(`\n共起草 ${n} 条状态`)
