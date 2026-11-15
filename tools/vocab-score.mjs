#!/usr/bin/env node
/**
 * 对照表评分（261115 主人）：用检索准确度给「词表里的每个词」打可信度。
 *
 * 数据来源：
 *   - ask_log.jsonl：哪些卡被检索出来过
 *   - feedback.jsonl：用户说命中/不命中（带原话与 delta）
 * 归因方式：卡片得分 → 记到这张卡的关键词上（核心/重要是档位标记，不参与）
 *
 * 输出（共享层，别人可读，但只有库主能写）：
 *   共享/数据/词表评分/<agent>.json
 *
 * 规则：
 *   - 样本 < 5 不出分（写 null），避免「一次错就判死」
 *   - 半衰期 90 天（按反馈时间线性衰减权重）
 *   - score = (good - bad) / (good + bad)，范围 -1..1；映射到 0..1 显示
 *
 * 用法：node tools/vocab-score.mjs --dir <记忆库> --out <输出json> --by <agent>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const DIR = arg('--dir', join(homedir(), '.dsh-memory-assistant'))
const OUT = arg('--out', '')
const BY = arg('--by', 'deepseek-harness')
const HALF_LIFE_DAYS = 90
const MIN_SAMPLES = 5

const cards = readFileSync(join(DIR, 'cards.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byKey = new Map(cards.map((c) => [c.key, c]))

const now = Date.now()
const decay = (ts) => {
  const d = (now - Date.parse(ts || 0)) / 86400000
  return Math.pow(0.5, Math.max(0, d) / HALF_LIFE_DAYS)
}

// term -> {good, bad, w}
const stats = new Map()
const bump = (term, kind, w) => {
  const s = stats.get(term) || { good: 0, bad: 0, w: 0 }
  s[kind] += w
  s.w += w
  stats.set(term, s)
}

const fbPath = join(DIR, 'feedback.jsonl')
let rows = 0
if (existsSync(fbPath)) {
  for (const line of readFileSync(fbPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const c = byKey.get(r.key)
    if (!c) continue
    rows++
    const w = decay(r.ts)
    const kind = (r.delta || 0) >= 0 ? 'good' : 'bad'
    for (const k of c.keywords || []) {
      if (k === '核心' || k === '重要') continue
      bump(k, kind, w)
    }
  }
}

const terms = {}
let scored = 0
for (const [t, s] of [...stats.entries()].sort((a, b) => b[1].w - a[1].w)) {
  const n = s.good + s.bad
  const ok = n >= MIN_SAMPLES
  const raw = n ? (s.good - s.bad) / n : null
  terms[t] = {
    n: Number(n.toFixed(2)),
    good: Number(s.good.toFixed(2)),
    bad: Number(s.bad.toFixed(2)),
    score: ok ? Number(((raw + 1) / 2).toFixed(3)) : null, // 0..1
    note: ok ? '' : `样本不足（${n.toFixed(1)}/${MIN_SAMPLES}）`,
  }
  if (ok) scored++
}

const out = {
  by: BY,
  updated: new Date().toISOString(),
  half_life_days: HALF_LIFE_DAYS,
  min_samples: MIN_SAMPLES,
  n_feedback_rows: rows,
  n_terms_total: Object.keys(terms).length,
  n_terms_scored: scored,
  terms,
}

console.log(`反馈 ${rows} 条｜涉及词 ${Object.keys(terms).length} 个｜出分 ${scored} 个（样本 ≥${MIN_SAMPLES}）`)
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8')
  console.log('已写入 ' + OUT)
}
