/**
 * 概念表的版本化与维护。
 *
 * 约定：
 * - concepts.json 仍然是「扁平 map」{C001:{domain,name,aliases}}，检索端照旧读它，格式不变；
 * - 版本号单独放 concepts.meta.json（{version, updatedAt, reason, concepts}），不污染码表；
 * - 每次改表先备份成 concepts.bak-v<N>.json，再写新表；
 * - 合并两个码时同步迁移卡片上的码（旧码 → 新码），卡片原文件也先备份。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const readJson = (p, d) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return d
  }
}

export const readConcepts = (dataDir) => readJson(join(dataDir, 'concepts.json'), {})
export const readMeta = (dataDir) => readJson(join(dataDir, 'concepts.meta.json'), { version: 0 })

/** 写表并升版本：备份旧表 → 写新表 → 记 meta。返回新 meta。 */
export function writeConcepts(dataDir, table, reason) {
  mkdirSync(dataDir, { recursive: true })
  const p = join(dataDir, 'concepts.json')
  const next = (readMeta(dataDir).version || 0) + 1
  if (existsSync(p)) copyFileSync(p, join(dataDir, `concepts.bak-v${next}.json`))
  writeFileSync(p, JSON.stringify(table, null, 1))
  const meta = {
    version: next,
    updatedAt: new Date().toISOString(),
    reason: String(reason || ''),
    concepts: Object.keys(table).length,
  }
  writeFileSync(join(dataDir, 'concepts.meta.json'), JSON.stringify(meta, null, 1))
  return meta
}

/**
 * 别名体检：挑出「等于没区分度」的别名。**只看不改**，要删走 pruneAliases。
 *
 * 三档口径（越往后越激进）：
 *   A 单字（「题」「判」「选」）：字面上几乎什么都能对上
 *   B A + 被 ≥2 个概念共用、且覆盖 ≥2% 的卡（同一个词挂 5 个概念 = 没有区分度）
 *   C B + 覆盖 ≥5% 的卡（「检索」「插件」这类高频词）
 */
const cardBody = (c) => [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || []), (c.pointer && c.pointer.quote) || ''].join(' ')

function readCardBodies(dataDir) {
  const p = join(dataDir, 'cards.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return cardBody(JSON.parse(l))
      } catch {
        return ''
      }
    })
}

const TIER_RANK = { A: 1, B: 2, C: 3 }

export function auditAliases(dataDir, { tier = 'B' } = {}) {
  const table = readConcepts(dataDir)
  const bodies = readCardBodies(dataDir)
  const N = Math.max(bodies.length, 1)
  const owner = new Map()
  for (const [id, v] of Object.entries(table)) {
    for (const a of v.aliases || []) {
      const k = String(a).trim()
      if (k) owner.set(k, [...(owner.get(k) || []), id])
    }
  }
  const dfCache = new Map()
  const df = (s) => {
    if (!dfCache.has(s)) dfCache.set(s, bodies.reduce((n, b) => n + (b.includes(s) ? 1 : 0), 0))
    return dfCache.get(s)
  }
  const sharedDf = Math.ceil(N * 0.02)
  const commonDf = Math.ceil(N * 0.05)
  const rows = []
  for (const [id, v] of Object.entries(table)) {
    for (const a of v.aliases || []) {
      const alias = String(a).trim()
      if (!alias) continue
      const len = [...alias].length
      const d = df(alias)
      const share = (owner.get(alias) || []).length
      const rowTier = len < 2 ? 'A' : share >= 2 && d >= sharedDf ? 'B' : d >= commonDf ? 'C' : null
      if (!rowTier) continue
      rows.push({ id, name: v.name, alias, len, df: d, share, tier: rowTier })
    }
  }
  const total = Object.values(table).reduce((n, v) => n + (v.aliases || []).length, 0)
  const pick = (t) => rows.filter((r) => TIER_RANK[r.tier] <= TIER_RANK[t])
  const wanted = TIER_RANK[tier] ? tier : 'B'
  return {
    tier: wanted,
    total,
    cards: bodies.length,
    counts: { A: pick('A').length, B: pick('B').length, C: pick('C').length },
    candidates: pick(wanted).sort((a, b) => b.df - a.df || b.share - a.share),
  }
}

