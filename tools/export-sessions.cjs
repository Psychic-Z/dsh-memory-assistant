#!/usr/bin/env node
/**
 * 把 DSH 的会话流水（session.v4.jsonl.zstd，多帧 zstd）导出成可读 md。
 *
 * 用法：
 *   node tools/export-sessions.cjs --out ./export --limit 5
 *   node tools/export-sessions.cjs --out ./export --since 2026-11-01
 *
 * 只保留 user / assistant 的正文；assistant 的 reasoning 丢掉，
 * 工具调用只留一行计数，避免把工具噪音灌进记忆。
 */
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

/** 逐个 zstd 帧解压：帧与帧首尾相接，Node 的 zstd 解压只吃第一帧。 */
function decompressMultiFrame(buf) {
  const offs = []
  let i = 0
  while (true) {
    const k = buf.indexOf(MAGIC, i)
    if (k < 0) break
    offs.push(k)
    i = k + 4
  }
  const parts = []
  let pos = 0
  for (let idx = 0; idx < offs.length; idx++) {
    const start = offs[idx]
    if (start < pos) continue
    let done = false
    for (let j = idx + 1; j <= offs.length; j++) {
      const end = j < offs.length ? offs[j] : buf.length
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
        pos = end
        done = true
        break
      } catch (_) {
        /* 这帧还没结束，扩到下一个 magic 再试 */
      }
    }
    if (!done) break
  }
  return Buffer.concat(parts)
}

function fmtBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v < 1024) return v + 'B'
  if (v < 1024 * 1024) return Math.round(v / 1024) + 'KB'
  return (v / 1024 / 1024).toFixed(1) + 'MB'
}

/**
 * 附件不能丢：DSH 的内容块只有 text/file/image 三种，图片和文件都是「引用」
 * （attachmentId + name + bytes，实体在 <DSH_HOME>/attachments/v1，按内容去重、不自动删）。
 * 以前这里只留 text，附件在第一步就消失，段里没有 → 卡里也没有 → 事后完全不知道「发过东西」。
 * 现在每个附件落一行占位，名字和大小都能进关键词；内容本身仍然不进上下文。
 */
function attachLine(p) {
  const a = p.attachment || {}
  const name = String(a.name || '').trim() || '(未命名)'
  const size = fmtBytes(a.bytes)
  if (p.type === 'image') {
    const dims = a.width && a.height ? `${a.width}×${a.height}` : ''
    return `[附件 图片 ${name}${dims ? ' ' + dims : ''}${size ? ' ' + size : ''}]`
  }
  return `[附件 文件 ${name}${size ? ' ' + size : ''}]`
}

function textOf(data) {
  const c = (data && data.content) || (data && data.message && data.message.content)
  if (!Array.isArray(c)) return ''
  const parts = []
  for (const p of c) {
    if (!p) continue
    if (p.type === 'text' && typeof p.text === 'string') {
      const t = p.text.trim()
      if (t) parts.push(t)
    } else if ((p.type === 'file' || p.type === 'image') && p.attachment) {
      parts.push(attachLine(p))
    }
  }
  return parts.join('\n')
}

