#!/usr/bin/env node
/**
 * 给卡片打「重要度」（importance 1–5 + pinned）。
 *
 * 依据（261115 主人：用户反复强调的记忆要加权）：
 *   1. 强调词：原则 / 必须 / 不许 / 永远 / 铁律 / 纪律 / 规矩 / 只准 / 不准 / 记住
 *   2. 反复性：同一张卡里出现多次强调词，或同一主张在多张卡里重复（用关键词粗判）
 *   3. 主人明示过的规则（「我说过」「以前说过」「重申」）
 *
 * 用法：
 *   node tools/mark-importance.mjs --dir <记忆库> [--dry]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const DIR = dirArg >= 0 ? args[dirArg + 1] : join(homedir(), '.dsh-memory-assistant')
const DRY = args.includes('--dry')
const CARDS = join(DIR, 'cards.jsonl')

// 261115 主人：分级。极强词直接拉满；普通强调逐步加，不一下加满。
const LEGEND = ['铁律', 'P0', 'p0', '一票否决', '绝对不能', '永远不许', '底线规则']
const STRONG = ['原则', '纪律', '规矩', '记住', '以后都', '不准', '不许', '禁止', '必须', '只准']
const MEDIUM = ['重要', '注意', '别忘了', '关键', '重点', '务必']
const ECHO = ['我说过', '以前说过', '之前说过', '重申', '再次强调', '反复强调', '我讲过', '说过了', '又说一遍', '再强调']
// 语气标记：感叹、绝对化副词——都是「这话他当回事」的信号
const TONE = ['！', '!', '千万', '一定', '绝对', '务必', '真的']

const textOf = (c) => [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || [])].filter(Boolean).join(' ')

// 261115 主人：5 分制太粗，按 0.x 增减。
function score(c) {
  const t = textOf(c) + ' ' + (c.pointer?.quote || '')
  // 特殊情况：铁律 / P0 这类词，直接给满，不按常规累加
  if (LEGEND.some((w) => t.includes(w))) return 5
  let s = 1
  let strong = 0
  for (const w of STRONG) if (t.includes(w)) strong++
  let medium = 0
  for (const w of MEDIUM) if (t.includes(w)) medium++
  s += Math.min(0.8, strong * 0.2 + medium * 0.1)   // 强调：0.2 级，封顶 +0.8
  if (ECHO.some((w) => t.includes(w))) s += 0.2     // 「我说过 / 又说一遍」
  if (TONE.some((w) => t.includes(w))) s += 0.1     // 语气：感叹、千万、一定
  return Math.min(2.5, s)                           // 常规路径最多 2.5 —— 不一下加满
}
const round3 = (x) => Math.round(x * 1000) / 1000
const round2 = round3

// 检索命中次数（261115）：被反复检索到的卡 = 真的有人需要它 → 自动提权。
const hits = new Map()
const askPath = join(DIR, 'ask_log.jsonl')
if (existsSync(askPath)) {
  for (const line of readFileSync(askPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      for (const t of JSON.parse(line).top || []) hits.set(t.key, (hits.get(t.key) || 0) + 1)
    } catch {}
  }
}
// 用户反馈（261115）：肯定 +0.1 / 「不完全」-0.05 / 「不是这个」-0.3（更重的 -1.0）
const fbDelta = new Map()
const fbPath = join(DIR, 'feedback.jsonl')
if (existsSync(fbPath)) {
  for (const line of readFileSync(fbPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.key && typeof r.delta === 'number') fbDelta.set(r.key, (fbDelta.get(r.key) || 0) + r.delta)
    } catch {}
  }
}

const cards = readFileSync(CARDS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const dist = {}
for (const c of cards) {
  // 2026-11-17：pinned 卡**整张不动** —— 重要度、关键词、反馈累计都不碰。
  // 借鉴 memfuse：用户明示过的记忆永不被自动改写（只补统计字段）。
  if (c.pinned) {
    c.importance = c.importance || 5
    if (c.hits == null) c.hits = 0
    dist['pinned'] = (dist['pinned'] || 0) + 1
    continue
  }
  const h = hits.get(c.key) || 0
  const bonus = Math.min(0.5, h * 0.05)          // 每次被检索 +0.05，封顶 +0.5
  const fb = Math.max(-1.5, Math.min(1.5, fbDelta.get(c.key) || 0))   // 反馈累计，封顶 ±1.5
  let imp = score(c) + bonus + fb
  if (c.pinned) imp = Math.max(imp, 3.5)         // pinned 保底 3.5（进「核心」档）
  c.importance = round3(Math.min(5, Math.max(1, imp)))
  c.hits = h
  c.feedback_delta = round2(fb)
  // 261115 主人：把权重记进关键词——这样它能被「筛选」用到，也能被人一眼看见。
  // 档位：≥4.0 → 核心；≥3.0 → 重要；其余不带标记
  const kws = (c.keywords || []).filter((k) => k !== '核心' && k !== '重要')
  if (c.importance >= 3) kws.push('核心')
  else if (c.importance >= 1.15) kws.push('重要')
  c.keywords = kws
  const b = c.importance < 1.2 ? '1.0–1.2' : c.importance < 1.6 ? '1.2–1.6' : c.importance < 2.2 ? '1.6–2.2' : c.importance < 3 ? '2.2–3.0' : '≥3.0'
  dist[b] = (dist[b] || 0) + 1
}
console.log('重要度分布：', JSON.stringify(dist))
console.log('样例（重要度 ≥4）：')
for (const c of cards.filter((c) => c.importance >= 4).slice(0, 5)) {
  console.log('  ' + c.importance + ' · ' + (c.title || '').slice(0, 30) + ' · ' + (c.keywords || []).slice(0, 3).join(','))
}

if (DRY) process.exit(0)
const bak = CARDS + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(CARDS, bak)
writeFileSync(CARDS, cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
console.log('已写入 ' + CARDS + '（备份 ' + bak + '）')
