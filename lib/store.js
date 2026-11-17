import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { checkWrite, cardText } from './guard.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dataDir(cfg = {}) {
  const d = cfg.dataDir || process.env.MEM_DATA_DIR || join(homedir(), '.dsh-memory-assistant')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])

export function loadCards(cfg) {
  return readJsonl(join(dataDir(cfg), 'cards.jsonl'))
}

export function saveCards(cfg, cards) {
  writeFileSync(join(dataDir(cfg), 'cards.jsonl'), cards.map((c) => JSON.stringify(c)).join('\n') + '\n')
}

export function appendCard(cfg, card) {
  // 2026-11-17：凭据闸门。写不进去比写进去好——记忆会被检索、注上下文、进日志。
  const chk = checkWrite(cardText(card))
  if (!chk.ok) {
    const e = new Error(`拒绝写入：卡里疑似含${chk.hits.join('、')}（不回显内容）`)
    e.code = 'CREDENTIAL_BLOCKED'
    e.hits = chk.hits
    throw e
  }
  appendFileSync(join(dataDir(cfg), 'cards.jsonl'), JSON.stringify(card) + '\n')
}

/**
 * 日志是「成绩单」，不是检索的前提。
 * 数据目录在用户主目录下，宿主把工作区设成 workspace-write 时 CLI 写不进去（EPERM）；
 * 以前这里直接抛，`mem recall` 在沙箱里**一条结果都出不来** —— 静默失败的一种。
 * 现在写不进去就返回 false，检索照常返回，由调用方提示一句。
 */
let lastLogError = null
const failedLogs = new Map()
export function lastLogErrorInfo() {
  if (!lastLogError) return null
  return { names: [...failedLogs.keys()], message: lastLogError.message }
}

function appendLog(cfg, name, row) {
  try {
    appendFileSync(join(dataDir(cfg), name), JSON.stringify(row) + '\n')
    return true
  } catch (e) {
    lastLogError = { name, message: e && e.message ? e.message : String(e) }
    failedLogs.set(name, true)
    return false
  }
}

export function logAsk(cfg, row) {
  return appendLog(cfg, 'ask_log.jsonl', row)
}

export function logFeedback(cfg, row) {
  return appendLog(cfg, 'feedback.jsonl', row)
}

/** 每次检索/注入的 token 账：用于回答「检索到底省了多少」。 */
export function logUsage(cfg, row) {
  return appendLog(cfg, 'usage.jsonl', row)
}

/**
 * 沙箱里写不了盘时的退路：把这一行交给本机宿主写（宿主不受工作区沙箱限制）。
 * 只用 DSH_WEB_URL 这一条线索，没有就老老实实返回 false。
 */
export async function logViaHost(file, row) {
  const base = process.env.DSH_WEB_URL
  if (!base || typeof fetch !== 'function') return false
  try {
    const res = await fetch(String(base).replace(/\/+$/, '') + '/memory-assistant/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, row }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
    })
    return res.ok
  } catch {
    return false
  }
}

export function readUsage(cfg) {
  return readJsonl(join(dataDir(cfg), 'usage.jsonl'))
}

export function readFeedback(cfg) {
  return readJsonl(join(dataDir(cfg), 'feedback.jsonl'))
}

export function readAsks(cfg) {
  return readJsonl(join(dataDir(cfg), 'ask_log.jsonl'))
}
