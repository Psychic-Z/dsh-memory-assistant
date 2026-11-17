#!/usr/bin/env node
/**
 * 一眼健康检查（2026-11-17）
 *
 * 为什么要有：v0.3.4 加的四个防线（凭据闸门 / pinned 禁改 / stale / 失败留痕）
 * 都要「用一段时间才知道好不好使」。人不会天天翻 jsonl，所以给一个屏。
 *
 * 用法：node tools/mem-health.mjs [--dir <记忆库>]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const di = argv.indexOf('--dir')
const DIR = di >= 0 ? argv[di + 1] : join(homedir(), '.dsh-memory-assistant')

const readJsonl = (name) => {
  const p = join(DIR, name)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const cards = readJsonl('cards.jsonl')
const fails = readJsonl('failures.jsonl')
const asks = readJsonl('ask_log.jsonl')
const fbs = readJsonl('feedback.jsonl')

const pinned = cards.filter((c) => c.pinned)
const stale = cards.filter((c) => c.stale)
const withTopics = cards.filter((c) => (c.topics || []).length)
const cred = fails.filter((f) => /拒绝写入/.test(String(f.message || '')))

const line = (label, value, note = '') => console.log(`  ${label.padEnd(18)} ${String(value).padStart(6)}  ${note}`)

console.log(`\n记忆库健康检查 · ${DIR}`)
console.log(`\n【规模】`)
line('卡片', cards.length)
line('其中有 topics', withTopics.length, `${((withTopics.length / Math.max(cards.length, 1)) * 100).toFixed(0)}%`)
line('pinned（禁改）', pinned.length)
line('stale（过时）', stale.length)

console.log(`\n【使用】`)
line('检索次数', asks.length)
line('反馈条数', fbs.length, fbs.length ? '（有反馈才会调权重）' : '（还没有——权重不会自己长）')

console.log(`\n【防线】`)
line('失败记录', fails.length)
line('其中凭据拦截', cred.length, cred.length ? '（真实拦截次数）' : '（还没拦到过真东西）')
if (fails.length) {
  const recent = fails.slice(-3).reverse()
  for (const f of recent) console.log(`     · ${String(f.ts).slice(5, 16)} ${f.where} — ${String(f.message).slice(0, 50)}`)
}

console.log(`\n【备份】`)
const baks = readdirSync(DIR).filter((f) => f.includes('.bak-'))
line('备份文件', baks.length)
if (baks.length) console.log(`     最近：${baks.sort().slice(-2).join(' / ')}`)

console.log(`\n判读：`)
if (!fbs.length) console.log('  ⚠ 反馈为 0：权重体系在空转（要用一次说一声「对/不对」）')
if (!cred.length) console.log('  · 凭据闸门还没拦到真东西——正常，说明没往记忆里写密钥')
if (!stale.length) console.log('  · 还没有过时标记——遗忘机制未启用过')
console.log('')
