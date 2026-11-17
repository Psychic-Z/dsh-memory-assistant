#!/usr/bin/env node
/**
 * 导入器：导出后的 md → units → 批次（供模型抽卡）→ 校验合并进 cards.jsonl
 *
 *   node tools/import-memory.cjs units  --from ./export/sessions.md --out ./import
 *   node tools/import-memory.cjs batch  --from ./import/units.json --out ./import/batch --size 8
 *   node tools/import-memory.cjs merge  --cards "./import/cards/*.json" --data ./data
 *   node tools/import-memory.cjs stats  --data ./data
 *
 * 抽卡那一步由模型做（读 batch/*.json，写 cards/*.json）；本脚本只做切分与校验。
 */
const fs = require('fs')
const path = require('path')
const { appendFileSync } = fs

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const cmd = process.argv[2]

// 卡片归属：谁写的、跑在哪个平台。跨 agent 共享时靠它标出处（见 42 §8）
const OWNER = String(arg('owner', 'deepseek-harness'))
const PLATFORM = String(arg('platform', 'dsh'))

function readUnits(from) {
  const md = fs.readFileSync(from, 'utf8')
  const lines = md.split('\n')
  const units = []
  let session = ''
  let project = 'unknown'
  let cur = null
  for (const line of lines) {
    const m = line.match(/^## 会话 (\S+)/)
    if (m) {
      if (cur && cur.user.length) units.push(cur)
      cur = null
      session = m[1]
      project = 'unknown'
      continue
    }
    const pm = line.match(/^- 项目：(.+)$/)
    if (pm && !cur) {
      project = pm[1].trim()
      continue
    }
    if (line.startsWith('**【用户】**')) {
      if (cur) units.push(cur)
      // 同一行带着这条 user 消息的时间戳，顺手记下（不写进卡片，只作为 u→时间的旁路索引）
      const tm = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)
      cur = { id: `u${String(units.length + 1).padStart(4, '0')}`, session, project, ts: tm ? tm[1] : null, user: [], assistant: [] }
      continue
    }
    if (line.startsWith('**【助手】**')) {
      if (cur) cur.assistant.push('')
      continue
    }
    if (!cur) continue
    if (cur.assistant.length) cur.assistant[cur.assistant.length - 1] += line + '\n'
    else cur.user.push(line)
  }
  if (cur) units.push(cur)
  return units
    .map((u) => ({
      id: u.id,
      session: u.session,
      project: u.project || 'unknown',
      ts: u.ts || null,
      user: u.user.join('\n').trim(),
      assistant: u.assistant.map((s) => s.trim()).filter(Boolean),
    }))
    .map((u) => ({ ...u, chars: u.user.length + u.assistant.join('').length }))
    .filter((u) => u.user && u.chars > 20)
}

if (cmd === 'units') {
  const from = String(arg('from'))
  const out = path.resolve(String(arg('out', './import')))
  const units = readUnits(from)
  fs.mkdirSync(out, { recursive: true })
  const head = units.slice(0, 3).map((u) => ({ ...u, assistant: u.assistant.map((a) => a.slice(0, 120)) }))
  fs.writeFileSync(path.join(out, 'units.json'), JSON.stringify(units, null, 1))
  fs.writeFileSync(path.join(out, 'units.head.json'), JSON.stringify(head, null, 1))
  const solo = units.filter((u) => !u.assistant.length).length
  console.log(JSON.stringify({ units: units.length, chars: units.reduce((a, u) => a + u.chars, 0), user_only: solo, out }, null, 1))
}

if (cmd === 'batch') {
  const from = String(arg('from'))
  const size = Number(arg('size', 8))
  const out = path.resolve(String(arg('out', './import/batch')))
  const units = JSON.parse(fs.readFileSync(from, 'utf8'))
  fs.mkdirSync(out, { recursive: true })
  let n = 0
  for (let i = 0; i < units.length; i += size) {
    const part = units.slice(i, i + size)
    const file = path.join(out, `b${String(++n).padStart(2, '0')}.json`)
    fs.writeFileSync(file, JSON.stringify({ batch: n, units: part }, null, 1))
  }
  console.log(JSON.stringify({ batches: n, size, out }, null, 1))
}

