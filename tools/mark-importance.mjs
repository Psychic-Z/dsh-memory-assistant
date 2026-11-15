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

function score(c) {
  const t = textOf(c) + ' ' + (c.pointer?.quote || '')
  let s = 1
  let hits = 0
  for (const w of STRONG) if (t.includes(w)) hits++
  if (hits >= 1) s += 2
  if (hits >= 3) s += 1
  if (hits >= 5) s += 1
  if (ECHO.some((w) => t.includes(w))) s += 1
  return Math.min(5, s)
}

const cards = readFileSync(CARDS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const dist = {}
for (const c of cards) {
  // pinned 卡（用户明示「记住这条」）保底 5，不被自动打分压低
  if (c.pinned) { c.importance = 5; }
  else c.importance = score(c)
  dist[c.importance] = (dist[c.importance] || 0) + 1
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
