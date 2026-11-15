import { tokens, contentChars } from './tokenize.js'

/**
 * 检索三件套（按顺序）：
 *   1. 打分：码 + 文本 + 关键词三条通道，文本与关键词都按 idf 加权（泛词几乎不加分）
 *   2. 判态：literalState() —— 精确命中 / 无精确但有相关 / 都没有
 *   3. 定位：卡里的 pointer.u 回原文
 *
 * 判定「精确」不看分数：分数会被概念码抬高（一条码命中就能 +10），
 * 只看「问句里的名词有没有出现在这张卡的标题/关键词/引用里」。
 */

const RARE_RATIO = 0.05 // df 占比 ≤5% 才算真专名（稀有词）；缺一个就不许叫精确
const EXACT_COVERAGE = 0.8 // 词按 idf 加权后的覆盖率门槛
const SPEC_RATIO = 0.2 // df 占比 ≤20% 才算「够具体」，防止整句泛词堆出命中

export function bodyText(c) {
  return [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || []), c.body || '', c.pointer?.quote || '']
    .filter(Boolean)
    .join(' ')
}

/** 「断言这张卡在讲什么」的那几个字段：标题 / 关键词 / 原文引用。大纲不算（它是引申）。 */
export function anchorText(c) {
  return [c.title, ...(c.keywords || []), c.pointer?.quote || ''].filter(Boolean).join(' ')
}

// 码的 idf：只用来给「码命中」定权，跟文本 idf 分开算

function codeStats(cards) {
  const df = new Map()
  for (const c of cards) {
    for (const k of codeKeys(c)) df.set(k, (df.get(k) || 0) + 1)
  }
  const N = Math.max(cards.length, 1)
  const idf = (k) => Math.log(1 + N / Math.max(df.get(k) || 0, 1))
  return { idf, N, df }
}

/** 文本 idf：一张卡算一个文档，重复词只算一次。 */
export function textStats(cards) {
  const df = new Map()
  const charDf = new Map()
  for (const c of cards) {
    const body = bodyText(c)
    for (const t of new Set(tokens(body))) df.set(t, (df.get(t) || 0) + 1)
    for (const ch of new Set(contentChars(body))) charDf.set(ch, (charDf.get(ch) || 0) + 1)
  }
  const N = Math.max(cards.length, 1)
  const idf = (t) => Math.log(1 + N / Math.max(df.get(t) || 0, 1))
  const charIdf = (ch) => Math.log(1 + N / Math.max(charDf.get(ch) || 0, 1))
  return { df, charDf, N, idf, charIdf, maxIdf: Math.log(1 + N) }
}

export function codeKeys(c) {
  const out = []
  const codes = c.codes || {}
  for (const t of codes.concept || []) out.push('C:' + t)
  for (const e of codes.entity || []) out.push('E:' + String(e).toLowerCase())
  if (codes.actor) out.push('A:' + codes.actor)
  return out
}

/** 查询侧：压出来的关键词（不是整句）。 */
export function queryTerms(text) {
  return [...new Set(tokens(text))]
}

