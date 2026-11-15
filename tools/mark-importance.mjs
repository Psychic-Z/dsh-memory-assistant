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

const STRONG = ['原则', '铁律', '纪律', '规矩', '必须', '不许', '不准', '只准', '永远', '一律', '禁止']
const ECHO = ['我说过', '以前说过', '之前说过', '重申', '再次强调', '反复强调', '我讲过', '说过了']

const textOf = (c) => [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || [])].filter(Boolean).join(' ')

// 261115 主人：5 分制太粗，按 0.x 增减。
function score(c) {
  const t = textOf(c) + ' ' + (c.pointer?.quote || '')
  let s = 1
  let hits = 0
  for (const w of STRONG) if (t.includes(w)) hits++
  s += Math.min(0.6, hits * 0.2)                    // 每个强调词 +0.2，封顶 +0.6
  if (ECHO.some((w) => t.includes(w))) s += 0.2     // 用户说过「我说过/以前说过」
  return s
}
const round2 = (x) => Math.round(x * 100) / 100

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
const cards = readFileSync(CARDS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const dist = {}
for (const c of cards) {
  // pinned 卡（用户明示「记住这条」）保底 5，不被自动打分压低
  const h = hits.get(c.key) || 0
  const bonus = Math.min(0.5, h * 0.05)          // 每次被检索 +0.05，封顶 +0.5
  let imp = score(c) + bonus
  if (c.pinned) imp = Math.max(imp, 3.5)         // pinned 保底 3.5（进「核心」档）
  c.importance = round2(Math.min(5, Math.max(1, imp)))
  c.hits = h
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
