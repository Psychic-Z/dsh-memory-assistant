#!/usr/bin/env node
/**
 * 探针回放：同一批题，跑三种配置，出可比的数字。
 *
 *   A 打码前 + 旧打分：把卡上的 codes 全部抹掉，用改造前的公式（二元组计数，无 idf）
 *   B 打码后 + 旧打分：codes 保留，公式仍然是旧的
 *   C 打码后 + 新打分 + 三态：当前 retrieve.js（idf 加权 + 字面判态）
 *
 * 用法：node bin/mem-probe.mjs [--json]
 * 题目和答案键写在下方 PROBES；改题只改这一处。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scoreCards, textStats, literalState, rankByState, mapConcepts } from '../lib/retrieve.js'

const dataDir = process.env.MEM_DATA_DIR || join(homedir(), '.dsh-memory-assistant')
const cards = readFileSync(join(dataDir, 'cards.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const conceptTable = (() => {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'concepts.json'), 'utf8'))
  } catch {
    return {}
  }
})()

// accept：可以算对的头名（同一件事常有好几张卡）；null = 库里没有，答「没有」才算对
const PROBES = [
  { q: '记忆助理 静默失败', accept: ['w:0660'], why: '不报错、只不生效' },
  { q: '概念表 打码 空正文', accept: ['w:0710'], why: '推理吃满预算' },
  { q: '这个项目什么时候开始做的', accept: ['w:0643', 'w:0644'], why: '两条线起点' },
  { q: '公告板是怎么丢的', accept: ['w:0086'], why: '被清空丢 47 轮' },
  { q: '打码卡在29', accept: ['w:0760', 'w:0739'], why: '两个原因：校验丢卡 / 预算空正文' },
  { q: '量子纠错码 表面码', accept: null, why: '对照题：库里根本没有' },
]

// ── 旧口径（改造前）─────────────────────────────────────────────
// 旧 tokenize：没有功能字过滤
const STOP = new Set(['的', '了', '是', '在', '有', '和', '就', '都', '而', '及', '与', '着', '或', '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '一下', '可以', '需要', '应该'])
function legacyTokens(s) {
  const out = []
  const text = String(s || '').toLowerCase()
  for (const m of text.matchAll(/[a-z][a-z0-9_.#-]{1,}/g)) out.push(m[0])
  for (const seg of text.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    if (seg.length === 1) { if (!STOP.has(seg)) out.push(seg); continue }
    for (let i = 0; i + 1 < seg.length; i++) {
      const bg = seg.slice(i, i + 2)
      if (!STOP.has(bg)) out.push(bg)
    }
  }
  return out
}
function ov(a, b) {
  const s = new Set(b)
  let n = 0
  const seen = new Set()
  for (const t of a) if (!seen.has(t) && s.has(t)) { seen.add(t); n++ }
  return n
}
function legacyScore(list, text) {
  const df = new Map()
  for (const c of list) for (const k of (c.codes?.concept || [])) df.set(k, (df.get(k) || 0) + 1)
  const N = Math.max(list.length, 1)
  const idf = (k) => Math.log(1 + N / Math.max(df.get(k) || 0, 1))
  const q = legacyTokens(text)
  const qConcepts = new Set(mapConcepts(text, conceptTable)) // 旧口径：码由问句里的概念名自动映射
  if (!q.length) return { top: null, ranked: [] }
  const ranked = list
    .map((c) => {
      let s = 0
      for (const k of c.codes?.concept || []) if (qConcepts.has(k)) s += 2.0 * idf(k)
      const body = [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || [])].join(' ')
      const o = ov(q, legacyTokens(body))
      if (o) s += 0.5 * o
      let kw = 0
      for (const k of c.keywords || []) if (ov(q, legacyTokens(String(k))) > 0) kw++
      if (kw) s += 0.8 * Math.min(kw, 3)
      return { key: c.key, title: c.title, score: Number(s.toFixed(3)) }
    })
    .sort((a, b) => b.score - a.score)
  return { top: ranked[0] || null, ranked: ranked.slice(0, 3) }
}

// ── 三种配置 ────────────────────────────────────────────────────
const noCodes = cards.map((c) => ({ ...c, codes: {} }))
const statsNew = textStats(cards)

function runNew(list, text, stats) {
  const q = { text, concepts: [], entities: [] }
  const st = literalState(list, q, { stats })
  const scored = scoreCards(list, q, { stats })
  const picked = rankByState(st, scored, { top: 3, floor: 6 })
  return {
    state: st.state,
    top: picked[0] ? { key: picked[0].card.key, title: picked[0].card.title, score: picked[0].score } : null,
    ranked: picked.map((s) => s.card.key),
    st,
  }
}

const rows = []
for (const p of PROBES) {
  const A = legacyScore(noCodes, p.q)
  const B = legacyScore(cards, p.q)
  const C = runNew(cards, p.q, statsNew)
  const emptyOk = p.accept === null
  const hit1 = (cfg) => {
    if (emptyOk) return cfg === 'C' ? C.state === 'none' : false
    if (cfg === 'C') return !!C.top && p.accept.includes(C.top.key)
    const t = cfg === 'A' ? A.top : B.top
    return !!t && p.accept.includes(t.key)
  }
  const hit3 = (cfg) => {
    if (emptyOk) return cfg === 'C' ? C.state === 'none' : false
    const keys = cfg === 'A' ? A.ranked.map((x) => x.key) : cfg === 'B' ? B.ranked.map((x) => x.key) : C.ranked
    return p.accept.some((k) => keys.includes(k))
  }
  rows.push({
    q: p.q,
    accept: p.accept,
    A: { hit: hit1('A'), hit3: hit3('A'), top: A.top },
    B: { hit: hit1('B'), hit3: hit3('B'), top: B.top },
    C: { hit: hit1('C'), hit3: hit3('C'), state: C.state, top: C.top },
  })
}

const rate = (k, which = 'hit') => rows.filter((r) => r[k][which]).length

// ── 极性回归：否定问句必须被标注出来（哪怕结果照给）──────────────
const NEG_PROBES = [
  { q: '公告板 没删', forbid: ['w:0086'] },
  { q: '背景图 没删', forbid: ['w:0112'] },
  { q: '打码 没卡住', forbid: ['w:0739', 'w:0760'] },
  { q: '建表 没出错', forbid: ['w:0710'], expectFlag: false }, // 命中的卡本身带「无」，不该误报冲突
  { q: '打码 还没做完', forbid: [] },
  { q: '这个项目 还没开始', forbid: ['w:0643', 'w:0644'] },
]
const negRows = NEG_PROBES.map((p) => {
  const out = runNew(cards, p.q, statsNew)
  const top = out.top ? out.top.key : null
  const flagged = !!(out.st && out.st.qNeg && top && out.st.polarityMismatch && out.st.polarityMismatch.has(top))
  return { ...p, top, flagged, state: out.state }
})
const negPass = negRows.filter((r) => r.flagged === (r.expectFlag !== false)).length

const isJson = process.argv.includes('--json')
if (isJson) {
  console.log(
    JSON.stringify(
      {
        probes: rows.length,
        hit1: { A: rate('A'), B: rate('B'), C: rate('C') },
        hit3: { A: rate('A', 'hit3'), B: rate('B', 'hit3'), C: rate('C', 'hit3') },
        polarity: { total: negRows.length, flagged: negPass, rows: negRows },
        rows,
      },
      null,
      1,
    ),
  )
} else {
  const line = (r) => {
    const fmt = (x) => (x.top ? `${x.hit ? '✓' : '✗'} ${x.top.key} ${x.top.title.slice(0, 18)}` : `${x.hit ? '✓' : '✗'} （空）`)
    return `${r.q.padEnd(16, '　')} | ${fmt(r.A)} | ${fmt(r.B)} | ${r.C.state === 'exact' ? '' : '[' + r.C.state + '] '}${fmt(r.C)}`
  }
  process.stdout.write(`探针回放（${rows.length} 道：${PROBES.filter((p) => p.accept).length} 道有答案 + ${PROBES.filter((p) => !p.accept).length} 道库里没有）\n\n`)
  process.stdout.write(
    `命中@1：A 打码前+旧 ${rate('A')}/${rows.length}　B 打码后+旧 ${rate('B')}/${rows.length}　C 打码后+新+三态 ${rate('C')}/${rows.length}\n` +
      `命中@3：A ${rate('A', 'hit3')}/${rows.length}　B ${rate('B', 'hit3')}/${rows.length}　C ${rate('C', 'hit3')}/${rows.length}\n` +
      `极性标注：${negPass}/${negRows.length}（否定问句里，被标出「库里记的是肯定」的句数）\n\n`,
  )
  process.stdout.write('题目 | A 打码前+旧 | B 打码后+旧 | C 打码后+新\n')
  for (const r of rows) process.stdout.write(line(r) + '\n')
  process.stdout.write('\n否定问句（只要求被标注，不要求改答案）：\n')
  for (const r of negRows) {
    const want = r.expectFlag !== false
    const ok = r.flagged === want
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${r.q} → ${r.top || '（空）'} [${r.state}]${want ? '' : '（卡本身带否定，不该误报）'}\n`)
  }
  process.stdout.write('\n（[related]/[none] 是 C 判出的状态；A/B 没有状态，只有分数。「空」= 判成没有这块记忆）\n')
}
