/**
 * memory-assistant — DSH 插件骨架
 *
 * 只做一件事：把「记忆助理」的用法注册成一个技能，让模型知道
 * 什么时候该调 `mem recall`、怎么反馈。
 *
 * 真正的存储与检索在 lib/ + bin/mem.js，不依赖 DSH 运行时，
 * 所以可以脱机测试、也可以换宿主。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { makeRoutes } from './lib/server-routes.js'
import { noteFailure } from './lib/fail.js'
import { readConfig } from './lib/server-routes.js'
import { createImporter } from './lib/import-runner.js'
import { createHintEngine } from './lib/hint.js'
import { createAutoImport } from './lib/auto-import.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(homedir(), '.dsh-memory-assistant')

export const name = 'memory-assistant'

/**
 * 两个依赖都必须声明：
 * - skills：技能注册（没有就不 apply）
 * - webServer：设置页那三个接口；不声明的话 apply 时 ctx.webServer 还是 undefined，
 *   路由被静默跳过 → 面板拿到 404 空包 → "Unexpected end of JSON input"
 */
// connection 是硬依赖：Cordis 不允许访问未声明的服务（报 cannot get property ... without inject）

// 261115：面板版本号从 package.json 读，避免写死在客户端里跟不上发版
function readPluginVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch (_) {
    return ''
  }
}

export const inject = ['skills', 'webServer', 'connection']

