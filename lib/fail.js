/**
 * 失败要留痕（2026-11-17，借鉴 memfuse 的 Block D 思路）
 *
 * 为什么要有：`try/catch` 吞掉异常会让「没在工作」看起来像「在工作」。
 * 2026-11-15 路由守卫就是这么被吞了三轮：`inject` 少一个服务 → 抛异常 →
 * 被 catch 掉 → 表现成「守卫在放行」，查了很久。
 *
 * 规则：
 *   1. 关键路径的 catch **至少要调一次** noteFailure()
 *   2. 失败写进 `<dataDir>/failures.jsonl`，`mem stats` 会显示最近几条
 *   3. 写失败本身不许抛（否则又变成静默）
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const CAP = 500

function dirOf(cfg) {
  return cfg?.dataDir || join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh-memory-assistant')
}

/**
 * 记一条失败。返回 true 表示记下了；false 表示连记都失败（不抛）。
 * @param {object} cfg  配置（取 dataDir）
 * @param {string} where 位置，例如 'bin/mem.js:recall' / 'index.js:route'
 * @param {unknown} err  错误
 * @param {object} [extra] 额外上下文（键值会被截断）
 */
export function noteFailure(cfg, where, err, extra = {}) {
  try {
    const dir = dirOf(cfg)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const row = {
      ts: new Date().toISOString(),
      where: String(where || ''),
      message: String((err && err.message) || err || '未知错误').slice(0, 500),
      code: (err && err.code) || null,
      extra: Object.fromEntries(
        Object.entries(extra).map(([k, v]) => [k, String(v).slice(0, 200)]),
      ),
    }
    appendFileSync(join(dir, 'failures.jsonl'), JSON.stringify(row) + '\n')
    return true
  } catch (_) {
    return false
  }
}

/** 读最近 n 条失败（新的在前） */
export function readFailures(cfg, n = 5) {
  try {
    const p = join(dirOf(cfg), 'failures.jsonl')
    if (!existsSync(p)) return []
    const rows = readFileSync(p, 'utf8')
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
    return rows.slice(-CAP).reverse().slice(0, n)
  } catch (_) {
    return []
  }
}