// 查询侧：概念 id（可由模型给出）+ 实体词（来自问题原文）
export function scoreCards(cards, query, opts = {}) {
  const cs = codeStats(cards)
  const st = opts.stats || textStats(cards)
  const qConcepts = new Set(query.concepts || [])
  const qEntities = (query.entities || []).map((e) => String(e).toLowerCase())
  const qTokens = queryTerms(query.text || '')
  const qSet = new Set(qTokens)
  const qChars = contentChars(query.text || '')

  const scored = cards.map((c, i) => {
    // 低信号卡（user 侧只有「可以/好的」这类回应）仍留在库里，但不进候选，
    // 否则会靠一个万能词吸走所有查询
    if (c.low_signal) return { card: c, score: 0, literal: 0, why: [], order: i, skipped: true }
    const keys = codeKeys(c)
    let s = 0
    let literal = 0
    const why = []
    for (const k of keys) {
      if (k.startsWith('C:') && qConcepts.has(k.slice(2))) { s += 2.0 * cs.idf(k); why.push(k) }
      if (k.startsWith('E:')) {
        const e = k.slice(2)
        if (qEntities.some((q) => q && (e.includes(q) || q.includes(e)))) { s += 1.5 * cs.idf(k); why.push(k) }
      }
    }
    // 文本通道：命中词的 idf 之和（「讨论 / 可以 / 一下」这种泛词 idf≈0，几乎不加分）
    const body = bodyText(c)
    const bodySet = new Set(tokens(body))
    const hit = qTokens.filter((t) => bodySet.has(t))
    if (hit.length) {
      literal += 0.5 * hit.reduce((a, t) => a + st.idf(t), 0)
      why.push('txt×' + hit.length)
    }
    // 单字补充：二元组吃掉的单字动词（丢/删/改），按 idf 取最稀有的 3 个
    const bodyChars = new Set(contentChars(body))
    const chHit = qChars
      .filter((ch) => bodyChars.has(ch))
      .sort((a, b) => st.charIdf(b) - st.charIdf(a))
      .slice(0, 3)
    if (chHit.length) {
      literal += 0.25 * chHit.reduce((a, ch) => a + st.charIdf(ch), 0)
      why.push('chr×' + chHit.length)
    }
    // 关键词通道：原文词。整词（二元组至少一半命中）权重高于半词
    let kwHits = 0
    let kwWeight = 0
    for (const k of c.keywords || []) {
      const kt = [...new Set(tokens(String(k)))]
      if (!kt.length) continue
      const ok = kt.filter((t) => qSet.has(t))
      if (!ok.length) continue
      kwHits++
      const whole = ok.length / kt.length >= 0.5
      kwWeight += (whole ? 1 : 0.5) * Math.min(6, ok.reduce((a, t) => a + st.idf(t), 0))
      if (kwHits >= 3) break
    }
    if (kwHits) {
      literal += 0.8 * kwWeight
      why.push('kw×' + kwHits)
    }
    s += literal
    return { card: c, score: Number(s.toFixed(4)), literal: Number(literal.toFixed(4)), why, order: i }
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored
}

/**
 * 问句里有没有否定（没 / 未 / 别 / 没有 / 不是 / 还没）。
 * 只用于「标注极性」，不参与排序、不参与判态：
 * 否定词按功能字被丢掉，所以「删了」和「没删」的检索结果完全一样，
 * 必须靠这一层提醒调用方 —— 别把「库里记着做过」当成「没做过」的证据。
 */
export function hasNegation(text) {
  const t = String(text || '')
  if (/没有|还没|不是|并未|从不|别把|别改|别动|别再|别再/.test(t)) return true
  const stripped = t.replace(/不少|不错|不久|不仅|不但|不同|不过|不确定/g, '')
  return /[没未别不]/.test(stripped)
}

/**
 * 排除意图：「除了 X」「除 X 以外」「X 以外」里的 X 是用户**已经知道**的东西，
 * 不该再当成检索目标 —— 否则问「除了公告板还丢过什么」会直接返回公告板那张卡。
 */
export function detectExclusion(text) {
  const t = String(text || '')
  const m =
    t.match(/(?:除了|除去|除掉)\s*([^\s，,。；;、]+?)\s*(?:以外|之外|还|也|$)/) ||
    t.match(/([^\s，,。；;、]+?)\s*(?:以外|之外)/)
  return m ? m[1] : ''
}

/**
 * 判态：精确 / 相关 / 没有。
 *
 * 三条规则（都是「宁可说没有，也不说成有」）：
 * 1. 切词用库自己的词表（卡片的 keywords + entities），不用二元组：
 *    「静默失败 备份」要切成 静默/失败/备份 三个词，不能因为静默+失败权重高就把缺「备份」算成命中。
 * 2. 覆盖 = 这张卡的「标题 / 关键词 / 引用」里出现了几个词（按 idf 加权）。
 * 3. 稀有词（df ≤ 5%，即真专名）必须覆盖到；缺一个就不算精确，只算相关。
 *    只靠「讨论 / 可以 / 一下」这类泛词覆盖满，连相关都很勉强（见 exact 的稀有词要求）。
 */
export function literalState(cards, query, opts = {}) {
  // 词表与 df 用「全库」（vocabCards），覆盖只看本次检索范围（cards）：
  // 否则 --session 检索时词表会缩成那一场对话的用词，「打码」这种词就不是词了。
  const universe = opts.vocabCards || cards
  const st = opts.stats || textStats(universe)
  const text = String(query.text || '')
  const vocab = buildVocab(universe)
  const dfOf = (u) => st.df.get(u) || 0 // 先查二元组 df（快），没有就现数
  const dfCache = new Map()
  const df = (u) => {
    if (dfCache.has(u)) return dfCache.get(u)
    let d = dfOf(u)
    if (!d) {
      // 多字词（概念表/记忆助理）不是二元组，单独数一遍：body 里出现过就算
      for (const c of universe) if (bodyText(c).includes(u)) d++
    }
    dfCache.set(u, d)
    return d
  }
  // 词表里的「短语」只有 1 张卡用过时不当词：否则某张卡写了个新短语关键词，
  // 就会把「静默失败」这种问法切成一整块，反而切散了「静默」「失败」两个常用词。
  let terms = unitsOf(text, vocab, (v) => df(v) >= 2)
  // 261115：词表外的词若在库里真实存在（df>0），不能丢——这是「浮亏/建仓/溢价」查不到的直接原因。
  // 做法：对问句里未被覆盖的汉字串，取「最长的、df>0 的子串」补进 terms；不造 n-gram 碎片。
  {
    const covered = (g) => terms.some((t) => t.includes(g) || g.includes(t))
    const extra = []
    for (const run of (text.match(/[\u4e00-\u9fff]{2,}/g) || [])) {
      if (covered(run)) continue
      let picked = ''
      for (let len = Math.min(4, run.length); len >= 2 && !picked; len--) {
        for (let i = 0; i + len <= run.length; i++) {
          const w = run.slice(i, i + len)
          if (covered(w) || extra.includes(w)) continue
          if (df(w) >= 1) { picked = w; break }
        }
      }
      if (picked) extra.push(picked)
      if (extra.length >= 3) break
    }
    if (extra.length) terms = [...new Set([...terms, ...extra])]
  }
  // 纯数字（股票代码 / 金额 / 轮次）也是实体：词表里没有数字，但卡片标题里常有。
  // 不并进来，「512010 为什么出局」就只能按「出局」判覆盖，永远到不了 exact。
  const nums = (String(text).match(/\d+(?:\.\d+)?/g) || []).filter((n) => n.length >= 2 && df(n) > 0)
  if (nums.length) terms = [...new Set([...terms, ...nums])]
  let known = terms.filter((u) => df(u) > 0)
  // 词表一个都没命中（问的是库外的词，或词表没收录）→ 退回二元组，至少能报「库里没有」
  if (!known.length) {
    terms = queryTerms(text)
    known = terms.filter((u) => df(u) > 0)
  }
  const absent = terms.filter((u) => !df(u) && String(u).length >= 2)
  const qNeg = hasNegation(text)
  // 「除了 X」里的 X 是用户已知的，从检索词里剔除
  const excluded = detectExclusion(text)
  const exclusion = excluded ? terms.filter((u) => excluded.includes(u) || u.includes(excluded)) : []
  if (exclusion.length) {
    terms = terms.filter((u) => !exclusion.includes(u))
    known = known.filter((u) => !exclusion.includes(u))
    // 排除掉之后一个词都不剩（「除了公告板 还丢过什么」）→ 退回二元组，别把整句判成空
    if (!known.length) {
      const notExcluded = (u) => !(excluded && (String(u).includes(excluded) || excluded.includes(String(u))))
      terms = queryTerms(text).filter(notExcluded)
      known = terms.filter((u) => df(u) > 0)
    }
  }
  /** 问句是否定、这张卡是否定吗？只有「问句否、卡肯定」才算极性冲突 */
  const polarityOf = (c) => qNeg && !hasNegation(anchorText(c))
  if (!known.length) {
    return {
      state: 'none',
      terms,
      known,
      absent,
      best: null,
      coverage: 0,
      specificCovered: [],
      missing: [],
      covByKey: new Map(),
      exactKeys: new Set(),
      qNeg,
      excluded,
      exclusion,
      polarityMismatch: new Set(),
    }
  }
  const w = (u) => Math.log(1 + Math.max(universe.length, 1) / Math.max(df(u), 1))
  const N = Math.max(universe.length, 1)
  const rareDf = Math.max(2, Math.round(RARE_RATIO * N))
  const specDf = Math.max(4, Math.round(SPEC_RATIO * N))
  const isRare = (u) => df(u) > 0 && df(u) <= rareDf
  // 「够具体」比「稀有」宽一档：单查「打码」这种 df 刚过 5% 的词，不该被判成没命中
  const isSpecific = (u) => df(u) > 0 && df(u) <= specDf
  const total = known.reduce((a, u) => a + w(u), 0)

  const covByKey = new Map()
  const polarityMismatch = new Set()
  let best = null
  let bestExact = null
  const exactKeys = new Set()
  for (const c of cards) {
    if (c.low_signal) continue
    const title = String(c.title || '')
    const kws = (c.keywords || []).join(' ')
    const quote = String(c.pointer?.quote || '')
    // 同一个词出现在哪，分量不一样：标题（这张卡自己主张的）> 关键词（原文用词）> 引用（用户原话）
    // 261115：terms 是本块出现的全部词表词（含正文词），作为「中等强度」的匹配证据。
    // 位置：标题 1.0 > 关键词 0.9 > 正文词 0.7 > 引用 0.6
    const termsTxt = (c.terms || []).join(' ')
    const fieldW = (u) => (title.includes(u) ? 1 : kws.includes(u) ? 0.9
      : termsTxt.includes(u) ? 0.7 : quote.includes(u) ? 0.6 : 0)
    const covered = known.filter((u) => fieldW(u) > 0)
    if (!covered.length) continue
    const coverage = total ? known.reduce((s, u) => s + w(u) * fieldW(u), 0) / total : 0
    covByKey.set(c.key, { coverage, covered })
    if (polarityOf(c)) polarityMismatch.add(c.key)
    const hit = { key: c.key, card: c, coverage, covered, missing: known.filter((u) => !covered.includes(u)) }
    const missRare = known.filter((u) => isRare(u) && !covered.includes(u))
    if (coverage >= EXACT_COVERAGE && !missRare.length && covered.some(isSpecific)) {
      exactKeys.add(c.key)
      if (!bestExact || coverage > bestExact.coverage) bestExact = hit
    }
    if (!best || coverage > best.coverage) best = hit
  }
  // 只要库里有一张卡字面讲到，就是精确命中 —— 哪怕还有另一张覆盖更高的卡（那它只是"提到"，不是答案）
  const state = exactKeys.size ? 'exact' : best ? 'related' : 'none'
  const rep = state === 'exact' ? bestExact : best
  const coverage = rep ? rep.coverage : 0
  const rareCovered = rep ? rep.covered.filter(isRare) : []
  const rareMissing = rep ? known.filter((u) => isRare(u) && !rep.covered.includes(u)) : known
  return {
    state,
    terms,
    known,
    absent,
    best: rep,
    coverage: Number(coverage.toFixed(3)),
    rare: known.filter(isRare),
    // 相关态的证据线：优先稀有词；整句都是 5–20% 的词时退到「够具体」
    gate: known.some(isRare) ? known.filter(isRare) : known.filter(isSpecific),
    rareMissing,
    specificCovered: rareCovered,
    missing: rep ? rep.missing : [],
    covByKey,
    exactKeys,
    qNeg,
    excluded,
    exclusion,
    polarityMismatch,
  }
}

/**
 * 按判态挑卡（CLI / 探针 / 提示共用一份，别各写一套）：
 * - exact：只留字面够得着的卡，按覆盖排，分数只做同覆盖时的次序
 * - related：过地板 + 至少覆盖到一个稀有词，按分数排
 * - none：不返回
 */
export function rankByState(st, scored, { top = 3, floor = 0 } = {}) {
  const covOf = (s) => (st.covByKey.get(s.card.key) || {}).coverage || 0
  // 261115：同覆盖时，用户反复强调过的记忆优先（importance 1–5，默认 1）
  const imp = (s) => Number((s.card && s.card.importance) || 1)
  if (st.state === 'exact') {
    // 同一覆盖下比「字面分」（不含概念码）：码是用来捞卡的，不是用来排字面名次的
    return scored
      .filter((s) => !s.skipped && st.exactKeys.has(s.card.key))
      .sort((a, b) => covOf(b) - covOf(a) || imp(b) - imp(a) || (b.literal || 0) - (a.literal || 0) || b.score - a.score)
      .slice(0, top)
  }
  if (st.state === 'related') {
    const rare = new Set(st.gate && st.gate.length ? st.gate : st.rare || [])
    // 相关态也先按覆盖排：状态行说的「最接近的一张」就是第 1 张，别让分数把它挤下去
    return scored
      .filter(
        (s) =>
          !s.skipped &&
          s.score >= floor &&
          (s.why || []).some((w) => w.startsWith('txt') || w.startsWith('kw')) &&
          ((st.covByKey.get(s.card.key) || {}).covered || []).some((u) => rare.has(u)),
      )
      .sort((a, b) => covOf(b) - covOf(a) || b.score - a.score)
      .slice(0, top)
  }
  return []
}

/** 词表：卡片自己的关键词 + 实体。这是库里「真实用过的词」，比二元组干净。 */
function buildVocab(cards) {
  const v = new Set()
  for (const c of cards) {
    // 261115：共享索引卡带 terms（本块出现的全部词表词），必须并入词表，
    // 否则业务词（止损/仓位/浮亏）切不出来 → state=none，与真实可用性脱节。
    for (const k of [...(c.keywords || []), ...(c.entities || []), ...(c.terms || [])]) {
      const s = String(k ?? '').trim()
      if (s.length >= 2 && s.length <= 12) v.add(s)
    }
  }
  return v
}

/** 长词优先、互不重叠地切「问句里出现了哪些库内词」。ok(v) 用来筛掉太孤立的短语。 */
function unitsOf(text, vocab, ok) {
  const cands = [...vocab]
    .filter((v) => v.length >= 2 && text.includes(v) && (!ok || ok(v)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
  const picked = []
  for (const v of cands) {
    const at = text.indexOf(v)
    if (at < 0) continue
    if (picked.some((u) => at < u.end && at + v.length > u.start)) continue
    picked.push({ v, start: at, end: at + v.length })
  }
  return picked.sort((a, b) => a.start - b.start).map((u) => u.v)
}

/**
 * 问句 → 概念码（可选）。
 * isGeneric(name)：库里的「泛词」判定。带这个判定时，像「记忆」「检索」「关键词」这种
 * 覆盖了全库一成卡片的词，不再把问句自动归到某个概念上——它们等于没有区分度。
 */
export function mapConcepts(text, table, opts = {}) {
  const hits = []
  const t = String(text || '')
  const isGeneric = typeof opts.isGeneric === 'function' ? opts.isGeneric : () => false
  for (const [id, v] of Object.entries(table || {})) {
    const names = [v.name, ...(v.aliases || [])].filter((x) => x && String(x).length >= 2)
    if (names.some((n) => t.includes(String(n)) && !isGeneric(n))) hits.push(id)
  }
  return hits
}

export function gapRatio(scored) {
  const s0 = scored[0]?.score || 0
  const s1 = scored[1]?.score || 0
  if (s0 <= 0) return 1
  return (s0 - s1) / s0
}
