/**
 * 自动增量入库（按 2026-11-13 定的节流形态）：
 *
 * 接 `agent/turn-stopping`（每轮要结束），但**不每轮抽卡**：
 *   - 同一会话累计 ≥ 6 轮 **且** 距上次入库 ≥ 20 分钟 → 跑一次增量
 *   - 正在导入 / 上一次还没到间隔 / 用户关掉了开关 → 跳过，只累计轮次
 *   - 跑完（无论成功、没新内容、失败）都把轮次清零，并把结果写进状态
 *
 * 为什么不在"会话结束"才导：会话可能几天不结束（旧会话跑了 9 天）。
 * 代价是最大滞后 20 分钟，这也是当初定的取舍。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIN_TURNS = 6
const MIN_GAP_MS = 20 * 60 * 1000

export function createAutoImport({ importer, dataDir, readConfig, log, minTurns = MIN_TURNS, minGapMs = MIN_GAP_MS } = {}) {
  const statePath = join(dataDir, 'auto-import.json')

  const readState = () => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      return { sessions: {}, lastRunAt: null, lastResult: null }
    }
  }
  const writeState = (s) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(statePath, JSON.stringify(s, null, 1))
    } catch (e) {
      log && log(`自动入库状态写不进去：${e && e.message}`)
    }
  }

  let running = false

  async function tick(payload) {
    try {
      const cfg = (typeof readConfig === 'function' && readConfig()) || {}
      if (cfg.autoImport === false) return { skipped: 'off' }

      const sid =
        (payload && payload.agent && (payload.agent.id || payload.agent.sessionId)) ||
        (payload && payload.sessionId) ||
        'unknown'
      const st = readState()
      st.sessions = st.sessions || {}
      const s = st.sessions[sid] || { turns: 0 }
      s.turns = (s.turns || 0) + 1
      st.sessions[sid] = s
      st.pending = Object.values(st.sessions).reduce((n, x) => n + (x.turns || 0), 0)
      st.updatedAt = new Date().toISOString()

      if (s.turns < minTurns) {
        writeState(st)
        return { skipped: 'few-turns', turns: s.turns }
      }
      const last = st.lastRunAt ? Date.parse(st.lastRunAt) : 0
      if (last && Date.now() - last < minGapMs) {
        writeState(st)
        return { skipped: 'too-soon', minutesAgo: Math.round((Date.now() - last) / 60000) }
      }
      if (running || (importer.isRunning && importer.isRunning())) {
        writeState(st)
        return { skipped: 'busy' }
      }

      running = true
      st.lastRunAt = new Date().toISOString()
      st.lastResult = 'running'
      writeState(st)
      // 真跑要解压会话、抽卡，可能几秒到几分钟：放到下一个事件循环，别卡住这一轮的收尾
      setImmediate(() => {
        void (async () => {
          const s2 = readState()
          try {
            await importer.start('incremental')
            s2.lastResult = 'started'
          } catch (e) {
            const msg = e && e.message ? e.message : String(e)
            // 「没有新内容」不是错误，是常态（节流跑勤了就会出现）
            s2.lastResult = /没有新内容|已经全部入过库/.test(msg) ? 'nothing-new' : `error: ${msg.slice(0, 120)}`
            log && log(`自动入库：${s2.lastResult}`)
          } finally {
            for (const k of Object.keys(s2.sessions || {})) s2.sessions[k].turns = 0
            s2.pending = 0
            s2.lastRunAt = new Date().toISOString()
            writeState(s2)
            running = false
          }
        })()
      })
      return { started: true }
    } catch (e) {
      log && log(`自动入库 tick 失败：${e && e.message}`)
      return { error: e && e.message }
    } finally {
      running = false
    }
  }

  return { tick, readState, statePath }
}

/** 面板要显示的那两行：上次什么时候跑的、结果是什么、现在攒了几轮。 */
export function readAutoImport(dataDir) {
  try {
    const p = join(dataDir, 'auto-import.json')
    if (!existsSync(p)) return null
    const s = JSON.parse(readFileSync(p, 'utf8'))
    return {
      lastRunAt: s.lastRunAt || null,
      lastResult: s.lastResult || null,
      pending: s.pending || 0,
      updatedAt: s.updatedAt || null,
    }
  } catch {
    return null
  }
}
