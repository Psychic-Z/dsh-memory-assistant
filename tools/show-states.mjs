#!/usr/bin/env node
/**
 * 列出所有领域草稿状态（2026-11-17）
 *
 * 用途：主人要「看一遍哪些状态还没确认」。一条命令全列出来，带出处。
 * 用法：
 *   node tools/show-states.mjs                # 只看草稿
 *   node tools/show-states.mjs --all          # 草稿 + 已确认
 *   node tools/show-states.mjs --domain 投资交易
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const dir = arg('--dir', join(homedir(), '.dsh-memory-assistant', 'domains'))
const only = arg('--domain', '')
const all = argv.includes('--all')

if (!existsSync(dir)) {
  console.log('没有领域包：' + dir)
  process.exit(0)
}

const packs = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      return null
    }
  })
  .filter(Boolean)
  .filter((p) => !only || p.domain === only)

let total = 0
let draft = 0
for (const p of packs) {
  const sts = (p.slots && p.slots.states) || []
  const show = all ? sts : sts.filter((s) => s.status === 'draft' || s.verified !== true)
  if (!show.length) continue
  console.log(`\n【${p.domain}】${p.n_cards} 张卡 · ${show.length} 条待确认`)
  for (const [i, s] of show.entries()) {
    const mark = s.verified === true ? '✓已确认' : '⚠草稿'
    console.log(`  ${i + 1}. ${mark} as_of ${s.as_of || '?'}`)
    console.log(`     ${s.text}`)
    console.log(`     出处：${s.from || '（未记）'}`)
    total++
    if (s.verified !== true) draft++
  }
}
console.log(`\n共 ${total} 条，其中待确认 ${draft} 条。`)
console.log('确认方式：告诉我要确认哪几条，我改 verified: true（检索里就不显示「⚠草稿」）。')