if (cmd === 'merge') {
  const data = path.resolve(String(arg('data', './data')))
  const unitsPath = arg('units', null)
  let unitText = {}
  const uById = new Map()
  if (unitsPath && fs.existsSync(String(unitsPath))) {
    for (const u of JSON.parse(fs.readFileSync(String(unitsPath), 'utf8'))) {
      unitText[u.id] = (u.user + '\n' + u.assistant.join('\n')).replace(/\s+/g, '')
      uById.set(u.id, u)
    }
  }
  const conceptsPath = arg('concepts', './import/concepts_brief.json')
  let concepts = {}
  if (fs.existsSync(String(conceptsPath))) {
    for (const c of JSON.parse(fs.readFileSync(String(conceptsPath), 'utf8'))) {
      concepts[c.id] = c
    }
  }
  const pattern = String(arg('cards', './import/cards/*.json'))
  const dir = path.dirname(pattern)
  const re = new RegExp('^' + path.basename(pattern).replace('.', '\\.').replace('*', '.*') + '$')
  if (!fs.existsSync(dir)) {
    console.error('no cards dir:', dir)
    process.exit(1)
  }
  const files = fs.readdirSync(dir).filter((f) => re.test(f))
  const cardsPath = path.join(data, 'cards.jsonl')
  fs.mkdirSync(data, { recursive: true })
  let existing = 0
  const seen = new Set()
  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[，。、；：！？“”‘’（）《》【】…—\-·,.;:!?"'()]/g, '')
  if (fs.existsSync(cardsPath)) {
    const lines = fs.readFileSync(cardsPath, 'utf8').split('\n').filter(Boolean)
    existing = lines.length
    // 两道指纹：
    //  fp = 标题 + 引用原文（逐字重复）
    //  nl = 归一化标题 + 归一化一句话（同一件事被模型重写措辞后仍能认出来）
    for (const l of lines) {
      try {
        const c0 = JSON.parse(l)
        seen.add('fp:' + String(c0.title) + '|' + String((c0.pointer && c0.pointer.quote) || ''))
        seen.add('nl:' + squash(c0.title) + '|' + squash(c0.one_line))
      } catch (_) {}
    }
  }
  let next = existing + 1
  const bad = []
  let ok = 0
  let dup = 0
  for (const f of files) {
    let arr
    try {
      arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    } catch (e) {
      bad.push([f, 'json: ' + e.message])
      continue
    }
    const list = Array.isArray(arr) ? arr : arr.cards || []
    for (const c of list) {
      // user 侧只有「可以/好的/继续」这类回应时，卡片留在库里但不进候选
      // 大纲行超长时收尾加省略号（大纲是给人确认用的，截断不影响语义）
      if (Array.isArray(c.outline)) {
        const cut = []
        c.outline = c.outline.map((line, i) => {
          const L = [...String(line)]
          if (L.length <= 22) return String(line)
          cut.push(i + 1)
          return L.slice(0, 21).join('') + '…'
        })
        if (cut.length) c.outline_trimmed = cut.length
      }
      const uTxt = (uById.get(c.u) || {}).user || ''
      if ([...String(uTxt).trim()].length < 8) {
        // 只有「回应词」的卡才降级：若关键词本身有内容（不是 可以/好的/继续 这类），
        // 说明这张卡记的是这一轮真正发生的事，仍应可检索
        const STOP = new Set(['可以', '好的', '好', '同意', '继续', '明白', '收到', '对', '是', '行', '嗯', '补', '该你了', '定稿吧', '好，做', '可以，做'])
        const kws = c.keywords || []
        const substantive = kws.filter((k) => !STOP.has(String(k))).length
        c.kw_short = true
        if (substantive < 2) c.low_signal = true
      }
      const errs = validate(c)
      if (unitsPath && unitText[c.u] && c.quote && !unitText[c.u].includes(String(c.quote).replace(/\s+/g, ''))) {
        errs.push('quote not verbatim in unit ' + c.u)
      }
      const cs = (c.codes && c.codes.concept) || []
      if (Object.keys(concepts).length) {
        if (cs.length < 2 || cs.length > 4) errs.push('codes 2-4')
        const hay = ((unitText[c.u] || '') + ' ' + (c.keywords || []).join(' ')).replace(/\s+/g, '')
        for (const id of cs) {
          const cc = concepts[id]
          if (!cc) { errs.push('unknown code ' + id); continue }
          const forms = [cc.name, ...(cc.aliases || [])].filter(Boolean)
          if (!forms.some((f) => hay.includes(String(f).replace(/\s+/g, '')))) errs.push('code unsupported ' + id)
        }
      }
      if (errs.length) {
        bad.push([f + '#' + (c.title || '?'), errs.join(';')])
        continue
      }
      const fp = 'fp:' + String(c.title) + '|' + String(c.quote)
      const nl = 'nl:' + squash(c.title) + '|' + squash(c.one_line)
      if (seen.has(fp) || seen.has(nl)) {
        dup++
        continue
      }
      const key = 'w:' + String(next++).padStart(4, '0')
      appendFileSync(
        cardsPath,
        JSON.stringify({
          key,
          title: c.title,
          one_line: c.one_line,
          outline: c.outline,
          keywords: c.keywords,
          // 2026-11-18：topics（主题词）必须在这里带上——
          // 这个对象是**白名单**，没列出来的字段会被丢掉（模型给了 topics 也留不下）。
          topics: Array.isArray(c.topics) && c.topics.length ? c.topics : undefined,
          kw_short: c.kw_short === true || c.keywords.length < 3 || undefined,
          low_signal: c.low_signal === true || undefined,
          outline_trimmed: c.outline_trimmed || undefined,
          codes: c.codes || {},
          entities: c.entities || [],
          pointer: { u: c.u, quote: c.quote, project: (uById.get(c.u) || {}).project || 'unknown' },
          kind: c.kind || 'fact',
          status: 'active',
          source: 'import',
          owner: OWNER,
          platform: PLATFORM,
        }) + '\n'
      )
      ok++
      seen.add(fp)
      seen.add(nl)
    }
  }
  console.log(JSON.stringify({ files: files.length, added: ok, rejected: bad.length, duplicates: dup, existing, sample: bad.slice(0, 5) }, null, 1))
}

function validate(c) {
  const e = []
  if (!c.title || [...c.title].length > 20) e.push('title>20')
  if (!c.one_line || [...c.one_line].length > 40) e.push('one_line>40')
  if (!Array.isArray(c.outline) || c.outline.length !== 3) e.push('outline!=3')
  else if (c.outline.some((x) => [...String(x)].length > 22)) e.push('outline line>22')
  const low = c.kw_short === true || c.low_signal === true
  const kwMin = low ? 1 : 3
  if (!Array.isArray(c.keywords) || c.keywords.length < kwMin || c.keywords.length > 6) e.push('keywords ' + kwMin + '-6')
  if (!c.quote || [...c.quote].length > 40) e.push('quote>40')
  if (!c.u) e.push('no u')
  for (const k of ['ask_hints', 'usage_cues', 'ask_queries', 'trigger', 'question']) {
    if (k in c) e.push('forbidden key ' + k)
  }
  return e
}

if (cmd === 'stats') {
  const data = path.resolve(String(arg('data', './data')))
  const p = path.join(data, 'cards.jsonl')
  const cards = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
  const fb = path.join(data, 'feedback.jsonl')
  const fbs = fs.existsSync(fb) ? fs.readFileSync(fb, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const good = fbs.filter((f) => f.verdict === 'good').length
  const partial = fbs.filter((f) => f.verdict === 'partial').length
  console.log(JSON.stringify({ cards: cards.length, feedback: fbs.length, satisfaction: fbs.length ? (good + 0.5 * partial) / fbs.length : null }, null, 1))
}
