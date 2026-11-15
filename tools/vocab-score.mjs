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
const AGG = arg('--agg', '')   // 互评模式：读 <agg>/词表评分/评价日志/*.jsonl
const OUT = arg('--out', '')
const BY = arg('--by', 'deepseek-harness')
const HALF_LIFE_DAYS = 90
const MIN_SAMPLES = 5

const cards = readFileSync(join(DIR, 'cards.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byKey = new Map(cards.map((c) => [c.key, c]))

// 261115 主人校正：评的是「对照表里的关键词」，不是卡片上的关键词。
// 对照表 = concepts.json 的 name + aliases。只有出现在问句里、且属于对照表的词才计分。
const concepts = JSON.parse(readFileSync(join(DIR, 'concepts.json'), 'utf8'))
const tableTerms = new Set()
const termToCode = new Map()
for (const [code, v] of Object.entries(concepts)) {
  for (const t of [v.name, ...(v.aliases || [])].filter(Boolean)) {
    tableTerms.add(t)
    if (!termToCode.has(t)) termToCode.set(t, code)
  }
}

// ask_log：用于把「这次检索用了哪些对照表词」复原出来
const asks = []
const askPath2 = join(DIR, 'ask_log.jsonl')
if (existsSync(askPath2)) {
  for (const line of readFileSync(askPath2, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      asks.push(JSON.parse(line))
    } catch {}
  }
}
const findAsk = (key, ts) => {
  const t = Date.parse(ts || 0)
  let best = null
  for (const a of asks) {
    if (!(a.top || []).some((x) => x.key === key)) continue
    const d = Math.abs(Date.parse(a.ts) - t)
    if (d > 10 * 60 * 1000) continue // 只认 10 分钟内的那次检索
    if (!best || d < best.d) best = { d, a }
  }
  return best && best.a
}

const now = Date.now()
const decay = (ts) => {
  const d = (now - Date.parse(ts || 0)) / 86400000
  return Math.pow(0.5, Math.max(0, d) / HALF_LIFE_DAYS)
}

// term -> {good, bad, w}
const stats = new Map()
// 共享层用细刻度：不同判决给不同权重，最后归一化到 0–1（三位小数）
const VALUE = { good: 1.0, partial: 0.3, bad: -1.0, worst: -2.0 }
const bump = (term, credit, w) => {
  const s = stats.get(term) || { pos: 0, neg: 0, w: 0, n: 0 }
  if (credit >= 0) s.pos += credit * w
  else s.neg += -credit * w
  s.w += w
  s.n += 1
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
    if (!byKey.has(r.key)) continue
    const ask = findAsk(r.key, r.ts)
    if (!ask) continue // 复原不出那次检索用了哪些词 → 不记分（宁缺勿错）
    rows++
    const w = decay(r.ts)
    // 判决 → 分值：好 +1.0 / 部分对 +0.3 / 错 -1.0 / 全错 -2.0
    const kind = !r.verdict || r.verdict === 'good'
      ? 'good'
      : r.verdict === 'partial'
        ? 'partial'
        : /(完全不对|彻底错|全错|一点都不对)/.test(r.note || '')
          ? 'worst'
          : 'bad'
    const q = typeof ask.q === 'string' ? ask.q : (ask.q && ask.q.text) || ''
    // 只给「出现在问句里 + 属于对照表」的词记分
    for (const t of tableTerms) {
      if (q.includes(t)) bump(t, VALUE[kind], w)
    }
  }
}

const terms = {}
let scored = 0
for (const [t, s] of [...stats.entries()].sort((a, b) => b[1].w - a[1].w)) {
  const n = s.n
  const ok = n >= MIN_SAMPLES
  const raw = s.pos - s.neg                       // 净得分（可正可负）
  const span = Math.max(1, s.pos + s.neg)         // 归一化分母
  const norm = span ? raw / span : 0              // -1..1
  terms[t] = {
    code: termToCode.get(t) || null,
    n,
    net: Number(raw.toFixed(3)),
    w: Number(s.w.toFixed(3)),
    score: ok ? Number(((norm + 1) / 2).toFixed(3)) : null, // 0..1，三位小数
    note: ok ? '' : `样本不足（${n}/${MIN_SAMPLES}）`,
  }
  if (ok) scored++
}

// ── 互评聚合模式（261115 主人：对照表由用它的智能体打分）──────────
if (AGG) {
  const { readdirSync, existsSync: ex } = await import('node:fs')
  const { join: jn } = await import('node:path')
  const logDir = jn(AGG, '词表评分', '评价日志')
  const byOwner = new Map()   // owner -> term -> {pos,neg,n,raters:Set}
  const rowsAll = []
  if (ex(logDir)) {
    for (const f of readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(jn(logDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        let r
        try { r = JSON.parse(line) } catch { continue }
        rowsAll.push(r)
        const owner = r.table_owner
        if (!owner) continue
        const w = Math.pow(0.5, Math.max(0, (Date.now() - Date.parse(r.ts)) / 86400000) / HALF_LIFE_DAYS)
        const m = byOwner.get(owner) || new Map()
        const t = m.get(r.term) || { pos: 0, neg: 0, n: 0, raters: new Set(), code: r.code || null }
        const v = { good: 1.0, partial: 0.3, bad: -1.0, worst: -2.0 }[r.verdict] ?? 0
        if (v >= 0) t.pos += v * w; else t.neg += -v * w
        t.n += 1
        t.raters.add(r.rater)
        m.set(r.term, t)
        byOwner.set(owner, m)
      }
    }
  }
  for (const [owner, m] of byOwner) {
    const terms = {}
    let scoredN = 0
    for (const [term, t] of [...m.entries()].sort((a, b) => (b[1].pos + b[1].neg) - (a[1].pos + a[1].neg))) {
      const ok = t.n >= MIN_SAMPLES
      const span = Math.max(1, t.pos + t.neg)
      const norm = (t.pos - t.neg) / span
      terms[term] = {
        code: t.code,
        n: t.n,
        net: Number((t.pos - t.neg).toFixed(3)),
        raters: [...t.raters],
        score: ok ? Number(((norm + 1) / 2).toFixed(3)) : null,
        note: ok ? '' : `样本不足（${t.n}/${MIN_SAMPLES}）`,
      }
      if (ok) scoredN++
    }
    const o = {
      by: owner, updated: new Date().toISOString(), source: 'agent-ratings',
      half_life_days: HALF_LIFE_DAYS, min_samples: MIN_SAMPLES,
      n_ratings: rowsAll.filter((r) => r.table_owner === owner).length,
      n_terms: Object.keys(terms).length, n_terms_scored: scoredN, terms,
    }
    const outPath = jn(AGG, '词表评分', `${owner}.json`)
    writeFileSync(outPath, JSON.stringify(o, null, 1), 'utf8')
    console.log(`${owner}: 评 ${o.n_ratings} 条 / ${o.n_terms} 词 / 出分 ${scoredN} → ${outPath}`)
  }
  process.exit(0)
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
