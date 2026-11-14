/**
 * 导入执行器：导出 → 切段 → 分批 → 【插件自己调模型抽卡】 → 逐批校验入库。
 *
 * 与 bin/mem.js 的 import 子命令共用同一套 tools（export-sessions.cjs / import-memory.cjs），
 * 也用同一套校验：卡片先落到 import/cards/bNN.json，再交给 import-memory.cjs merge 判定，
 * 所以「插件自动跑」和「模型手工跑」产出的是同一种卡、走同一条校验。
 *
 * 设计约束：
 * - 一次只跑一个导入（Host 级单例），每批落盘，断了从最小未完成批续跑；
 * - 任何一批失败只记录并停下，不删已有卡片；
 * - 抽卡提示词与格式禁令跟 SKILL.md 一致（第 11 条：不许出现预设提问字段）。
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { writeConcepts } from './concepts.js'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = () => join(homedir(), '.dsh', 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 读会话文件第一帧里的 header（用来区分主会话 / 子智能体会话）。
 *  只读文件头几十 KB：15 MB 的会话也秒回，不会为了看一眼 header 把整个文件读进内存。 */
function readSessionHeader(file, cap = 64 * 1024) {
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(cap)
    let n = 0
    try {
      n = readSync(fd, buf, 0, cap, 0)
    } finally {
      closeSync(fd)
    }
    const head = buf.subarray(0, n)
    const next = head.indexOf(ZSTD_MAGIC, 1)
    const end = next > 0 ? next : head.length
    const first = zstdDecompressSync(head.subarray(0, end)).toString('utf8').split('\n')[0]
    const parsed = JSON.parse(first)
    return parsed && parsed.type === 'session' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 找「当前对话」：所有工作区里 mtime 最新的 **主会话**（跳过子智能体）。
 * 返回 {sessionId, workspace, mtime, cwd} 或 null。
 */
/** 目录名当项目名；`.../workspace` 这种通用名退一级（取上一级目录）。 */
export function projectNameOf(cwd) {
  const segs = String(cwd || '').split(/[\\/]/).filter(Boolean)
  if (!segs.length) return ''
  let name = segs[segs.length - 1]
  if (name === 'workspace' && segs.length > 1) name = segs[segs.length - 2]
  return name
}

export function pickCurrentSession() {
  const base = SESSIONS()
  if (!existsSync(base)) return null
  let best = null
  for (const ws of readdirSync(base)) {
    const wsDir = join(base, ws)
    let names
    try {
      names = readdirSync(wsDir)
    } catch {
      continue
    }
    for (const sid of names) {
      const file = join(wsDir, sid, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const mtime = statSync(file).mtimeMs
      if (best && mtime <= best.mtime) continue
      const head = readSessionHeader(file)
      if (!head || head.origin === 'subagent') continue
      best = { sessionId: sid, workspace: ws, mtime, cwd: head.cwd || '' }
    }
  }
  return best
}

/** 数一下导一次大概多大，并按工作区拆开（面板要回答「会导入哪些项目」）。
 *  只读每个会话的头部；结果缓存 60 秒，避免面板轮询时反复扫 200 个文件。 */
let previewMemo = { at: 0, value: null }
export function preview(scope) {
  if (scope === 'current') {
    const s = pickCurrentSession()
    if (!s) return { scope, sessions: 0, bytes: 0 }
    const file = join(SESSIONS(), s.workspace, s.sessionId, 'session.v4.jsonl.zstd')
    return {
      scope,
      sessions: 1,
      bytes: statSync(file).size,
      session: s.sessionId,
      mtime: s.mtime,
      project: s.cwd ? projectNameOf(s.cwd) : null,
    }
  }
  if (Date.now() - previewMemo.at < 60_000 && previewMemo.value) return previewMemo.value
  const base = SESSIONS()
  let main = 0
  let sub = 0
  let bytes = 0
  const workspaces = []
  for (const ws of readdirSync(base)) {
    let names
    try {
      names = readdirSync(join(base, ws))
    } catch {
      continue
    }
    let wMain = 0
    let wSub = 0
    let cwd = ''
    for (const sid of names) {
      const file = join(base, ws, sid, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const head = readSessionHeader(file)
      if (!head) continue
      if (head.origin === 'subagent') {
        sub++
        wSub++
      } else {
        main++
        wMain++
        bytes += statSync(file).size
        if (!cwd && head.cwd) cwd = head.cwd
      }
    }
    if (wMain || wSub) {
      const name = cwd ? projectNameOf(cwd) : ws.replace(/^--|--$/g, '')
      workspaces.push({ workspace: ws, project: name, cwd: cwd || null, sessions: wMain, subagentSessions: wSub })
    }
  }
  workspaces.sort((a, b) => b.sessions - a.sessions)
  const value = { scope, sessions: main, subagentSessions: sub, bytes, workspaces }
  previewMemo = { at: Date.now(), value }
  return value
}

/** 抽卡提示词：与 SKILL.md 的格式/禁令一致。 */
function buildPrompt(batch) {
  const units = batch.units
    .map((u) => {
      const assistant = (u.assistant || []).join('\n')
      const a = assistant.length > 2500 ? assistant.slice(0, 2500) + '…' : assistant
      return `### ${u.id}（项目 ${u.project}）\n【用户】${u.user}\n【助手】${a}`
    })
    .join('\n\n')
  return `你在给一个「记忆助理」插件抽记忆卡。下面是 ${batch.units.length} 段对话，每段是一个 unit。

对**每一个 unit** 产出 1–3 张卡片（这段话里确实发生了什么才有卡；纯寒暄、纯确认、没有实质内容的可以 0 张）。

若某段里出现 [附件 图片 …] 或 [附件 文件 …] 这样的行，那是这一轮真实收到/发出的文件：要把它当成"发生的这件事"记下来（大纲里写清是什么文件，文件名里的词放进 keywords 或 entities），**不要当噪声跳过**；但也不要替它编内容。

只输出一个 JSON 数组，不要解释、不要代码块。每张卡字段：

- "u": unit 的 id，原样（例如 "u0012"）
- "title": 动宾结构，≤20 字（"定赎回费率按持有时间分档"）
- "one_line": ≤40 字，一句话说清这件事
- "outline": 恰好 3 行字符串数组，每行 ≤22 字，分别回答：是什么 / 何时成立或怎么做 / 做错会怎样
- "keywords": 3–6 个，**必须抄原文里出现过的词**（至少 1 个来自【用户】那句），不要同义改写
- "entities": 0–3 个专名（人名、项目名、文件名的原文写法）
- "quote": ≤40 字，**从【用户】原文逐字摘**，不许改写、不许拼接
- "kind": "fact" | "decision" | "rule" | "incident" | "lesson" 之一

硬禁令（出现即整张卡作废）：
- 不许出现 ask_hints / usage_cues / ask_queries / trigger / question 这些键
- 不许编日期、不许猜用户没说过的话、不许把助手的话当用户原话

对话如下：

${units}`
}

/**
 * 从模型输出里抠出 JSON 数组。三级容错：
 * 1) 去掉 ```json 围栏与前后废话，直接 parse；
 * 2) 解析失败 → 逐个抠「完整的对象」（输出被截断时，前面完整的卡照样能救回来）；
 * 3) 一个都救不回 → 返回空数组，由调用方决定重试还是记失败。
 */
export function parseCards(text) {
  let s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('[')
  if (start >= 0) s = s.slice(start)
  try {
    const parsed = JSON.parse(s.replace(/,\s*$/, ''))
    const list = Array.isArray(parsed)
      ? parsed
      : parsed.cards || parsed.items || parsed.concepts || parsed.list || parsed.data || parsed.result || []
    if (Array.isArray(list) && list.length) return list
    // 模型偶尔把数组包在一个对象里：取「最长的那个数组」
    if (parsed && typeof parsed === 'object') {
      const arrs = Object.values(parsed).filter((v) => Array.isArray(v))
      if (arrs.length) return arrs.sort((a, b) => b.length - a.length)[0]
    }
  } catch {}
  // JSONL 兜底：一行一个对象
  {
    const rows = s
      .split('\n')
      .map((l) => l.trim().replace(/,$/, ''))
      .filter((l) => l.startsWith('{') && l.endsWith('}'))
    if (rows.length) {
      const objs = []
      for (const r of rows) {
        try {
          objs.push(JSON.parse(r))
        } catch {}
      }
      if (objs.length) return objs
    }
  }
  // 截断兜底：按括号配深，逐个取出完整对象
  const out = []
  let depth = 0
  let inStr = false
  let esc = false
  let cur = ''
  for (const ch of s) {
    if (inStr) {
      cur += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      cur += ch
      continue
    }
    if (ch === '{') {
      if (depth === 0) cur = ''
      depth++
      cur += ch
      continue
    }
    if (ch === '}') {
      depth--
      cur += ch
      if (depth === 0) {
        try {
          out.push(JSON.parse(cur))
        } catch {}
      }
      continue
    }
    if (depth > 0) cur += ch
  }
  return out
}

const FORBIDDEN = ['ask_hints', 'usage_cues', 'ask_queries', 'trigger', 'question']
const clamp = (v, n) => {
  const chars = [...String(v == null ? '' : v)]
  return chars.length <= n ? chars.join('') : chars.slice(0, n).join('')
}
const squash = (s) => String(s || '').replace(/\s+/g, '')

/**
 * 把模型给的卡削到「校验一定过」的形状：长度截断、quote 回落到 user 原文、
 * 关键词补一个用户原话词、删掉禁用键。语义仍由后续 merge 复核（quote 必须逐字在 unit 里）。
 */
function sanitize(card, unit) {
  const user = String((unit && unit.user) || '')
  const out = {}
  out.u = String(card.u || (unit && unit.id) || '')
  out.title = clamp(card.title, 20)
  out.one_line = clamp(card.one_line, 40)
  const outline = Array.isArray(card.outline) ? card.outline : []
  out.outline = [0, 1, 2].map((i) => clamp(outline[i] || '', 22))
  let kw = (Array.isArray(card.keywords) ? card.keywords : []).map((k) => clamp(k, 12)).filter(Boolean)
  if (kw.length < 3) {
    // 从 user 原文里补词（二元组），保证至少有 1 个「用户原话词」
    const chars = [...squash(user)]
    for (let i = 0; i + 2 <= chars.length && kw.length < 3; i += 2) kw.push(chars.slice(i, i + 2).join(''))
  }
  kw = [...new Set(kw)].slice(0, 6)
  out.keywords = kw
  out.entities = (Array.isArray(card.entities) ? card.entities : []).map((e) => clamp(e, 20)).filter(Boolean).slice(0, 3)
  let quote = clamp(card.quote, 40)
  if (!quote || !squash(user).includes(squash(quote))) {
    // 逐字校验过不了就退回 user 原文开头（仍是逐字片段）
    quote = clamp(user.trim(), 40)
  }
  out.quote = quote
  out.kind = ['fact', 'decision', 'rule', 'incident', 'lesson'].includes(card.kind) ? card.kind : 'fact'
  for (const k of FORBIDDEN) delete out[k]
  return out
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir  数据目录（~/.dsh-memory-assistant）
 * @param {string} deps.toolsDir 插件 tools 目录
 * @param {{stream: Function}} deps.llm  host 的 ctx.llm
 * @param {() => ({provider:string, model:string, reasoningEffort?:string})} deps.model 取默认模型
 * @param {(msg:string)=>void} [deps.log]
 */
export function createImporter(deps) {
  const { dataDir, toolsDir, llm, model, log = () => {}, owner = 'deepseek-harness', platform = 'dsh' } = deps
  const statePath = join(dataDir, 'import.state.json')
  const onboardingPath = join(dataDir, 'onboarding.json')
  const exportDir = join(dataDir, 'export')
  const importDir = join(dataDir, 'import')
  const cardsDir = join(importDir, 'newcards')

  let controller = null
  let running = false

  const readJson = (p, def) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return def
    }
  }
  const writeJson = (p, v) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(v, null, 1))
  }
  const state = () => readJson(statePath, null)
  const onboarding = () => readJson(onboardingPath, { status: 'pending' })
  const setOnboarding = (v) => writeJson(onboardingPath, v)

  const runTool = (script, args) =>
    execFileSync(process.execPath, [join(toolsDir, script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

  const cards = () => {
    const p = join(dataDir, 'cards.jsonl')
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0
  }

  /** 每场会话「已库到哪个时刻」：增量导入靠它判断哪些段是新的。 */
  const coveredPath = join(importDir, 'covered.json')
  const covered = () => readJson(coveredPath, {})
  const markCovered = (units) => {
    const cur = covered()
    let changed = false
    for (const u of units || []) {
      if (!u || !u.session || !u.ts) continue
      if (!cur[u.session] || u.ts > cur[u.session]) {
        cur[u.session] = u.ts
        changed = true
      }
    }
    if (changed) writeJson(coveredPath, cur)
  }

  // ── 防重复：以「段」为单位记指纹，比卡片指纹可靠（不受模型措辞变化影响）──
  // 指纹主体是**内容**（用户原话 + 助手开头），不带会话 id：
  //   同一段对话被复制进另一个会话（fork / 另存 / 再导一次）→ 指纹相同 → 直接跳过。
  // 短句（<12 字，如"可以""继续"）内容太弱，退回「会话+时间+内容」的老口径，避免误杀。
  const importedUnitsPath = join(importDir, 'imported-units.json')
  const unitFingerprint = (u) => {
    const user = squash(u.user || '')
    const asst = squash((u.assistant || []).join(' ')).slice(0, 200)
    const strong = [...user].length >= 12 && [...asst].length >= 40
    const base = strong ? `c|${user}|${asst}` : `s|${u.session || ''}|${u.ts || ''}|${user}|${asst}`
    return createHash('sha1').update(base).digest('hex').slice(0, 20)
  }
  const importedUnits = () => readJson(importedUnitsPath, {})
  const markImported = (units) => {
    const cur = importedUnits()
    let changed = false
    for (const u of units || []) {
      const fp = unitFingerprint(u)
      if (!cur[fp]) {
        cur[fp] = { session: u.session || null, ts: u.ts || null, at: new Date().toISOString() }
        changed = true
      }
    }
    if (changed) writeJson(importedUnitsPath, cur)
  }

  /** 按会话聚合：哪几场进了库、各多少卡、时间跨度、标题。面板与 `mem sessions` 共用。 */
  let sessionsMemo = { at: 0, value: null }
  const sessions = () => {
    if (Date.now() - sessionsMemo.at < 30_000 && sessionsMemo.value) return sessionsMemo.value
    const p = join(dataDir, 'cards.jsonl')
    if (!existsSync(p)) return []
    const unitsPath = join(importDir, 'unit-index.json')
    const legacyUnits = join(importDir, 'units.json')
    const units = existsSync(unitsPath) ? readJson(unitsPath, []) : existsSync(legacyUnits) ? readJson(legacyUnits, []) : []
    // 索引是 {u:{session,ts}}；老格式是数组。两种都吃
    const pairs = Array.isArray(units) ? units.map((u) => [u.id, u]) : Object.entries(units).map(([id, v]) => [id, v])
    const uSession = new Map(pairs.map(([id, v]) => [id, v && v.session]))
    const uTs = new Map(pairs.map(([id, v]) => [id, v && v.ts]))
    // 标题从导出的 md 头部取：## 会话 <id> · <title>
    const titles = new Map()
    const mdPath = join(dataDir, 'export', 'sessions.md')
    if (existsSync(mdPath)) {
      const md = readFileSync(mdPath, 'utf8')
      for (const m of md.matchAll(/^## 会话 (\S+?)(?: · (.+))?$/gm)) titles.set(m[1], (m[2] || '').trim())
    }
    const map = new Map()
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue
      let c
      try {
        c = JSON.parse(line)
      } catch {
        continue
      }
      const sid = uSession.get(c.pointer && c.pointer.u) || 'unknown'
      const cur = map.get(sid) || { session: sid, title: titles.get(sid) || '', cards: 0, from: null, to: null }
      cur.cards++
      const ts = uTs.get(c.pointer && c.pointer.u)
      if (ts) {
        if (!cur.from || ts < cur.from) cur.from = ts
        if (!cur.to || ts > cur.to) cur.to = ts
      }
      map.set(sid, cur)
    }
    const value = [...map.values()].sort((a, b) => b.cards - a.cards)
    sessionsMemo = { at: Date.now(), value }
    return value
  }

  /** 按卡片上的 pointer.project 分组：这就是「导入了哪些项目」的答案。
   *  顺带给出每个项目「最近一条卡」的时间——来自 u→时间的旁路索引（卡片本身仍不存日期）。 */
  const cardsByProject = () => {
    const p = join(dataDir, 'cards.jsonl')
    if (!existsSync(p)) return []
    const times = readJson(join(importDir, 'unit-times.json'), {})
    const map = new Map()
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue
      let c
      try {
        c = JSON.parse(line)
      } catch {
        continue
      }
      const proj = (c.pointer && c.pointer.project) || 'unknown'
      const cur = map.get(proj) || { project: proj, cards: 0, latest: null }
      cur.cards++
      const ts = times[(c.pointer && c.pointer.u) || '']
      if (ts && (!cur.latest || ts > cur.latest)) cur.latest = ts
      map.set(proj, cur)
    }
    return [...map.values()].sort((a, b) => b.cards - a.cards)
  }

  function status() {
    const st = state()
    const ob = onboarding()
    // 概念表与打码覆盖率（面板要能说清「新机器上表建了没有」）
    let total = 0
    let coded = 0
    const cp = join(dataDir, 'cards.jsonl')
    if (existsSync(cp)) {
      for (const line of readFileSync(cp, 'utf8').split('\n')) {
        if (!line) continue
        total++
        try {
          const c = JSON.parse(line)
          if (c.codes && Array.isArray(c.codes.concept) && c.codes.concept.length) coded++
        } catch (_) {}
      }
    }
    return {
      imported: !!(st && st.done && st.done.length),
      cards: total,
      // blank：看过但没有任何码在字面上站得住脚的卡（按规则留空，不是失败）。面板要说清楚，否则像漏打。
      codes: {
        concepts: Object.keys(conceptsTable()).length,
        coded,
        total,
        blank: total - coded,
        blankKnown: ((st && st.codes && st.codes.blank) || []).length,
        failed: (st && st.codes && st.codes.failed) || 0,
        lastError: (st && st.codes && st.codes.lastError) || null,
      },
      projects: cardsByProject(),
      sessions: sessions().slice(0, 20),
      onboarding: ob.status,
      run: st
        ? {
            scope: st.scope || 'all',
            session: st.session || null,
            status: st.status || (st.pending && st.pending.length ? 'paused' : 'done'),
            units: st.units || 0,
            batches: st.batches || 0,
            done: (st.done || []).length,
            pending: st.pending || [],
            error: st.error || null,
            updated: st.updated_at || st.started_at || null,
            cardsAdded: st.cards_added || 0,
            model: st.model || null,
            codes: st.codes || null,
          }
        : null,
    }
  }

  /** 导出 + 切段 + 分批；返回 state。 */
  function prepare(scope = 'current') {
    mkdirSync(exportDir, { recursive: true })
    mkdirSync(importDir, { recursive: true })
    const picked = scope === 'current' ? pickCurrentSession() : null
    if (scope === 'current' && !picked) throw new Error('找不到当前会话（可能还没产生过对话）')
    const exportArgs = ['--out', exportDir]
    if (picked) exportArgs.push('--session', picked.sessionId)
    // 「全部」= 所有工作区（不只是当前这一个）；「当前」= 最近活跃的那一场
    else exportArgs.push('--workspace', 'all')
    const exp = JSON.parse(runTool('export-sessions.cjs', exportArgs))
    const units = JSON.parse(runTool('import-memory.cjs', ['units', '--from', join(exportDir, 'sessions.md'), '--out', importDir]))
    // 「全部」= 补齐还没导过的工作区；已经导过的项目不重跑（省 token，也不会重复出卡）
    let unitList = JSON.parse(readFileSync(join(importDir, 'units.json'), 'utf8'))
    // u → 时间 的旁路索引（卡片本身不存日期，但面板要能说「这个项目最近一条卡是什么时候」）
    const prevTimes = readJson(join(importDir, 'unit-times.json'), {})
    const fresh = {}
    for (const u of unitList) if (u.id && u.ts) fresh[u.id] = u.ts
    writeJson(join(importDir, 'unit-times.json'), { ...prevTimes, ...fresh })
    // 持久化 u→会话 索引（units.json 会被下一次 prepare 覆盖，索引不能）
    const prevIndex = readJson(join(importDir, 'unit-index.json'), {})
    const freshIndex = {}
    for (const u of unitList) if (u.id) freshIndex[u.id] = { session: u.session || null, ts: u.ts || null }
    writeJson(join(importDir, 'unit-index.json'), { ...prevIndex, ...freshIndex })
    let skippedUnits = 0
    // 第一道闸：段级幂等。同一段对话只要入过库，任何入口再来都跳过（不受模型措辞变化影响）
    {
      const seen = importedUnits()
      const before = unitList.length
      unitList = unitList.filter((u) => !seen[unitFingerprint(u)])
      skippedUnits += before - unitList.length
      if (!unitList.length) {
        writeFileSync(join(importDir, 'units.json'), JSON.stringify([], null, 1))
        throw new Error('这些对话已经全部入过库了，没有新内容可导')
      }
      writeFileSync(join(importDir, 'units.json'), JSON.stringify(unitList, null, 1))
    }
    if (scope === 'all') {
      const done = new Set(cardsByProject().map((p) => p.project))
      const before = unitList.length
      unitList = unitList.filter((u) => !done.has(u.project))
      skippedUnits += before - unitList.length
      if (!unitList.length) throw new Error('这些工作区都已经导入过了，没有新的可导')
      writeFileSync(join(importDir, 'units.json'), JSON.stringify(unitList, null, 1))
    } else if (scope === 'incremental' || scope === 'current') {
      // 增量 / 只导当前：都只取「这场会话比上次入库更晚」的段；没进过库的会话整场都要
      const cov = covered()
      const before = unitList.length
      unitList = unitList.filter((u) => {
        const mark = cov[u.session]
        if (!mark) return true
        if (!u.ts) return false
        return u.ts > mark
      })
      skippedUnits += before - unitList.length
      if (!unitList.length) throw new Error('没有新的对话内容（上次入库之后没有新消息）')
      writeFileSync(join(importDir, 'units.json'), JSON.stringify(unitList, null, 1))
    }
    const batches = JSON.parse(
      runTool('import-memory.cjs', ['batch', '--from', join(importDir, 'units.json'), '--out', join(importDir, 'batch'), '--size', '8']),
    )
    const st = {
      version: 2,
      source: join(exportDir, 'sessions.md'),
      scope,
      session: picked ? picked.sessionId : null,
      started_at: new Date().toISOString(),
      units: unitList.length,
      chars: unitList.reduce((a, u) => a + (u.chars || 0), 0),
      skipped_units: skippedUnits,
      batches: batches.batches,
      done: [],
      pending: Array.from({ length: batches.batches }, (_, i) => i + 1),
      batch_dir: join(importDir, 'batch'),
      status: 'prepared',
      sessions: new Set(unitList.map((u) => u.session)).size,
      model: null,
      cards_added: 0,
    }
    writeJson(statePath, st)
    log(`prepare: ${st.sessions} 场 / ${st.units} 段 / ${st.batches} 批`)
    return st
  }

  /** 一次模型调用：抽卡、建表、打码都用它，保证模型/取消/错误处理只有一套。 */
  async function callModel(prompt, maxTokens = 8000, system = '你是严谨的记忆抽取器。只输出 JSON 数组，不解释。') {
    const sel = model()
    if (!sel || !sel.provider || !sel.model) throw new Error('没有可用的默认模型，无法自动处理')
    const opts = {
      provider: sel.provider,
      model: sel.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      system,
      maxTokens,
      temperature: 0.2,
    }
    // 这些是「结构化搬运」任务，不需要长推理；带上 high 会把 maxTokens 全烧进 reasoning，正文为空
    // 明示低推理：深链路的默认档常常是 high（实测 25,873 字符推理 / 0 字符正文）
    opts.reasoningEffort = 'low'
    if (controller) opts.signal = controller.signal
    let text = ''
    let sawDelta = false
    let reasoning = 0
    let finishKind = null
    let failure = null
    for await (const chunk of llm.stream(opts)) {
      if (chunk.type === 'text-delta') {
        sawDelta = true
        text += chunk.text
      } else if (chunk.type === 'reasoning-delta') {
        reasoning += String(chunk.text || '').length
      } else if (chunk.type === 'block-end') {
        const b = chunk.block || {}
        if (!sawDelta && b.type === 'text' && b.text) text += b.text
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason && chunk.reason.kind
        if (chunk.reason && chunk.reason.kind === 'error') failure = chunk.reason.failure
      }
    }
    if (failure) throw new Error(`模型报错：${failure.message || failure.code || 'unknown'}`)
    if (!text.trim()) {
      throw new Error(`模型没返回正文（finish=${finishKind || '?'}，推理片段 ${reasoning} 字符）`)
    }
    return { text, provider: sel.provider, model: sel.model }
  }

  const extractBatch = (batch) => callModel(buildPrompt(batch), 12000)

  /** 跑一批：抽卡 → 落文件 → merge（校验入库）→ 记进度。 */
  async function runBatch(n) {
    const file = join(importDir, 'batch', `b${String(n).padStart(2, '0')}.json`)
    if (!existsSync(file)) throw new Error(`缺批次文件 ${file}`)
    const batch = readJson(file, null)
    const { text, provider, model: m } = await extractBatch(batch)
    let list = parseCards(text)
    if (!list.length) {
      // 一次重试：明确要求「只输出 JSON 数组」，并把上限抬上去（截断是这次失败的主因）
      const retry = await callModel(
        buildPrompt(batch) + '\n\n再强调一次：只输出 JSON 数组本身，不要解释、不要代码块围栏、不要省略号。',
        16000,
      )
      list = parseCards(retry.text)
      if (!list.length) {
        const tail = String(text).slice(-120)
        throw new Error(`模型返回无法解析成 JSON（${String(text).length} 字符，尾部：…${tail}）`)
      }
    }
    const byId = new Map(batch.units.map((u) => [u.id, u]))
    const cards = list
      .filter((c) => c && byId.has(String(c.u)))
      .map((c) => sanitize(c, byId.get(String(c.u))))
    mkdirSync(cardsDir, { recursive: true })
    const out = join(cardsDir, `b${String(n).padStart(2, '0')}.json`)
    writeFileSync(out, JSON.stringify(cards, null, 1))
    const merged = JSON.parse(
      runTool('import-memory.cjs', [
        'merge',
        '--cards',
        out,
        '--units',
        join(importDir, 'units.json'),
        '--concepts',
        join(importDir, '_none.json'),
        '--data',
        dataDir,
        '--owner',
        owner,
        '--platform',
        platform,
      ]),
    )
    // 这一批入库成功 → 把这批里的会话时刻推后，下次增量从这里往后取；同时记下段指纹
    markCovered(batch.units)
    markImported(batch.units)
    return { added: merged.added, rejected: merged.rejected, sample: merged.sample, provider, model: m, generated: cards.length }
  }

  const cardsPath = join(dataDir, 'cards.jsonl')
  const conceptsPath = join(dataDir, 'concepts.json')
  const conceptsTable = () => readJson(conceptsPath, {})
  const readCardLines = () => (existsSync(cardsPath) ? readFileSync(cardsPath, 'utf8').split('\n').filter(Boolean) : [])
  const cardText = (c) =>
    [c.title, c.one_line, ...(c.outline || []), ...(c.keywords || []), (c.pointer && c.pointer.quote) || ''].join(' ')

  /**
   * 建概念对照表：从库里已有卡片归纳「事类 + 专业术语」，分领域、带 2–4 个别名。
   * 只在表还小的时候做（已有表就只补新概念），这样新机器装完第一次导入就自动有表，
   * 不需要任何人提醒，也不依赖外部词典。
   */
  async function buildConcepts({ limit = 80 } = {}) {
    const lines = readCardLines()
    if (!lines.length) return { concepts: 0, added: 0 }
    const existing = conceptsTable()
    const have = Object.keys(existing).length
    // 不再「到 120 就冻结」：每次最多新增 20 个，既能让新领域进来，也不会一次把表撑乱
    const MAX_NEW = 20
    // 均匀抽样：只取「最近 N 张」会让表被最近一个话题垄断（实测 20 个码全是"记忆助理"，
    // 只覆盖 29/717 张卡）。按等距跨全库取，才能覆盖所有项目与时段。
    const step = Math.max(1, Math.floor(lines.length / limit))
    const sample = []
    for (let i = 0; i < lines.length && sample.length < limit; i += step) {
      try {
        const c = JSON.parse(lines[i])
        sample.push({ t: c.title, k: c.keywords })
      } catch (_) {}
    }
    const known = Object.entries(existing)
      .slice(0, 200)
      .map(([id, c]) => `${id} ${c.name}（${(c.aliases || []).join('/')}）`)
    const makePrompt = (rows) =>
      `你在为一个「记忆助理」建概念对照表：把同一个意思的不同说法归并成一个码，检索时两端都查码。\n` +
      `下面是这位用户记忆库里的卡片标题与关键词样例（${rows.length} 条）：\n${JSON.stringify(rows)}\n\n` +
      (known.length ? `已有概念（沿用，不要重复造）：\n${known.join('\n')}\n\n` : '') +
      (have
        ? `已有 ${have} 个概念（见上，不要重复造）。请只补充 **10–20 个**这批卡片里新出现的事类或专业术语，`
        : `请归纳 60 个以内的概念，覆盖这些卡片里反复出现的事类与专业术语，`) +
      `按领域分组（如 投资交易/数据口径/协作治理/工程工具/记忆架构/写作方法/评测实验）。\n` +
      `每个概念：{"domain":"领域","name":"≤8字","aliases":["2–4 个同义或上位说法"]}。\n` +
      `要求：name 与 aliases 必须是卡片里真出现过的说法，不许自造；只输出 JSON 数组。`
    let text = ''
    let list = []
    try {
      const r = await callModel(makePrompt(sample), 10000)
      text = r.text
      list = parseCards(text)
    } catch (e) {
      text = `（第一次调用就失败：${e && e.message ? e.message : e}）`
    }
    if (!list.length) {
      // 建表比抽卡更怕两件事：格式跑偏（包成对象/表格）和正文为空（样例太长把推理预算烧光）。
      // 重试一次，同时**把样例减半** —— 只改措辞不改长度，空正文会原样再来一次。
      const fewer = sample.slice(0, Math.max(20, Math.floor(sample.length / 2)))
      const retry = await callModel(
        makePrompt(fewer) + '\n\n再强调：只输出 JSON 数组本身（形如 [{"domain":"…","name":"…","aliases":["…"]}]），不要对象包裹、不要表格、不要解释。',
        8000,
      )
      text = retry.text
      list = parseCards(retry.text)
    }
    if (!list.length) {
      throw new Error(`建表没产出概念：模型输出无法解析（${String(text).length} 字符，尾部：…${String(text).slice(-80)}）`)
    }
    const merged = { ...existing }
    let maxId = 0
    for (const id of Object.keys(merged)) {
      const m = /^C(\d+)$/.exec(id)
      if (m) maxId = Math.max(maxId, Number(m[1]))
    }
    let added = 0
    for (const c of list) {
      if (!c || !c.name) continue
      if (added >= MAX_NEW) break
      const name = String(c.name).slice(0, 12)
      if (Object.values(merged).some((x) => x && x.name === name)) continue
      merged['C' + String(++maxId).padStart(3, '0')] = {
        domain: String(c.domain || '').slice(0, 16),
        name,
        aliases: (Array.isArray(c.aliases) ? c.aliases : []).map((a) => String(a).slice(0, 16)).filter(Boolean).slice(0, 4),
      }
      added++
    }
    // 版本化写表：先备份 concepts.bak-v<N>.json，再写新表（版本号在 concepts.meta.json）
    const meta = writeConcepts(dataDir, merged, added ? `induce +${added}` : 'induce (no change)')
    return { concepts: Object.keys(merged).length, added, version: meta.version }
  }

  /**
   * 打码：给还没码的卡各选 1–4 个码，并执行「码必须有字面支撑」这条硬规则——
   * 名字/别名在该卡标题·关键词·大纲·引用里找不到，就把这个码丢掉；一个都不剩就留空（不硬编）。
   */
  async function codeAllCards({ perBatch = 12, skipKeys = null } = {}) {
    const table = conceptsTable()
    const ids = Object.keys(table)
    if (!ids.length) return { coded: 0, failed: 0, total: 0, blank: [] }
    const entries = readCardLines().map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    const pending = []
    entries.forEach((c, i) => {
      // 「模型看了、但这张卡没有任何码在字面上站得住」的卡记进 blank，别每次启动再试一遍
      if (c && !(c.codes && c.codes.concept && c.codes.concept.length) && !(skipKeys && skipKeys.has(c.key))) pending.push(i)
    })
    const tableText = ids
      .map((id) => `${id} ${table[id].name}${(table[id].aliases || []).length ? '（' + table[id].aliases.join('/') + '）' : ''}`)
      .join('\n')
    let coded = 0
    let failed = 0
    let lastError = null
    let splits = 0 // 因为空正文/坏 JSON 拆过几次
    const blank = [] // 看过但没码站得住脚的卡（下次启动不再试）

    const resolveId = (x) => {
      const s = String(x).trim()
      if (table[s]) return s
      const m = s.match(/^(C\d+)/)
      if (m && table[m[1]]) return m[1]
      const hit = Object.entries(table).find(([, v]) => v && (v.name === s || (v.aliases || []).includes(s)))
      return hit ? hit[0] : null
    }

    const applyList = (idxs, list) => {
      const byKey = new Map(list.filter((x) => x && x.key).map((x) => [String(x.key), x.codes || []]))
      for (const i of idxs) {
        const c = entries[i]
        const raw = byKey.get(String(c.key)) || []
        const hay = squash(cardText(c))
        // 模型经常回「概念名」而不是「码」：两种都收，按名/别名反查回码
        const valid = raw
          .map(resolveId)
          .filter(Boolean)
          .filter((id) => {
            // 单字别名（「题」「判」「选」）在字面上几乎什么都能对上，等于没校验；要求至少 2 个字
            const forms = [table[id].name, ...(table[id].aliases || [])].filter((f) => f && String(f).length >= 2)
            return forms.some((f) => hay.includes(squash(f)))
          })
        if (!valid.length) {
          failed++
          blank.push(c.key)
          continue
        }
        c.codes = { ...(c.codes || {}), concept: [...new Set(valid)].slice(0, 4) }
        coded++
      }
    }

    /**
     * 打一批码。模型回空正文 / 坏 JSON 时**对半拆开重试**，拆到单张还不行才算这卡失败 ——
     * 推理吃满预算导致整批空正文时，一次二分就能把能救的卡捞回来。
     */
    const codeBatch = async (idxs, depth = 0) => {
      const payload = idxs.map((i) => {
        const c = entries[i]
        return { key: c.key, title: c.title, one_line: c.one_line, outline: c.outline, keywords: c.keywords, quote: c.pointer && c.pointer.quote }
      })
      const prompt =
        `概念表（只能从这些码里选）：\n${tableText}\n\n` +
        `给下面每张卡选 1–4 个概念码。判定标准：**该码的名字或别名必须在这张卡的标题/关键词/大纲/引用里字面出现**；找不到就少给或不给。\n` +
        `输出 JSON 数组：[{"key":"w:0001","codes":["C012","C034"]}]\n\n卡片：\n${JSON.stringify(payload)}`
      let list = null
      try {
        list = parseCards((await callModel(prompt, 24000)).text)
      } catch (e) {
        lastError = e && e.message ? e.message : String(e)
      }
      if (!Array.isArray(list) || !list.length) {
        if (idxs.length > 1 && depth < 4) {
          splits++
          const mid = Math.ceil(idxs.length / 2)
          await codeBatch(idxs.slice(0, mid), depth + 1)
          await codeBatch(idxs.slice(mid), depth + 1)
          return
        }
        lastError = lastError || '模型这一批没有返回可解析的码'
        failed += idxs.length
        for (const i of idxs) blank.push(entries[i].key)
        writeFileSync(cardsPath, entries.filter(Boolean).map((x) => JSON.stringify(x)).join('\n') + '\n')
        return
      }
      applyList(idxs, list)
      writeFileSync(cardsPath, entries.filter(Boolean).map((x) => JSON.stringify(x)).join('\n') + '\n')
    }

    for (let s = 0; s < pending.length; s += perBatch) {
      await codeBatch(pending.slice(s, s + perBatch), 0)
    }
    // 拆完都成功的话，那次空正文只是"中途重试过"，不该在面板上留成错误
    return { coded, failed, blank, splits, total: pending.length, concepts: ids.length, lastError: failed ? lastError : null }
  }

  async function runLoop() {
    const st = state()
    if (!st) throw new Error('还没 prepare')
    controller = new AbortController()
    running = true
    st.status = 'running'
    st.updated_at = new Date().toISOString()
    writeJson(statePath, st)
    try {
      for (const n of [...st.pending]) {
        if (controller.signal.aborted) {
          st.status = 'paused'
          st.updated_at = new Date().toISOString()
          writeJson(statePath, st)
          return
        }
        st.current = n
        writeJson(statePath, st)
        let res
        try {
          res = await runBatch(n)
        } catch (e) {
          // 单批失败不拖垮整轮：记下来、留在 pending，点「继续」会重跑这一批
          const err = e && e.message ? e.message : String(e)
          st.failed_batches = [...(st.failed_batches || []).filter((x) => x.batch !== n), { batch: n, error: err }]
          st.updated_at = new Date().toISOString()
          st.error = `第 ${n} 批失败：${err}`
          writeJson(statePath, st)
          log(`batch ${n} 失败：${err}`)
          continue
        }
        st.done.push(n)
        st.pending = st.pending.filter((x) => x !== n)
        st.failed_batches = (st.failed_batches || []).filter((x) => x.batch !== n)
        st.cards_added = (st.cards_added || 0) + res.added
        st.model = `${res.provider}/${res.model}`
        // 只记这一批的增量，不记「库里共多少张」——总数一律现数 cards.jsonl，避免缓存出来的旧数字
        st.last = { batch: n, added: res.added, rejected: res.rejected, at: new Date().toISOString() }
        st.updated_at = new Date().toISOString()
        delete st.error
        writeJson(statePath, st)
        log(`batch ${n}: +${res.added} 卡（生成 ${res.generated}，拒 ${res.rejected}）`)
      }
      // 还有没跑成功的批 → 停在「暂停」，让用户点「继续」重跑，而不是假装完成
      if (st.pending.length) {
        st.status = 'paused'
        st.updated_at = new Date().toISOString()
        st.error = `还有 ${st.pending.length} 批没成功（第 ${st.pending.slice(0, 3).join('、')} 批…），点「继续」重跑`
        delete st.current
        writeJson(statePath, st)
        log(st.error)
        return
      }
      st.status = 'done'
      st.finished_at = new Date().toISOString()
      st.updated_at = st.finished_at
      delete st.current
      writeJson(statePath, st)
      setOnboarding({ status: 'done', at: new Date().toISOString() })
      // 卡片入库后自动补「概念表 → 打码」：新机器装完就能按专业词查，不用人提醒
      try {
        st.codes = { status: 'running', at: new Date().toISOString() }
        writeJson(statePath, st)
        const built = await buildConcepts()
        const coded = await codeAllCards()
        st.codes = {
          status: 'done',
          concepts: built.concepts,
          coded: coded.coded,
          failed: coded.failed,
          blank: coded.blank,
          splits: coded.splits,
          lastError: coded.lastError || null,
          at: new Date().toISOString(),
        }
        log(`概念表 ${built.concepts} 个 / 打码 ${coded.coded} 张${coded.splits ? `（中途二分重试 ${coded.splits} 次）` : ''}${coded.failed ? ` / 留空 ${coded.failed} 张` : ''}`)
      } catch (e) {
        st.codes = { status: 'failed', error: e && e.message ? e.message : String(e), at: new Date().toISOString() }
        log(`建表/打码失败：${st.codes.error}`)
      }
      writeJson(statePath, st)
    } catch (e) {
      const aborted = controller && controller.signal.aborted
      st.status = aborted ? 'paused' : 'failed'
      if (!aborted) st.error = e && e.message ? e.message : String(e)
      else delete st.error
      st.updated_at = new Date().toISOString()
      delete st.current
      writeJson(statePath, st)
      if (!aborted) log(`导入中断：${st.error}`)
    } finally {
      running = false
      controller = null
    }
  }

  /**
   * 启动时自检：库里已有卡片但概念表还没建/没打码，就自己补上。
   * 这样新机器装完第一次导入后自动有表；已经导过的机器重启一次也会补齐，不用人提醒。
   * 失败最多自动重试 2 次，之后只在面板上显示失败原因，避免每次启动都烧 token。
   */
  async function ensureCodes(opts = {}) {
    const force = !!opts.force
    const info = status()
    if (!info.cards) return { skipped: 'no-cards' }
    if (info.codes.concepts && info.codes.coded >= info.codes.total) return { skipped: 'done' }
    const st = state() || {}
    if (!force && st.codes && st.codes.status === 'running') return { skipped: 'running' }
    if (!force && st.codes && st.codes.status === 'failed' && (st.codes.attempts || 0) >= 2) return { skipped: 'gave-up' }
    const attempts = force ? 1 : ((st.codes && st.codes.attempts) || 0) + 1
    const prevBlank = new Set((st.codes && st.codes.blank) || [])
    st.codes = { status: 'running', attempts, at: new Date().toISOString() }
    writeJson(statePath, st)
    try {
      // 表已经够大（>=60）就不再归纳：归纳这一步在长提示下会烧光推理预算、正文为空，且没必要
      const built = info.codes.concepts >= 60 ? { concepts: info.codes.concepts, added: 0 } : await buildConcepts()
      // force（面板上手动点）才重试留空的卡；平时启动跳过，免得每次开机都为这十几张烧一次 token
      const coded = await codeAllCards({ skipKeys: force ? new Set() : prevBlank })
      const blank = force ? coded.blank : [...new Set([...prevBlank, ...coded.blank])]
      st.codes = {
        status: 'done',
        attempts,
        concepts: built.concepts,
        added: built.added,
        coded: coded.coded,
        failed: coded.failed,
        blank,
        splits: coded.splits || 0,
        lastError: coded.lastError || null,
        at: new Date().toISOString(),
      }
      writeJson(statePath, st)
      log(
        `概念表 ${built.concepts} 个（新增 ${built.added}）/ 打码 ${coded.coded} 张` +
          (coded.splits ? `（中途二分重试 ${coded.splits} 次）` : '') +
          (coded.failed ? ` / 留空 ${coded.failed} 张` : ''),
      )
      return st.codes
    } catch (e) {
      st.codes = { status: 'failed', attempts, error: e && e.message ? e.message : String(e), at: new Date().toISOString() }
      writeJson(statePath, st)
      log(`建表/打码失败：${st.codes.error}`)
      return st.codes
    }
  }

  return {
    status,
    preview,
    prepare,
    sessions,
    covered,
    /** 自动入库节流要用：有没有导入在跑 */
    isRunning: () => running,
    /** 供迁移脚本用：把已有的段登记为「已导入」，避免升级后被当成新内容重跑。 */
    markImportedUnits: (units) => markImported(units),
    ensureCodes,
    /** 准备 + 后台开跑，立刻返回状态（面板轮询 status 看进度）。 */
    async start(scope) {
      if (running) throw new Error('已经有一个导入在跑')
      const st = prepare(scope)
      st.status = 'running'
      writeJson(statePath, st)
      void runLoop()
      return status()
    },
    /** 续跑（失败/暂停后，或重启后接着跑）。 */
    async resume() {
      if (running) throw new Error('已经有一个导入在跑')
      const st = state()
      if (!st) throw new Error('还没导入过')
      if (!st.pending || !st.pending.length) return status()
      void runLoop()
      return status()
    },
    cancel() {
      if (controller) controller.abort()
      const st = state()
      if (st) {
        st.status = 'paused'
        st.updated_at = new Date().toISOString()
        writeJson(statePath, st)
      }
      return status()
    },
    dismissOnboarding() {
      setOnboarding({ status: 'dismissed', at: new Date().toISOString() })
      return status()
    },
    get busy() {
      return running
    },
  }
}
