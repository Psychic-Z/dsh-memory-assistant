#!/usr/bin/env node
/**
 * 领域包生成（2026-11-17）
 *
 * 设计依据（记忆卡 w:0133 / 领域轴）：**领域是另一条轴，按主题分，只放专有内容与指针，不复制原文。**
 *
 * 所以一个领域包里有四样，都**不含原文正文**：
 *   1. terms  —— 该领域的术语表（概念主名 + 别名，来自对照表）
 *   2. codes  —— 该领域的概念码
 *   3. entries—— 该领域的卡指针（key/title/one_line/pointer），供「先看有哪些」再回原文
 *   4. slots  —— 规则 / 状态 / 摘要 三个空槽，等人工或模型填（不自动编）
 *
 * 用法：
 *   node tools/domain-pack.mjs --out <目录>           # 全部领域
 *   node tools/domain-pack.mjs --out <目录> --domain 投资交易
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const H = join(homedir(), '.dsh-memory-assistant')
const OUT = arg('--out', join(H, 'domains'))
const ONLY = arg('--domain', '')

const concepts = JSON.parse(readFileSync(join(H, 'concepts.json'), 'utf8'))
const cards = readFileSync(join(H, 'cards.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const byDomain = new Map()
for (const [id, v] of Object.entries(concepts)) {
  const d = v.domain || '未分类'
  if (!byDomain.has(d)) byDomain.set(d, { codes: [], terms: new Set() })
  const box = byDomain.get(d)
  box.codes.push(id)
  if (v.name) box.terms.add(v.name)
  for (const a of v.aliases || []) if (a && String(a).length >= 2) box.terms.add(a)
}

mkdirSync(OUT, { recursive: true })
let wrote = 0
for (const [domain, box] of byDomain) {
  if (ONLY && domain !== ONLY) continue
  const mine = cards.filter((c) => c.domain === domain)
  let prevSlots = null
  try {
    prevSlots = JSON.parse(readFileSync(join(OUT, `${domain}.json`), 'utf8')).slots || null
  } catch {}
  const pack = {
    domain,
    updated: new Date().toISOString().slice(0, 10),
    n_cards: mine.length,
    codes: box.codes.sort(),
    terms: [...box.terms].sort(),
    // 规则 / 状态 / 摘要：三个空槽，等填。**不自动生成**——编出来的领域知识比没有更糟。
    // 重生成时保留已填的 slots（人工/裁定内容不能被冲掉）
    slots: prevSlots && (prevSlots.rules?.length || prevSlots.states?.length)
      ? prevSlots
      : { rules: [], states: [], summaries: [] },
    entries: mine
      .slice()
      .sort((a, b) => (b.importance || 1) - (a.importance || 1))
      .slice(0, 40)
      .map((c) => ({
        key: c.key,
        title: c.title,
        one_line: c.one_line,
        importance: c.importance || 1,
        pointer: c.pointer || null,
      })),
  }
  writeFileSync(join(OUT, `${domain}.json`), JSON.stringify(pack, null, 1), 'utf8')
  console.log(`${domain.padEnd(10)} 卡 ${String(pack.n_cards).padStart(4)} · 码 ${String(pack.codes.length).padStart(3)} · 术语 ${String(pack.terms.length).padStart(4)} · 入口 ${pack.entries.length}`)
  wrote++
}
console.log(`\n写了 ${wrote} 个领域包 → ${OUT}`)
