#!/usr/bin/env node
// 记忆助理 CLI：init / recall / feedback / stats / list
import { readFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadCards, saveCards, appendCard, logAsk, logFeedback, readFeedback, readAsks, dataDir, logUsage, readUsage, lastLogErrorInfo, logViaHost } from '../lib/store.js'
import { scoreCards, gapRatio, mapConcepts, literalState, textStats, rankByState } from '../lib/retrieve.js'
import { readConfig } from '../lib/server-routes.js'
import { noteFailure, readFailures } from '../lib/fail.js'
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}
const pos = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; flags[k] = v }
  else pos.push(a)
}
const cfg = { dataDir: flags.dir || '' }
// 面板存下来的偏好（设置页 → 保存）；没设置就用默认
const prefs = (() => {
  try {
    return readConfig()
  } catch {
    return {}
  }
})()
if (!cfg.dataDir && prefs.dataDir) cfg.dataDir = prefs.dataDir
const now = () => new Date().toISOString()

function out(x) { process.stdout.write(typeof x === 'string' ? x + '\n' : JSON.stringify(x, null, 1) + '\n') }

let logWarned = false
let hostLogOk = false
/** 日志写不进去时说一句（只一次），别让「记不了账」把检索本身也搞挂。 */
function warnLogOnce() {
  if (logWarned) return
  const e = lastLogErrorInfo()
  if (!e || hostLogOk) return
  logWarned = true
  process.stderr.write(`注：本轮日志没写进 ${e.names.join('、')}（沙箱只读），检索结果照常，不影响答案\n`)
}

/** 直接写盘失败（沙箱）→ 交给本机宿主代写；两条路都失败才提示。 */
async function persistLog(file, ok, row) {
  if (ok) return true
  hostLogOk = await logViaHost(file, row)
  return hostLogOk
}

/**
 * 泛词别名闸门：某个词覆盖了全库 ≥ ratio 的卡片，就当它没有区分度，不参与「问句→概念码」。
 * 只影响概念码这条腿（检索还有文本与关键词两条），表本身不动，改配置就能调。
 */
function makeAliasGate(cards, prefs) {
  const ratio = Number(prefs.aliasMaxDfRatio) > 0 ? Number(prefs.aliasMaxDfRatio) : 0.1
  const cut = Math.max(2, Math.ceil(cards.length * ratio))
  const cache = new Map()
  let bodies = null
  return (name) => {
    const s = String(name || '').trim()
    if (s.length < 2) return true
    if (!cache.has(s)) {
      if (!bodies) bodies = cards.map((c) => [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || []), c.pointer?.quote || ''].join(' '))
      cache.set(s, bodies.reduce((n, b) => n + (b.includes(s) ? 1 : 0), 0))
    }
    return cache.get(s) >= cut
  }
}

/**
 * 段 → 会话/时间 的登记表。
 * units.json 每次导入都会被覆盖，只留最近一批；持久化的 unit-index.json 才是全集。
 * 两条都读，index 优先，units.json 补新导入的那批。
 */
function readUnitMeta(dir) {
  const meta = new Map()
  try {
    const idx = JSON.parse(readFileSync(dir + '/import/unit-index.json', 'utf8'))
    for (const [id, v] of Object.entries(idx)) if (v && v.session) meta.set(id, { session: v.session, ts: v.ts || null })
  } catch {}
  try {
    const units = JSON.parse(readFileSync(dir + '/import/units.json', 'utf8'))
    for (const u of units) if (u && u.id && !meta.has(u.id)) meta.set(u.id, { session: u.session || 'unknown', ts: u.ts || null })
  } catch {}
  return meta
}