export function apply(ctx, config = {}) {
  // 自动抽卡要用宿主的 llm；没有就退化成「只提供面板不动手」，不挡住插件挂载。
  const llm = ctx.get('llm')
  const selection = ctx.get('agentDefaultModel')
  const importer = createImporter({
    dataDir: DATA_DIR,
    toolsDir: join(PLUGIN_DIR, 'tools'),
    llm:
      llm && typeof llm.stream === 'function'
        ? llm
        : {
            async *stream() {
              throw new Error('宿主没有 llm 服务，自动抽卡不可用（改用面板里的手工导入）')
            },
          },
    model: () => {
      try {
        return selection?.currentSelection?.() || null
      } catch {
        return null
      }
    },
    log: (m) => {
      try {
        ctx.logger?.info?.(`[memory-assistant] ${m}`)
      } catch (_) {}
    },
  })

  // 设置页的数据接口 + 导入接口
  try {
    // 准入：把 DSH 的 Host/Origin + 浏览器鉴权检查搬到我们自己的路由入口
    const guard = (req) => {
      try {
        // 探针：带这个头就必然拒，用来确认守卫真的被调用
        if (req.headers && req.headers['x-guard-probe']) return 418
        const conn = ctx.connection
        if (!conn) return undefined
        // ① Host / Origin 检查（DSH 自己路由同款）
        if (typeof conn.requestRejection === 'function') {
          const r = conn.requestRejection({ headers: req.headers })
          if (r) return r
        }
        // 只做 Host / Origin 准入（维护者建议的那条）。
        // 不加 admit()：面板自己的同源请求不带凭据会被挡成 401，把功能弄坏。
        return undefined
      } catch (e) {
        // 2026-11-17：这里以前是 `catch (_) {}` —— 守卫抛错被吞，表现成「在放行」，
        // 查了三轮才找到。现在失败必须留痕。
        try { noteFailure(config, 'index.js:route-guard', e) } catch (_) {}
        return undefined
      }
    }
    const diagnose = (req) => {
      try {
        const conn = ctx.connection
        const out = {
          hasConnection: !!conn,
          hasRejection: !!(conn && conn.requestRejection),
          hasAdmit: !!(conn && conn.admit),
          origin: (req.headers && req.headers.origin) || null,
          host: (req.headers && req.headers.host) || null,
          hasCookie: !!(req.headers && req.headers.cookie),
          rejection: null,
          admission: null,
        }
        if (conn && conn.requestRejection) out.rejection = conn.requestRejection({ headers: req.headers }) || null
        if (conn && conn.admit) {
          const a = conn.admit({ headers: req.headers })
          out.admission = a && a.rejection ? a.rejection : 'peer'
        }
        return out
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }
    for (const route of makeRoutes({ importer, guard, diagnose, version: readPluginVersion() })) ctx.webServer.register(route)
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[memory-assistant] 设置接口注册失败：${e && e.message ? e.message : e}`)
    } catch (_) {}
  }

  // 后台自检：已有卡片但还没概念表/没打码 → 自己补（新机器装完第一次导入就自动有表）
  try {
    void importer.ensureCodes().catch(() => {})
  } catch (_) {}

  // 自动入库的节流要用「当前是谁在说话」（turn-stopping 的 payload 只有 {turn, signal}）
  const agentsSvc = ctx.get('agents')
  // ── 自动增量入库 ──────────────────────────────────────────────────────────
  // 每轮结束记一笔，攒够 6 轮且距上次 ≥20 分钟才真跑一次（不每轮抽卡）。
  // 关掉开关就只计数不跑；导入正在跑就跳过。
  const autoImport = createAutoImport({
    importer,
    dataDir: DATA_DIR,
    readConfig,
    log: (m) => {
      try {
        ctx.logger?.info?.(`[memory-assistant] ${m}`)
      } catch (_) {}
    },
  })
  try {
    ctx.on('agent/turn-stopping', async (payload, next) => {
      try {
        let sid = null
        try {
          const cur = agentsSvc && typeof agentsSvc.currentInitiator === 'function' ? agentsSvc.currentInitiator() : null
          sid = cur && cur.id
        } catch (_) {}
        // 不等它跑完：tick 只记轮次 + 触发，真正的导入放到下一个事件循环
        await autoImport.tick({ ...(payload || {}), agent: sid ? { id: sid } : undefined })
      } catch (_) {}
      // agent/turn-stopping 是普通事件，不传 next；只有 waterfall 事件才有。
      // 无条件 next() 会在每轮结束时抛 "next is not a function"，把整轮判成失败。
      return typeof next === 'function' ? next() : undefined
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[memory-assistant] 自动入库接不进 turn-stopping：${e && e.message ? e.message : e}`)
    } catch (_) {}
  }

  // ── 主动提 ────────────────────────────────────────────────────────────────
  // pre-step 时看一眼这一轮用户说了什么 → 挑 1–3 张卡 → 装配时作为一段上下文注入。
  // 只在「分数够 + 条数由涉及量决定」时出现；没有就返回空串，等于不提。
  const hint = createHintEngine({ dataDir: DATA_DIR, readConfig })
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        hint.remember(payload.agent && payload.agent.id, payload.messages, payload.turn)
      } catch (_) {}
      return typeof next === 'function' ? next() : undefined
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[memory-assistant] 主动提接入失败：${e && e.message ? e.message : e}`)
    } catch (_) {}
  }
  try {
    const prompt = ctx.get('systemPrompt')
    const agents = ctx.get('agents')
    if (prompt && typeof prompt.context === 'function') {
      prompt.context({
        name: 'memory-assistant.hint',
        order: 60,
        text: () => {
          try {
            const current = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
            return current ? hint.render(current.id) : ''
          } catch (_) {
            return ''
          }
        },
      })
    }
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[memory-assistant] 提示注入失败：${e && e.message ? e.message : e}`)
    } catch (_) {}
  }

  const skillDir = join(PLUGIN_DIR, 'skills', 'memory-assistant')
  const file = join(skillDir, 'SKILL.md')
  if (!existsSync(file)) return
  try {
    const content = readFileSync(file, 'utf8')
    ctx.skills.register({
      name: 'memory-assistant',
      description:
        '用「记忆助理」定位过去的对话与决定：关键词检索 → 大纲确认 → 回原文；找不到就问，不猜。',
      whenToUse:
        '用户提到过去（当初/上次/之前）、要具体事实（日期/数字/原话）、要引用旧决定，或进入某个专业领域时。',
      content,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: skillDir },
    })
  } catch (e) {
    // 注册失败只影响本插件，不能拖垮整个 profile 的启动
    try {
      ctx.logger?.warn?.(`[memory-assistant] 技能注册失败：${e && e.message ? e.message : e}`)
    } catch (_) {}
  }
}
