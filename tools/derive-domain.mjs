#!/usr/bin/env node
/**
 * 从卡片所挂的概念码反推「领域」，写到卡的 domain 字段。
 *
 * 2026-11-17：领域库设计是「领域是另一条轴，按主题分，只放专有内容与指针」。
 * 但卡片上一直没有 domain —— 检索也就没法按领域收窄。
 * 99% 的卡挂了概念码，每个概念都有 domain，所以可以直接反推。
 *
 * 用法：node tools/derive-domain.mjs [--dry]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const H = join(homedir(), '.dsh-memory-assistant')
const DRY = process.argv.includes('--dry')

const concepts = JSON.parse(readFileSync(join(H, 'concepts.json'), 'utf8'))
const cards = readFileSync(join(H, 'cards.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

let changed = 0
let derived = 0
const dist = {}
for (const c of cards) {
  if (c.domain) continue
  const ids = (c.codes && c.codes.concept) || []
  const tally = {}
  for (const id of ids) {
    const d = concepts[id] && concepts[id].domain
    if (d) tally[d] = (tally[d] || 0) + 1
  }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]
  if (!best) continue
  c.domain = best[0]
  derived++
  changed++
}

for (const c of cards) if (c.domain) dist[c.domain] = (dist[c.domain] || 0) + 1

console.log(`反推出领域 ${derived} 张（共 ${cards.length} 张）`)
console.log('领域分布：')
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}`)
}
const noDomain = cards.filter((c) => !c.domain).length
if (noDomain) console.log(`  没法定领域：${noDomain} 张（没挂码或码无 domain）`)

if (DRY) process.exit(0)
if (!changed) {
  console.log('没有要改的')
  process.exit(0)
}
const bak = join(H, `cards.jsonl.bak-domain-${Date.now()}`)
copyFileSync(join(H, 'cards.jsonl'), bak)
writeFileSync(join(H, 'cards.jsonl'), cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
console.log('已写入（备份 ' + bak + '）')