/** 按口径删别名：先备份（writeConcepts 会写 concepts.bak-vN.json），版本 +1。 */
export function pruneAliases(dataDir, { tier = 'B' } = {}) {
  const audit = auditAliases(dataDir, { tier })
  const drop = new Set(audit.candidates.map((r) => r.alias))
  if (!drop.size) return { removed: 0, version: readMeta(dataDir).version || 0, audit }
  const table = readConcepts(dataDir)
  let removed = 0
  for (const id of Object.keys(table)) {
    const before = (table[id].aliases || []).length
    const next = (table[id].aliases || []).filter((a) => !drop.has(String(a).trim()))
    if (next.length !== before) {
      table[id] = { ...table[id], aliases: next }
      removed += before - next.length
    }
  }
  const meta = writeConcepts(dataDir, table, `audit(${audit.tier}): 去掉 ${removed} 个泛词别名`)
  // 写表时把「删之前的表」存成了 concepts.bak-v<新版本>.json，所以撤销就是 restore 到这个新版本号
  return { removed, version: meta.version, undoVersion: meta.version, candidates: audit.candidates.length, audit }
}

/** 有哪些可回滚的快照（写表前都会留一份 concepts.bak-vN.json）。 */
export function listBackups(dataDir) {
  let names = []
  try {
    names = readdirSync(dataDir)
  } catch {
    return []
  }
  return names
    .map((n) => /^concepts\.bak-v(\d+)\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => {
      const version = Number(m[1])
      let concepts = null
      try {
        concepts = Object.keys(JSON.parse(readFileSync(join(dataDir, `concepts.bak-v${version}.json`), 'utf8'))).length
      } catch {}
      return { version, concepts }
    })
    .sort((a, b) => b.version - a.version)
}

/**
 * 回滚到某个快照。回滚本身也会先给"当前表"留一份备份（所以再回滚一次也回得来），版本 +1。
 * 卡片上的码不在这个文件里，回滚不影响已打好的码；它影响的是"以后怎么打、怎么映射"。
 */
export function restoreConcepts(dataDir, version) {
  const v = Number(version)
  const src = join(dataDir, `concepts.bak-v${v}.json`)
  if (!Number.isFinite(v) || !existsSync(src)) throw new Error(`没有这个快照：concepts.bak-v${version}.json`)
  const table = JSON.parse(readFileSync(src, 'utf8'))
  const meta = writeConcepts(dataDir, table, `restore from v${v}`)
  return { restoredFrom: v, version: meta.version, concepts: meta.concepts }
}

/** 把 B 并进 A：B 的名字进 A 的别名；卡片上所有 B 改成 A；删 B。 */
export function mergeConcepts(dataDir, a, b) {
  const table = readConcepts(dataDir)
  if (!table[a]) throw new Error(`没有这个码：${a}`)
  if (!table[b]) throw new Error(`没有这个码：${b}`)
  if (a === b) throw new Error('两个码相同')
  const A = table[a]
  const B = table[b]
  const aliases = [...new Set([...(A.aliases || []), B.name, ...(B.aliases || [])])]
    .filter((x) => x && x !== A.name)
    .slice(0, 8)
  table[a] = { ...A, aliases }
  delete table[b]

  const cardsPath = join(dataDir, 'cards.jsonl')
  let moved = 0
  if (existsSync(cardsPath)) {
    const lines = readFileSync(cardsPath, 'utf8').split('\n').filter(Boolean)
    const out = lines.map((l) => {
      let c
      try {
        c = JSON.parse(l)
      } catch {
        return l
      }
      const cs = (c.codes && c.codes.concept) || []
      if (!cs.includes(b)) return l
      c.codes = { ...(c.codes || {}), concept: [...new Set(cs.map((x) => (x === b ? a : x)))] }
      moved++
      return JSON.stringify(c)
    })
    copyFileSync(cardsPath, join(dataDir, `cards.jsonl.bak-merge-${Date.now()}.jsonl`))
    writeFileSync(cardsPath, out.join('\n') + '\n')
  }
  const meta = writeConcepts(dataDir, table, `merge ${b} -> ${a}`)
  return { meta, moved, aliases }
}
