import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { auditAliases, pruneAliases, listBackups, restoreConcepts, readMeta } from './concepts.js'
import { readAutoImport } from './auto-import.js'

const ROOT = join(homedir(), '.dsh-memory-assistant')

export function configPath() {
  return join(ROOT, 'config.json')
}

export function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeConfig(patch) {
  const cur = readConfig()
  const next = { ...cur, ...patch }
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(next, null, 1) + '\n', 'utf8')
  return next
}

function countLines(p) {
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function stats() {
  const dir = readConfig().dataDir || ROOT
  const cards = countLines(join(dir, 'cards.jsonl'))
  let asks = []
  try {
    asks = readFileSync(join(dir, 'ask_log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {}
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
  const withState = states.exact + states.related + states.none + states.concept
  const need = withState ? states.related + states.none : legacyNeed
  const totalNeed = withState || legacy
  const fb = countLines(join(dir, 'feedback.jsonl'))
  let good = 0
  let partial = 0
  try {
    for (const l of readFileSync(join(dir, 'feedback.jsonl'), 'utf8').split('\n')) {
      if (!l.trim()) continue
      const v = JSON.parse(l).verdict
      if (v === 'good') good++
      else if (v === 'partial') partial++
    }
  } catch {}
  const total = good + partial + (fb - good - partial > 0 ? fb - good - partial : 0)
  const rate = total ? Math.round(((good + 0.5 * partial) / total) * 100) + '%' : '-'
  return {
    cards,
    asks: asks.length,
    states,
    feedback: fb,
    need_confirm_rate: totalNeed ? Math.round((need / totalNeed) * 100) + '%' : '-',
    satisfaction: rate,
  }
}

function usageSummary() {
  let rows = []
  try {
    rows = readFileSync(join(ROOT, 'usage.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((r) => r && r.kind === 'recall')
  } catch {}
  const actual = rows.reduce((a, r) => a + (r.cardTokens || 0) + (r.sourceTokens || 0), 0)
  const lib = rows.length ? Math.max(...rows.map((r) => r.libraryTokens || 0)) : 0
  return {
    queries: rows.length,
    actualTokens: actual,
    perQuery: rows.length ? Math.round(actual / rows.length) : 0,
    baselineLibrary: lib,
    savedVsLibrary: rows.length * lib - actual,
  }
}

function send(res, code, obj) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

export function makeRoutes(options = {}) {
  const importer = options.importer || null
  const routes = [
    {
      // 别名体检：只读，返回候选；真删走下面的 prune（面板按钮两步走，避免误点）
      kind: 'exact',
      path: '/memory-assistant/api/concepts/audit',
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method' })
        const dir = readConfig().dataDir || ROOT
        let tier = 'B'
        try {
          const q = new URL(req.url || '/', 'http://localhost').searchParams.get('tier')
          if (q) tier = q
        } catch {}
        try {
          send(res, 200, { ok: true, ...auditAliases(dir, { tier }) })
        } catch (e) {
          send(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/memory-assistant/api/concepts/prune',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
        const body = await readBody(req)
        const dir = readConfig().dataDir || ROOT
        try {
          const r = pruneAliases(dir, { tier: body.tier || 'B' })
          send(res, 200, { ok: true, tier: r.audit.tier, removed: r.removed, candidates: r.candidates, version: r.version, undoVersion: r.undoVersion })
        } catch (e) {
          send(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/memory-assistant/api/concepts/backups',
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method' })
        try {
          send(res, 200, { ok: true, version: readMeta(readConfig().dataDir || ROOT).version || 0, backups: listBackups(readConfig().dataDir || ROOT) })
        } catch (e) {
          send(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
        }
      },
    },
    {
      // 回滚：删坏了 / 改坏了都走这里（回滚前也会给当前表留一份，回滚本身也能回滚）
      kind: 'exact',
      path: '/memory-assistant/api/concepts/restore',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
        const body = await readBody(req)
        try {
          const r = restoreConcepts(readConfig().dataDir || ROOT, body.version)
          send(res, 200, { ok: true, ...r })
        } catch (e) {
          send(res, 400, { ok: false, error: e && e.message ? e.message : String(e) })
        }
      },
    },
    {
      // CLI 在 workspace-write 沙箱里写不了 ~/.dsh-memory-assistant（EPERM）——
      // 宿主这里是不受限的，于是账本由本机回环接口代写。只允许这三个文件、只追加。
      kind: 'exact',
      path: '/memory-assistant/api/log',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
        const body = await readBody(req)
        const file = { ask_log: 'ask_log.jsonl', usage: 'usage.jsonl', feedback: 'feedback.jsonl' }[body.file]
        if (!file) return send(res, 400, { ok: false, error: 'file' })
        if (!body.row || typeof body.row !== 'object') return send(res, 400, { ok: false, error: 'row' })
        const line = JSON.stringify(body.row)
        if (line.length > 8192) return send(res, 413, { ok: false, error: 'row too large' })
        try {
          appendFileSync(join(readConfig().dataDir || ROOT, file), line + '\n')
          send(res, 200, { ok: true })
        } catch (e) {
          send(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/memory-assistant/api/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method' })
        send(res, 200, {
          ok: true,
          config: readConfig(),
          root: ROOT,
          stats: stats(),
          usage: usageSummary(),
          import: importer ? importer.status() : null,
          auto: readAutoImport(readConfig().dataDir || ROOT),
          tools: importer ? { preview: importer.preview('current'), all: importer.preview('all') } : null,
        })
      },
    },
    {
      kind: 'exact',
      path: '/memory-assistant/api/config',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
        const body = await readBody(req)
        const patch = {}
        if (typeof body.dataDir === 'string') patch.dataDir = body.dataDir.trim()
        if (body.topK !== undefined) patch.topK = Number(body.topK) || 3
        if (typeof body.workspace === 'string') patch.workspace = body.workspace.trim()
        if (typeof body.aliasTier === 'string' && /^[ABC]$/.test(body.aliasTier)) patch.aliasTier = body.aliasTier
        if (body.recentCards !== undefined) patch.recentCards = Number(body.recentCards) || 50
        if (typeof body.proactive === 'boolean') patch.proactive = body.proactive
        if (typeof body.autoImport === 'boolean') patch.autoImport = body.autoImport
        try {
          writeConfig(patch)
          send(res, 200, { ok: true, config: readConfig() })
        } catch (e) {
          send(res, 500, { ok: false, error: e.message })
        }
      },
    },
  ]

  if (importer) {
    const guard = (fn) => async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
      try {
        const body = await readBody(req)
        send(res, 200, { ok: true, ...(await fn(body)) })
      } catch (e) {
        send(res, 400, { ok: false, error: e && e.message ? e.message : String(e) })
      }
    }
    routes.push(
      {
        kind: 'exact',
        path: '/memory-assistant/api/import/start',
        handler: guard(async (body) => {
          const scope = ['all', 'incremental'].includes(body.scope) ? body.scope : 'current'
          return { import: await importer.start(scope) }
        }),
      },
      {
        kind: 'exact',
        path: '/memory-assistant/api/import/resume',
        handler: guard(async () => ({ import: await importer.resume() })),
      },
      {
        kind: 'exact',
        path: '/memory-assistant/api/import/cancel',
        handler: guard(async () => ({ import: importer.cancel() })),
      },
      {
        kind: 'exact',
        path: '/memory-assistant/api/import/dismiss',
        handler: guard(async () => ({ import: importer.dismissOnboarding() })),
      },
      {
        kind: 'exact',
        path: '/memory-assistant/api/import/codes',
        handler: guard(async () => {
          // 后台跑（建表+打码要调模型，可能要一两分钟），面板轮询 /state 看进度
          void importer.ensureCodes({ force: true }).catch(() => {})
          return { started: true }
        }),
      },
      {
        kind: 'exact',
        path: '/memory-assistant/api/import/status',
        handler: guard(async () => ({ import: importer.status() })),
      },
    )
  }

  return routes
}
