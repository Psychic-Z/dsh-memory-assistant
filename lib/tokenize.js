// 中文不分词，取二元组；英文按词。
//
// 功能字过滤（三态输出要用它）：凡是含这些字的二元组一律丢掉。
// 「公告板是怎么丢的」里的「板是 / 是怎 / 么丢 / 丢的」都是跨词边界的噪声，
// 它们的 df 常常是 0–9，按 idf 算反而权重最高 —— 不丢就会把「精确命中」永远压到 0.2。
const FUNC = new Set('的了是在有和就都而及与着或吗呢吧啊呀哦么怎什哪谁这那我你他她它们个把被给对从到为以之其也还又很太更最不没'.split(''))

const STOP = new Set([
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '一下', '可以', '需要', '应该',
  // 指示时间/泛指的虚词：留着只会让「今天天气不错」也弹出记忆提示
  '今天', '昨天', '明天', '现在', '刚才', '最近', '以后', '之前', '然后', '这样', '那样', '东西', '事情', '时候',
])

export function isFuncChar(ch) {
  return FUNC.has(ch)
}

export function tokens(s) {
  const out = []
  const text = String(s || '').toLowerCase()
  for (const m of text.matchAll(/[a-z][a-z0-9_.#-]{1,}/g)) out.push(m[0])
  const cjk = text.replace(/[^\u4e00-\u9fa5]+/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    if (seg.length === 1) {
      if (!STOP.has(seg) && !FUNC.has(seg)) out.push(seg)
      continue
    }
    for (let i = 0; i + 1 < seg.length; i++) {
      const bg = seg.slice(i, i + 2)
      if (STOP.has(bg)) continue
      if (FUNC.has(bg[0]) || FUNC.has(bg[1])) continue
      out.push(bg)
    }
  }
  return out
}

export function overlap(aTokens, bTokens) {
  const b = new Set(bTokens)
  let hit = 0
  const seen = new Set()
  for (const t of aTokens) {
    if (seen.has(t)) continue
    seen.add(t)
    if (b.has(t)) hit++
  }
  return hit
}

/**
 * 内容单字：二元组会把「丢 / 删 / 改」这种单字动词吃掉（「是怎么丢的」整段都是功能字），
 * 打分时补一层单字命中，让「公告板被清空丢 47 轮」压过「读公告板收到两条回信」。
 */
export function contentChars(s) {
  const out = new Set()
  for (const ch of String(s || '')) {
    if (/[\u4e00-\u9fa5]/.test(ch) && !FUNC.has(ch) && !STOP.has(ch)) out.add(ch)
  }
  return [...out]
}