if (cmd === 'init') {
  const src = flags.from
  if (!src) { out('用法: mem init --from <关键词对照表.json>'); process.exit(1) }
  const raw = JSON.parse(readFileSync(src, 'utf8'))
  const list = raw.cards || raw
  const cards = list.map((c, i) => ({
    key: c.key || c.no || `x:${i}`,
    title: c.title || '',
    one_line: c.one_line || '',
    outline: c.outline || [],
    codes: {
      concept: (c.codes?.concept) || [],
      entity: (c.codes?.entity) || c.codes?.entities || [],
      owner: c.codes?.owner || '',
      actor: c.codes?.actor || '',
    },
    pointer: c.pointer || {},
    status: c.status || 'active',
  }))
  saveCards(cfg, cards)
  if (flags.concepts) {
    const ct = JSON.parse(readFileSync(flags.concepts, 'utf8')).concepts || []
    const table = {}
    for (const c of ct) table[c.id] = { name: c.name, aliases: c.aliases || [] }
    writeFileSync(dataDir(cfg) + '/concepts.json', JSON.stringify(table))
  }
  if (flags.entities) {
    const raw = JSON.parse(readFileSync(flags.entities, 'utf8'))
    const list = (raw.entities || raw).map((x) => (typeof x === 'string' ? x : x.term)).filter(Boolean)
    writeFileSync(dataDir(cfg) + '/entities.json', JSON.stringify(list))
  }
  out(`已写入 ${cards.length} 张卡 → ${dataDir(cfg)}/cards.jsonl`)
} else if (cmd === 'add') {
  const c = JSON.parse(flags.json || '{}')
  if (!c.title) { out('用法: mem add --json \'{"title":"...","one_line":"...","outline":["","",""]}\''); process.exit(1) }
  let wrote = false
  try {
    appendCard(cfg, { key: c.key || `n:${Date.now()}`, outline: c.outline || [], codes: c.codes || {}, pointer: c.pointer || {}, status: 'active', ...c })
    wrote = true
  } catch (e) {
    if (e && e.code === 'CREDENTIAL_BLOCKED') {
      noteFailure(cfg, 'bin/mem.js:add', e, { hits: (e.hits || []).join(',') })
      out(`没写：这张卡里疑似含${(e.hits || []).join('、')}。记忆会被检索、进上下文、进日志，所以凭据一律不入库。`)
      process.exitCode = 2
    } else {
      noteFailure(cfg, 'bin/mem.js:add', e)
      throw e
    }
  }
  if (wrote) out('ok')
} else if (cmd === 'recall') {
  const text = pos.join(' ')
  if (!text && !flags.concepts) { out('用法: mem recall "问题" [--concepts C01,C02] [--entities 公告板] [--top 3]'); process.exit(1) }
  const cards0 = loadCards(cfg)
  // 默认工作区：'' = 跟随当前目录对应的项目；'all' = 全部；其它 = 指定项目名
  const wanted = String(prefs.workspace || '').trim()
  const projOfCwd = () => {
    const segs = String(process.cwd()).split(/[\\/]/).filter(Boolean)
    let name = segs.length ? segs[segs.length - 1] : ''
    if (name === 'workspace' && segs.length > 1) name = segs[segs.length - 2]
    return name
  }
  const scopeProj = wanted === 'all' ? '' : wanted || projOfCwd()
  let cards = cards0
  if (scopeProj) {
    const hit = cards0.filter((c) => ((c.pointer && c.pointer.project) || '') === scopeProj)
    if (hit.length) cards = hit // 该目录没有记忆就退回全库，免得「明明导过却查不到」
  }
  // --session <id>：只在某一场对话里找（按 u → 会话 反查）
  if (flags.session && flags.session !== true) {
    const meta = readUnitMeta(dataDir(cfg))
    const wanted = String(flags.session)
    const owned = new Set([...meta].filter(([, v]) => v.session === wanted).map(([id]) => id))
    const hit = cards.filter((c) => c.pointer && owned.has(c.pointer.u))
    if (hit.length) cards = hit
    else out(`没有来自会话 ${wanted} 的记忆卡；改用全库检索`)
  }
  let conceptTable = {}
  try { conceptTable = JSON.parse(readFileSync(dataDir(cfg) + '/concepts.json', 'utf8')) } catch {}
  const autoConcepts = mapConcepts(text, conceptTable, { isGeneric: makeAliasGate(cards0, prefs) })
  // 2026-11-17 接线（会话手记 §10「三套没接线」）：
  //   ① 概念表的词要能进检索词表，否则问句里那个词切不出来 → 直接 none
  //   ② 别名 → 概念码 的映射要传给判态，让「卡带该码」也算讲到了
  const aliasToId = {}
  const conceptWords = new Set()
  for (const [id, v] of Object.entries(conceptTable || {})) {
    for (const w of [v.name, ...(v.aliases || [])]) {
      const t2 = String(w || '').trim()
      if (t2.length < 2 || t2.length > 12) continue
      if (!aliasToId[t2]) aliasToId[t2] = id
      conceptWords.add(t2)
    }
  }
  let entityList = []
  try { entityList = JSON.parse(readFileSync(dataDir(cfg) + '/entities.json', 'utf8')) } catch {}
  const autoEntities = entityList.filter((e) => e && String(e).length >= 2 && text.includes(String(e)))
  const q = {
    text,
    concepts: flags.concepts ? String(flags.concepts).split(',').map((s) => s.trim()).filter(Boolean) : autoConcepts,
    entities: flags.entities ? String(flags.entities).split(',').map((s) => s.trim()).filter(Boolean) : autoEntities,
  }
  const top = Number(flags.top || prefs.topK || 3)
  // idf 与词表用全库算，覆盖只看本次检索范围（--session / 项目筛选时不至于把词表缩没）
  const stats = textStats(cards0)
  // 三态：精确命中 / 无精确但有相关 / 都没有。判「精确」只看字面（标题/关键词/引用），不看分数。
  // 2026-11-17：领域过滤（领域库是「另一条轴」）。--domain 投资交易 时只在该领域的卡里查。
  if (flags.domain) {
    const want = String(flags.domain)
    const before = cards.length
    cards = cards.filter((c) => {
      const d = c.domain || ''
      return d === want || d.includes(want) || want.includes(d)
    })
    if (!cards.length) {
      if (!flags.json) out(`领域「${want}」里没有卡（全库 ${before} 张）。领域分布见：node tools/derive-domain.mjs --dry`)
      process.exitCode = 2
    } else if (!flags.json) {
      out(`（领域过滤：${want} → ${cards.length} / ${before} 张）`)
    }
  }
  const st = literalState(cards, q, { stats, vocabCards: cards0, aliasToId, vocabExtra: conceptWords })
  // 绝对地板：码会把相关卡的分抬得很高，没有地板就会「自信地答错」
  // 有码时分数普遍被抬高（判 6），没码时走字面分（判 2.5），否则新装的库会永远空手
  const hasCodes = cards.some((c) => c.codes && Array.isArray(c.codes.concept) && c.codes.concept.length)
  const floor = Number(flags.min || prefs.minScore || (hasCodes ? 6 : 2.5))
  const allScored = scoreCards(cards, q, { stats })
  const covOf = (s) => (st.covByKey.get(s.card.key) || {}).coverage || 0
  // 只给码、没有问句（mem recall --concepts C01）：没有字面可判，退回纯分数
  // 2026-11-17：**领域包也参与检索**，但和卡片分开展示——
  // 卡片答的是「发生过什么」，领域包答的是「这个领域里定义/规则/状态是什么」。
  // 以前只查卡片，问「写成绩要注明什么」时领域包里的那条状态是查不到的。
  // 2026-11-17：专业库默认优先。--memory-first 可临时切回；--domain-first 强制。
  const domainFirst = flags['memory-first'] ? false : (flags['domain-first'] ? true : prefs.domainFirst !== false)
  const domainHits = (() => {
    try {
      const dir = String(prefs.domainDir || '') || (dataDir(cfg) + '/domains')
      if (!existsSync(dir)) return []
      // 用「问句二元组 ∩ 领域包文本」来判，不依赖库词表——
      // 否则词表里缺词（或含跨边界碎片）时，领域包会被连带漏掉。
      const qb = new Set()
      for (const seg of String(text).split(/[^\u4e00-\u9fa5a-zA-Z0-9]+/)) {
        for (let i = 0; i + 2 <= seg.length; i++) qb.add(seg.slice(i, i + 2).toLowerCase())
      }
      const hits = []
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        let pack
        try { pack = JSON.parse(readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
        const terms = Array.isArray(pack.terms) ? pack.terms : []
        const slots = pack.slots || {}
        const slotText = (row) => (typeof row === 'string' ? row : (row && row.text) || '')
        const allSlots = [...(slots.rules || []), ...(slots.states || [])]
        const prop = `${terms.join(' ')} ${allSlots.map(slotText).join(' ')}`.toLowerCase()
        const common = [...qb].filter((g) => prop.includes(g))
        const rulesHit = (slots.rules || []).filter((r) => {
          const t = slotText(r).toLowerCase()
          return [...qb].filter((g) => t.includes(g)).length >= 2   // 至少两个字对上
        }).slice(0, 3)
        const statesHit = (slots.states || []).filter((r) => {
          const t = slotText(r).toLowerCase()
          return [...qb].filter((g) => t.includes(g)).length >= 2
        }).slice(0, 3)
        // 只凭一两个字对上不算——要么命中规则/状态，要么至少三个字对上
        if (!rulesHit.length && !statesHit.length && common.length < 3) continue
        hits.push({
          domain: pack.domain,
          n_cards: pack.n_cards,
          hits: common.length,
          rules: rulesHit,
          states: statesHit,
        })
      }
      return hits.sort((a, b) => (b.rules.length + b.states.length) - (a.rules.length + a.states.length) || b.hits - a.hits).slice(0, 2)
    } catch (_) {
      return []
    }
  })()

  const codeOnly = !String(text || '').trim() && q.concepts.length > 0
  // 挑卡：exact 按字面覆盖排，related 按分数排并过地板；规则在 retrieve.rankByState
  const scored = codeOnly
    ? allScored.filter((s) => !s.skipped && s.score >= floor).slice(0, top)
    : rankByState(st, allScored, { top, floor })
  const state = codeOnly ? 'concept' : st.state
  const gap = scored.length > 1 ? gapRatio([...scored].sort((a, b) => b.score - a.score)) : 1
  // 「并列」看的是判态自己的口径：精确命中比字面覆盖，其余比分数
  const tie = scored.length > 1 && (state === 'exact' ? covOf(scored[0]) - covOf(scored[1]) < 0.02 : gap < 0.15)
  const budget = (list) =>
    list.reduce((a, s) => a + Math.ceil([s.card.title, s.card.one_line, ...(s.card.outline || []), ...(s.card.keywords || [])].join(' ').length * 0.6), 0)
  const askRow = {
    ts: now(),
    q,
    state,
    coverage: st.coverage,
    top: scored.map((s) => ({ key: s.card.key, score: s.score, cov: Number(covOf(s).toFixed(2)) })),
    gap: Number(gap.toFixed(3)),
  }
  await persistLog('ask_log', logAsk(cfg, askRow), askRow)
  // 检索的 token 账：实际 = 返回的卡片 + 你要去读的那段原文；对照 = 若把整库常驻 / 若翻目录（实测 26,885）
  try {
    const tkn = (s) => Math.ceil([...String(s || '')].length * 0.6)
    const cardTokens = budget(scored)
    let sourceTokens = 0
    try {
      const units = JSON.parse(readFileSync(dataDir(cfg) + '/import/units.json', 'utf8'))
      const hit = units.find((u) => scored.length && u.id === scored[0].card.pointer.u)
      if (hit) sourceTokens = tkn(hit.user + '\n' + (hit.assistant || []).join('\n'))
    } catch {}
    const libraryTokens = loadCards(cfg).length * 40
    const usageRow = { ts: now(), kind: 'recall', q: String(text).slice(0, 60), state, cards: scored.length, cardTokens, sourceTokens, libraryTokens, browseTokens: 26885 }
    await persistLog('usage', logUsage(cfg, usageRow), usageRow)
  } catch {}
  warnLogOnce()
  if (flags.json) {
    out({
      query: q,
      state,
      coverage: st.coverage,
      terms: { known: st.known, absent: st.absent },
      missing: st.missing,
      gap: Number(gap.toFixed(3)),
      polarity: {
        negative: !!st.qNeg,
        mismatch: !!(st.polarityMismatch && scored.some((s) => st.polarityMismatch.has(s.card.key))),
        note: st.qNeg ? '问句是否定，但库里只有肯定记录；别把命中当「没发生过」' : '',
      },
      exclusion: st.exclusion || [],
      domain_hits: domainHits,
      results: scored.map((s) => ({
        key: s.card.key,
        score: s.score,
        cov: Number(covOf(s).toFixed(2)),
        title: s.card.title,
        one_line: s.card.one_line,
        outline: s.card.outline,
        pointer: s.card.pointer,
        why: s.why,
      })),
    })
  } else {
      const printDomain = () => {
        if (!domainHits.length) return
        out('')
        for (const d of domainHits) {
          out(`【领域】${d.domain}（该领域 ${d.n_cards} 张卡）`)
          for (const st0 of d.states || []) out(`   · ${st0.text}${st0.as_of ? `（as_of ${st0.as_of}）` : ''}${st0.status === 'draft' ? ' ⚠草稿' : ''}`)
          for (const r of d.rules || []) out(`   · 规则：${r.text || r}${r.from ? `（${r.from}）` : ''}`)
        }
      }
    const brief = (list) => list.slice(0, 4).join(' / ')
    const scopeWord = flags.session && flags.session !== true ? '这场对话里' : '库里'
      if (domainFirst && domainHits.length) {
        printDomain()
        out('')
        out('（以上是领域里的规则与状态；下面是长期记忆里发生过的事）')
      }
    if (state === 'exact') {
      out(`【精确命中】${scopeWord}讲到「${brief(st.known)}」的卡有 ${scored.length} 张（覆盖 ${(st.coverage * 100).toFixed(0)}%）`)
    } else if (state === 'related') {
      const absent = st.absent.length ? `；${scopeWord}根本没有「${brief(st.absent)}」` : ''
      const miss = st.missing.length ? `，最接近的一张缺「${brief(st.missing)}」` : ''
      out(`【无精确命中】${scopeWord}没有卡同时讲到「${brief(st.known)}」${absent}${miss}`)
      if (!scored.length) out(`  也没有分数过门槛（${floor}）的卡 —— 换个说法，或按追问协议问一句`)
    } else if (state === 'concept') {
      out(`【按概念码】只给了码没有问句，按码命中排（${q.concepts.join(',')}）`)
    } else {
      out(`【没有】${scopeWord}没有这块记忆：「${brief(st.absent.length ? st.absent : st.terms) || '问句里没有可检索的名词'}」一个都没出现过`)
      out('  空手追问，别硬答')
    }
    if (st.exclusion && st.exclusion.length) out(`（已按「除了…」把你排除的「${st.exclusion.join('/')}」移出检索目标）`)
    if (scored.length) {
      if (tie) out('（并列：拿不准就问）')
      // 极性提醒：问句是否定、命中卡是肯定 → 库里只有「做过」的记录，别把它当「没做过」的证据
      const negHit = st.polarityMismatch && scored.some((s) => st.polarityMismatch.has(s.card.key))
      if (negHit) out('⚠ 你问的是否定（没/未/别），但库里记的是肯定的事实；别把这张卡当成「没发生过」的证据，先跟用户确认。')
      for (const [i, s] of scored.entries()) {
        // 精确命中看覆盖，不看分数（分数里含概念码，容易被误读成"越像越对"）
        const tag = state === 'exact' ? `${Math.round(covOf(s) * 100)}%` : s.score
        out(`${i + 1}. [${tag}] ${s.card.title}`)
        out(`   ${s.card.one_line}`)
        for (const l of s.card.outline) out(`   · ${l}`)
        // 回原文要的地址：有文件路径就给路径，没路径就给段号（导出里按 u 取原文）
        if (s.card.pointer?.path) out(`   → ${s.card.pointer.path}${s.card.pointer.heading ? ' / ' + s.card.pointer.heading : ''}`)
        else if (s.card.pointer?.u) out(`   → 段号 ${s.card.pointer.u}（按它回原文取那一段）`)
      }
      if (!domainFirst) printDomain()
    }
  }
} else if (cmd === 'prefs') {
  // 2026-11-17 主人：专业库（领域）默认优先于长期记忆，但可由用户切回。
  const { writeConfig } = await import('../lib/server-routes.js')
  const val = pos[0]
  if (!val || !['domain', 'memory'].includes(val)) {
    const cur = prefs.domainFirst === false ? 'memory' : 'domain'
    out(`当前：${cur === 'domain' ? '专业库优先（默认）' : '长期记忆优先'}`)
    out('用法: mem prefs domain|memory')
    process.exit(val ? 1 : 0)
  }
  const next = writeConfig({ domainFirst: val === 'domain' })
  out(`已设置：${next.domainFirst ? '专业库优先（涉及相关专业时先用领域规则/状态）' : '长期记忆优先（先给发生过的事）'}`)
} else if (cmd === 'vocab-rate') {
  // 261115 主人：共享层对照表的评分由「用它的智能体」打，不靠主人。
  // 刻度 0.0x：一次判决只推动一点点，靠次数累积。
  const { appendFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const owner = flags.owner            // 被评的对照表属于谁
  const term = flags.term
  const verdict = flags.verdict
  const shared = flags.dir || process.env.DSH_SHARED_DIR
  if (!owner || !term || !['good', 'partial', 'bad', 'worst'].includes(verdict) || !shared) {
    out('用法: mem vocab-rate --owner <库主> --term <词> [--code C001] --verdict good|partial|bad|worst --query "<原问句>" --dir <共享数据目录>')
    process.exit(1)
  }
  const row = {
    ts: new Date().toISOString(),
    rater: flags.as || 'deepseek-harness',
    table_owner: owner,
    term,
    code: flags.code || null,
    verdict,
    query: flags.query || '',
  }
  const dir = join(shared, '词表评分', '评价日志')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${row.rater}.jsonl`), JSON.stringify(row) + '\n', 'utf8')
  out(`已记：${row.rater} 评 ${owner} 的「${term}」= ${verdict}`)
} else if (cmd === 'feedback') {
  const key = flags.key
  const verdict = flags.verdict
  if (!key || !['good', 'partial', 'bad'].includes(verdict)) { out('用法: mem feedback --key w:001 --verdict good|partial|bad [--note 说明]'); process.exit(1) }
  // 261115 主人：加分最多 +0.1；减分按语气分级——
  //   肯定       → +0.1
  //   「不完全/不光因为这个」→ -0.05
  //   「不是这个/不对」      → -0.3（「完全不对/彻底错」→ -1.0）
  //   +「以后别再用这张」  → 额外 -0.2
  const note = String(flags.note || '')
  // 单智能体记忆：0.x 刻度即可（共享层对照表的评分另有 0.0x 刻度）
  const delta =
    verdict === 'good'
      ? 0.1
      : verdict === 'partial'
        ? (/(不完全|不光|不全是|部分对|还有别的)/.test(note) ? -0.05 : -0.1)
        : /(完全不对|彻底错|全错|一点都不对)/.test(note)
          ? -1.0
          : /(不是这个|不对|错了|不是我要的)/.test(note)
            ? -0.3
            : -0.2
  // 把「那一次检索问了什么、用了哪些词」一起记下来 —— 评分才有归因依据
  let qText = ''
  let qTerms = []
  let qState = ''
  try {
    const recent = readAsks(cfg)
    const last = recent[recent.length - 1]
    if (last) {
      qText = typeof last.q === 'string' ? last.q : (last.q && last.q.text) || ''
      qState = last.state || ''
      qTerms = (last.top || []).map((t) => t.key).includes(key) ? last.termsKnown || [] : []
    }
  } catch {}
  const fbRow = { ts: now(), key, verdict, note, delta, query: qText, terms_known: qTerms, state: qState }
  const ok = await persistLog('feedback', logFeedback(cfg, fbRow), fbRow)
  if (ok) out(`已记录：${verdict}（权重 ${delta > 0 ? '+' : ''}${delta}）`)
  else {
    const e = lastLogErrorInfo()
    out(`反馈没记进去（${e ? e.message.slice(0, 80) : '数据目录不可写'}）。检索结果不受影响，但满意度会缺这一条`)
    process.exitCode = 2
  }
} else if (cmd === 'import') {
  const sub = pos[0] || 'status'
  const tools = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'tools')
  const run = (script, args) =>
    execFileSync(process.execPath, [tools + '/' + script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const statePath = dataDir(cfg) + '/import.state.json'
  const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return null } }

  if (sub === 'start') {
    const d = dataDir(cfg)
    let md = flags.from
    if (!md || md === true) {
      run('export-sessions.cjs', ['--out', d + '/export',
        ...(flags.since ? ['--since', String(flags.since)] : []),
        ...(flags.workspace ? ['--workspace', String(flags.workspace)] : [])])
      md = d + '/export/sessions.md'
    }
    const u = JSON.parse(run('import-memory.cjs', ['units', '--from', md, '--out', d + '/import']))
    const b = JSON.parse(run('import-memory.cjs', ['batch', '--from', d + '/import/units.json', '--out', d + '/import/batch', '--size', String(flags.size || 8)]))
    if (flags.concepts && flags.concepts !== true) {
      copyFileSync(String(flags.concepts), d + '/import/concepts_brief.json')
    }
    const state = {
      source: md,
      started_at: now(),
      units: u.units,
      chars: u.chars,
      batches: b.batches,
      done: [],
      pending: Array.from({ length: b.batches }, (_, i) => i + 1),
      batch_dir: d + '/import/batch',
    }
    writeFileSync(statePath, JSON.stringify(state, null, 1))
    out({ ok: true, units: u.units, batches: b.batches, batch_dir: state.batch_dir, next: `读 ${state.batch_dir}/b01.json 抽卡 → mem import merge --batch 1 --cards <文件>` })
  } else if (sub === 'merge') {
    const n = Number(flags.batch || 0)
    const st = readState()
    if (!st) { out('还没开始导入：先 mem import start'); process.exit(1) }
    const res = JSON.parse(run('import-memory.cjs', ['merge', '--cards', String(flags.cards), '--units', st.batch_dir + '/../units.json', '--concepts', st.batch_dir + '/../concepts_brief.json', '--data', dataDir(cfg)]))
    if (n && !st.done.includes(n)) { st.done.push(n); st.pending = st.pending.filter((x) => x !== n) }
    // 只记这一批的增量（added/rejected/duplicates），不落「库里共多少张」——总数现数 cards.jsonl
    st.last_merge = { at: now(), batch: n, added: res.added, rejected: res.rejected, duplicates: res.duplicates }
    writeFileSync(statePath, JSON.stringify(st, null, 1))
    out({ ...res, progress: `${st.done.length}/${st.batches}`, next: st.pending.length ? `下一批 b${String(st.pending[0]).padStart(2, '0')}` : '导入完成' })
  } else {
    const st = readState()
    if (!st) { out({ installed: true, imported: false, hint: '还没有导入记忆：mem import start' }) }
    else out({ source: st.source, units: st.units, batches: st.batches, done: st.done.length, pending: st.pending, last: st.last_merge || null })
  }
} else if (cmd === 'sessions') {
  // 哪几场对话进了库：卡数 / 时间跨度 / 标题
  const cards = loadCards(cfg)
  const meta = readUnitMeta(dataDir(cfg))
  const titles = new Map()
  try {
    const md = readFileSync(dataDir(cfg) + '/export/sessions.md', 'utf8')
    for (const m of md.matchAll(/^## 会话 (\S+?)(?: · (.+))?$/gm)) titles.set(m[1], (m[2] || '').trim())
  } catch {}
  const agg = new Map()
  for (const c of cards) {
    const u = c.pointer && c.pointer.u
    const info = meta.get(u) || {}
    const sid = info.session || 'unknown'
    const cur = agg.get(sid) || { session: sid, title: titles.get(sid) || '', cards: 0, from: null, to: null }
    cur.cards++
    const ts = info.ts
    if (ts) { if (!cur.from || ts < cur.from) cur.from = ts; if (!cur.to || ts > cur.to) cur.to = ts }
    agg.set(sid, cur)
  }
  const rows = [...agg.values()].sort((a, b) => b.cards - a.cards)
  out(`共 ${rows.length} 场会话、${cards.length} 张卡`)
  for (const r of rows) out(`${String(r.cards).padStart(4)} 张  ${r.from || '?'} → ${r.to || '?'}  ${r.session.slice(0, 40)}  ${r.title}`)
} else if (cmd === 'concepts') {
  // 概念表维护：查看 / 合并（合并会迁移卡片上的码，并先备份）
  const { readConcepts, readMeta, mergeConcepts } = await import('../lib/concepts.js')
  const dir = dataDir(cfg)
  const sub = pos[0]
  if (sub === 'merge') {
    const a = pos[1]
    const b = pos[2]
    if (!a || !b) { out('用法: mem concepts merge <保留的码> <并入的码>'); process.exit(1) }
    try {
      const r = mergeConcepts(dir, a, b)
      out({ ok: true, merged: b + ' -> ' + a, aliases: r.aliases, cardsMigrated: r.moved, version: r.meta.version, concepts: r.meta.concepts })
    } catch (e) {
      out('合并失败：' + e.message)
      process.exit(1)
    }
  } else if (sub === 'backups') {
    const { listBackups } = await import('../lib/concepts.js')
    const list = listBackups(dir)
    const meta = readMeta(dir)
    out(`当前版本 v${meta.version || 0}；可回滚的快照 ${list.length} 个（写表前自动留的）`)
    for (const b of list.slice(0, Number(flags.n || 10))) out(`  v${b.version}  ${b.concepts ?? '?'} 个概念  concepts.bak-v${b.version}.json`)
    out('回滚：mem concepts restore --v <版本号>（回滚前会再给当前表留一份）')
  } else if (sub === 'restore') {
    const { restoreConcepts } = await import('../lib/concepts.js')
    let v = Number(flags.v)
    if (!v) {
      const { listBackups } = await import('../lib/concepts.js')
      const list = listBackups(dir)
      v = list.length ? list[0].version : 0
    }
    try {
      const r = restoreConcepts(dir, v)
      out({ ok: true, restoredFrom: r.restoredFrom, version: r.version, concepts: r.concepts, note: '回滚前的表也留了备份，再回滚一次能回来' })
    } catch (e) {
      out('回滚失败：' + e.message)
      process.exit(1)
    }
  } else if (sub === 'audit') {
    // 泛词别名体检：只挑候选、不自动删。--apply 才真删（删前自动备份、版本 +1）。
    // 口径 --tier A|B|C：A 只删单字；B 再删「跨≥2 概念且覆盖≥2%」；C 再删「覆盖≥5%」
    const { auditAliases, pruneAliases } = await import('../lib/concepts.js')
    const tier = String(flags.tier || 'B').toUpperCase()
    if (flags.apply) {
      const r = pruneAliases(dir, { tier })
      out({ ok: true, tier, removed: r.removed, candidates: r.candidates, version: r.version, note: '旧表已备份为 concepts.bak-v' + r.version + '.json' })
    } else {
      const a = auditAliases(dir, { tier })
      out(`别名体检（口径 ${a.tier}）：${a.total} 个别名 / ${a.cards} 张卡，候选 ${a.candidates.length} 个（未改动）`)
      out(`  三档候选数：A 单字 ${a.counts.A} · B +跨概念共用 ${a.counts.B} · C +高频词 ${a.counts.C}`)
      for (const r of a.candidates.slice(0, Number(flags.n || 40))) {
        out(`  ${r.alias.padEnd(8)} df=${String(r.df).padStart(4)} 共用=${r.share}  ${r.id} ${r.name}  ← ${r.tier}`)
      }
      if (a.candidates.length > Number(flags.n || 40)) out(`  … 其余 ${a.candidates.length - Number(flags.n || 40)} 个用 --n 看多些`)
      out('确认要删就加 --apply（先备份成 concepts.bak-vN.json，版本号 +1）；换口径加 --tier A|B|C')
    }
  } else {
    const table = readConcepts(dir)
    const meta = readMeta(dir)
    const ids = Object.keys(table)
    out({ version: meta.version || 0, updatedAt: meta.updatedAt || null, concepts: ids.length })
    for (const id of ids.slice(0, Number(flags.n || 30))) {
      const c = table[id]
      out(`${id}  [${c.domain || '-'}] ${c.name}${(c.aliases || []).length ? '（' + c.aliases.join('/') + '）' : ''}`)
    }
    if (ids.length > Number(flags.n || 30)) out(`… 其余 ${ids.length - Number(flags.n || 30)} 个用 --n 看多些`)
  }
} else if (cmd === 'usage') {
  // 检索的 token 账：实际花了多少 / 不用检索时最低要花多少
  const rows = readUsage(cfg).filter((r) => r.kind === 'recall')
  const actual = rows.reduce((a, r) => a + (r.cardTokens || 0) + (r.sourceTokens || 0), 0)
  const lib = loadCards(cfg).length * 40
  const browse = rows.length ? rows[0].browseTokens || 26885 : 26885
  out({
    queries: rows.length,
    actualTokens: actual,
    perQuery: rows.length ? Math.round(actual / rows.length) : 0,
    baseline_library_resident: lib,
    baseline_browse_catalog: browse,
    saved_vs_library: rows.length * lib - actual,
    saved_vs_browse: rows.length * browse - actual,
    note: '基线：library=把整库卡片常驻上下文；browse=让模型翻目录挑（实测 26,885/次）',
  })
} else if (cmd === 'stale') {
  // 2026-11-17：遗忘 = 标记过时，不是删除（借鉴 memfuse）。
  // 过时的卡仍可被检索，但不再冒充「精确命中」。
  const key = flags.key
  if (!key) { out('用法: mem stale --key <卡号> [--undo]'); process.exit(1) }
  const cards = loadCards(cfg)
  const c = cards.find((x) => x.key === key)
  if (!c) {
    out('库里没有这张卡：' + key)
    process.exitCode = 2
  } else {
  if (flags.undo) {
    delete c.stale
    delete c.stale_since
    out(`已恢复：${c.title || key}`)
  } else {
    c.stale = true
    c.stale_since = now()
    out(`已标记过时：${c.title || key}（条目保留，仍可检索，但不再算精确命中）`)
  }
  saveCards(cfg, cards)
  }
} else if (cmd === 'stats') {
  const fb = readFeedback(cfg)
  const asks = readAsks(cfg)
  const c = { good: 0, partial: 0, bad: 0 }
  for (const f of fb) c[f.verdict] = (c[f.verdict] || 0) + 1
  const n = c.good + c.partial + c.bad
  const satisfaction = n ? (c.good + 0.5 * c.partial) / n : null
  // 三态上线后按 state 记「需追问」；旧行没有 state，仍按 gap<15% 估
  const states = { exact: 0, related: 0, none: 0, concept: 0 }
  let legacy = 0
  let legacyNeed = 0
  for (const a of asks) {
    if (a.state) states[a.state] = (states[a.state] || 0) + 1
    else {
      legacy++
      if (a.gap < 0.15) legacyNeed++
    }
  }
  const stateAsks = states.exact + states.related + states.none + states.concept
  const need = stateAsks ? states.related + states.none : legacyNeed
  const totalNeed = stateAsks || legacy
  out({
    cards: loadCards(cfg).length,
    asks: asks.length,
    states,
    legacy_asks: legacy,
    need_confirm_rate: totalNeed ? Number((need / totalNeed).toFixed(3)) : null,
    feedback: c,
    satisfaction: satisfaction === null ? null : Number(satisfaction.toFixed(3)),
    note: 'need_confirm = (related + none) / 有 state 的查询；精确命中可直接答，related 要先说明缺什么',
  })

  // 2026-11-17：失败与过时都要看得见——看不见的故障会静默很久。
  // 只在人读模式下打，避免污染 --json 输出。
  if (!flags.json) try {
    const all = loadCards(cfg)
    const staleN = all.filter((c) => c.stale).length
    if (staleN) out(`过时（still 可检索，不算精确命中）：${staleN} 张`)
    const fails = readFailures(cfg, 3)
    if (fails.length) {
      out(`最近失败 ${fails.length} 条（完整见 failures.jsonl）：`)
      for (const f of fails) out(`  · ${String(f.ts).slice(5, 16)} ${f.where} — ${String(f.message).slice(0, 60)}`)
    }
  } catch (_) {}
} else if (cmd === 'list') {
  for (const c of loadCards(cfg).slice(0, Number(flags.n || 10))) out(`${c.key}  ${c.title}  ${c.one_line}`)
} else {
  out('命令: init | add | recall [--session <id>] | feedback | vocab-rate | import | stats | list | sessions')
}