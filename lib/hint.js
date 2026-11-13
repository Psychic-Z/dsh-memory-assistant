/**
 * 主动提：在每轮「进入模型之前」按当前这句话挑 1–3 张卡，写成一小段提示。
 *
 * 三条设计约束（都是之前定过的）：
 * - 条数不设旋钮，由「这一轮涉及几条」决定：分数有断崖就只提 1 条，几条接近就提到 3 条，
 *   一大片同分说明问得泛 → 不提（让人自己说清，比硬塞好）。
 * - 预算 1200 token 封顶（一张卡约 40 token），被预算挤掉的变成一句「另外还有 N 条」。
 * - 同一条卡 10 轮内不重复提；档位只有一个总开关（proactive）。
 */
import { loadCards } from './store.js'
import { scoreCards, literalState, textStats } from './retrieve.js'

const MAX_CARDS = 3
const BUDGET_TOKENS = 1200
const TOKENS_PER_CARD = 40
const COOLDOWN_TURNS = 10
const MIN_SCORE = 2.5 // 低于这个分基本是「沾边」，宁可不提（idf 加权后，泛词几乎不加分）

export function createHintEngine({ dataDir, readConfig }) {
  /** sessionId → { turn, text, keys:Set, shown:Map<key,turn> } */
  const state = new Map()

  const cardKey = (c) => c.key || c.title
  const cardText = (c) => `· ${c.title} — ${c.one_line}`

  function pick(text) {
    if (!text || [...text].length < 2) return []
    const cards = loadCards({ dataDir })
    if (!cards.length) return []
    const q = { text, concepts: [], entities: [] }
    const stats = textStats(cards)
    const lit = literalState(cards, q, { stats })
    const covOf = (key) => (lit.covByKey.get(key) || {}).coverage || 0
    // 两个字面要求：分数过线 + 至少覆盖到一个库内词（纯泛词互相撞不算）
    const scored = scoreCards(cards, q, { stats })
      .filter((s) => !s.skipped && s.score >= MIN_SCORE && covOf(s.card.key) > 0)
      .slice(0, 12)
    if (!scored.length) return []
    const top = scored[0].score
    // 分数断崖：只留 ≥75% 头名的；若一大片贴着 90%（说明问得泛），只留头名 1 条
    const near = scored.filter((s) => s.score >= top * 0.9)
    if (near.length >= 5) return [scored[0]]
    return scored.filter((s) => s.score >= top * 0.75).slice(0, MAX_CARDS)
  }

  return {
    /** pre-step 时记下这一轮用户说了什么（只保留最后一次）。 */
    remember(sessionId, messages, turn) {
      const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user')
      const raw = (last && last.content) || []
      const text = raw.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim()
      if (!text) return
      const prev = state.get(sessionId)
      if (prev && prev.text === text && prev.turn === turn) return
      const cfg = (() => {
        try {
          return readConfig() || {}
        } catch {
          return {}
        }
      })()
      if (cfg.proactive === false) {
        state.set(sessionId, { turn, text, body: '' })
        return
      }
      const shown = prev ? prev.shown : new Map()
      const hits = pick(text).filter((s) => {
        const t = shown.get(cardKey(s.card))
        return t === undefined || turn - t >= COOLDOWN_TURNS
      })
      const usable = hits.slice(0, Math.max(1, Math.min(MAX_CARDS, Math.floor(BUDGET_TOKENS / TOKENS_PER_CARD))))
      const body = usable.length
        ? [
            '[记忆提示 · 可能相关]',
            ...usable.map((s) => cardText(s.card)),
            hits.length > usable.length ? `（另外还有 ${hits.length - usable.length} 条相关，说「展开」我列出来）` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : ''
      for (const s of usable) shown.set(cardKey(s.card), turn)
      state.set(sessionId, { turn, text, body, shown })
    },
    /** 装配时取这一段；没有就不出现（返回空串不影响 prompt）。 */
    render(sessionId) {
      const cur = state.get(sessionId)
      return (cur && cur.body) || ''
    },
    /** 面板/调试用：最近一次判定结果。 */
    peek(sessionId) {
      const cur = state.get(sessionId)
      return cur ? { turn: cur.turn, text: cur.text.slice(0, 60), body: cur.body } : null
    },
  }
}
