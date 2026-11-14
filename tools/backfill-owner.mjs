#!/usr/bin/env node
/**
 * 给已有卡片回填 owner / platform（谁写的、跑在哪个平台）。
 *
 *   node tools/backfill-owner.cjs --data "C:/Users/ZXC/.dsh-memory-assistant" \
 *        [--owner deepseek-harness] [--platform dsh] [--dry]
 *
 * 只补缺失的字段，已有值一律不动。写之前自动备份成 cards.jsonl.bak-<时间>。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n)
  if (i < 0) return d
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const flag = (n) => process.argv.includes('--' + n)

const dataDir = String(arg('data', join(process.env.HOME || process.env.USERPROFILE, '.dsh-memory-assistant')))
const owner = String(arg('owner', 'deepseek-harness'))
const platform = String(arg('platform', 'dsh'))
const dry = flag('dry')

const cardsPath = join(dataDir, 'cards.jsonl')
if (!existsSync(cardsPath)) {
  console.error('找不到 ' + cardsPath)
  process.exit(1)
}

const lines = readFileSync(cardsPath, 'utf8').split('\n').filter(Boolean)
let touched = 0
const out = lines.map((line) => {
  let c
  try {
    c = JSON.parse(line)
  } catch {
    return line
  }
  let changed = false
  if (!c.owner) {
    c.owner = owner
    changed = true
  }
  if (!c.platform) {
    c.platform = platform
    changed = true
  }
  if (changed) touched++
  return changed ? JSON.stringify(c) : line
})

console.log(`卡片 ${lines.length} 张，需要回填 ${touched} 张（owner=${owner}, platform=${platform}）`)
if (dry) {
  const sample = out.find((l, i) => lines[i] !== l)
  console.log('--dry：未写入。样例：' + (sample ? sample.slice(0, 200) : '（无）'))
  process.exit(0)
}
if (!touched) {
  console.log('无需改动')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = cardsPath + '.bak-' + stamp
copyFileSync(cardsPath, backup)
writeFileSync(cardsPath, out.join('\n') + '\n')
console.log('已写入，备份：' + backup)