function isNoise(t) {
  return (
    /^Current runtime context\./.test(t) ||
    /^\[memsearch\]/.test(t) ||
    /^Time sampled while/.test(t) ||
    t.includes('untrusted-memory') ||
    /^<system-reminder>/.test(t) ||
    /^(Agent |Background subagent |It sent you a message|Its closing message)/.test(t) ||
    /^(received|任务完成)/.test(t)
  )
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function main() {
  const out = path.resolve(String(arg('out', './export')))
  const limit = Number(arg('limit', 0)) || 0
  const since = arg('since', null)
  const sinceMs = since ? new Date(String(since) + 'T00:00:00+08:00').getTime() : 0

  const base = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'sessions')
  const want = String(arg('workspace', '')).trim()
  const onlySession = arg('session', null)
  const all = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d)))
  let picked
  if (want === 'all') picked = all
  else if (want) picked = all.filter((d) => d.includes(want))
  else {
    // 默认：当前工作区（按 cwd 末段匹配）；找不到再退回 default-workspace
    const cwdTail = path.basename(process.cwd()).replace(/[^A-Za-z0-9]+/g, '-')
    picked = all.filter((d) => d.includes(cwdTail))
    if (!picked.length) picked = all.filter((d) => d.includes('default-workspace'))
  }
  if (!picked.length) {
    console.error('no workspace matched:', want || '(current)')
    process.exit(2)
  }

  const projOf = (wsName) => {
    const clean = wsName.replace(/^--|--$/g, '').replace(/~0020/g, ' ')
    const seg = clean.split('-').filter(Boolean)
    return seg.length ? seg[seg.length - 1] : clean
  }

  let sessions = []
  if (onlySession && onlySession !== true) {
    // 只导一场：先在选中的工作区里找，找不到就全库找（会话可能属于别的工作区）
    const sid = String(onlySession)
    const scan = (wsName) => {
      const p = path.join(base, wsName, sid, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(p)) return null
      return { sid, p, mtime: fs.statSync(p).mtimeMs, wsName, project: projOf(wsName) }
    }
    for (const wsName of picked) {
      const hit = scan(wsName)
      if (hit) { sessions.push(hit); break }
    }
    if (!sessions.length) {
      for (const wsName of all) {
        const hit = scan(wsName)
        if (hit) { sessions.push(hit); break }
      }
    }
    if (!sessions.length) {
      console.error('session not found:', sid)
      process.exit(3)
    }
  } else {
    for (const wsName of picked) {
      const wsDir = path.join(base, wsName)
      for (const sid of fs.readdirSync(wsDir)) {
        const p = path.join(wsDir, sid, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(p)) continue
        sessions.push({ sid, p, mtime: fs.statSync(p).mtimeMs, wsName, project: projOf(wsName) })
      }
    }
  }
  sessions.sort((a, b) => a.mtime - b.mtime)
  if (sinceMs) sessions = sessions.filter((s) => s.mtime >= sinceMs)
  if (limit) sessions = sessions.slice(-limit)

  fs.mkdirSync(out, { recursive: true })
  const chunks = []
  let stat = { sessions: 0, user: 0, assistant: 0, chars: 0, tools: 0 }

  for (const s of sessions) {
    let raw
    try {
      raw = decompressMultiFrame(fs.readFileSync(s.p))
    } catch (e) {
      console.error('skip (decompress):', s.sid, e.message)
      continue
    }
    const lines = raw.toString('utf8').split('\n').filter(Boolean)
    const evs = []
    for (const l of lines) {
      try {
        evs.push(JSON.parse(l))
      } catch (_) {}
    }
    const head = evs.find((e) => e.type === 'session')
    if (head && head.origin === 'subagent' && !arg('include-subagents', false)) continue
    const title = evs.find((e) => e.type === 'session/title')
    const parts = []
    let tools = 0
    for (const e of evs) {
      if (e.type === 'tool/call') tools++
      if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
      const t = textOf(e.data)
      if (!t || isNoise(t)) continue
      const who = e.type === 'user/message' ? '用户' : '助手'
      if (who === '用户') stat.user++
      else stat.assistant++
      parts.push(`**【${who}】** ${fmtTime(e.time)}\n\n${t}\n`)
    }
    if (!parts.length) continue
    stat.sessions++
    stat.tools += tools
    const body = parts.join('\n')
    stat.chars += body.length
    // 项目名 = cwd 末段；`.../workspace` 这种通用名退一级（取上一级目录，如 bot）
    const cwdSegs = (head && head.cwd ? String(head.cwd) : '').split(/[\\/]/).filter(Boolean)
    let proj = cwdSegs.length ? cwdSegs[cwdSegs.length - 1] : s.project
    if (proj === 'workspace' && cwdSegs.length > 1) proj = cwdSegs[cwdSegs.length - 2]
    proj = proj || s.project
    const ttl = title && title.data && (title.data.title || title.data.text)
    chunks.push(
      `## 会话 ${s.sid}${ttl ? ' · ' + String(ttl).slice(0, 40) : ''}\n\n` +
        `- 项目：${proj}\n` +
        `- 时间：${head ? fmtTime(head.createdAt) : fmtTime(s.mtime)}\n` +
        `- 工作区：${head ? head.cwd || '-' : '-'}\n` +
        `- 工具调用：${tools} 次（已省略正文）\n\n` +
        body
    )
  }

  const file = path.join(out, 'sessions.md')
  fs.writeFileSync(
    file,
    `# 会话导出（${new Date().toISOString().slice(0, 10)}）\n\n` +
      `> 只含 user/assistant 正文；工具调用只计次数；附件按一行占位（[附件 图片/文件 名字 大小]），内容不进导出。\n\n` +
      chunks.join('\n---\n\n')
  )
  console.log(JSON.stringify({ file, ...stat }, null, 1))
}

module.exports = { textOf, isNoise, fmtBytes }

if (require.main === module) main()
