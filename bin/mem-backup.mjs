#!/usr/bin/env node
/**
 * 记忆库的备份 / 恢复。
 *
 *   node bin/mem-backup.mjs backup  [--out <dir>]   # 默认备份到 <out>/memory-backup-<时间戳>
 *   node bin/mem-backup.mjs restore <备份目录>        # 覆盖前会先把现有库另存一份
 *   node bin/mem-backup.mjs verify  <备份目录>        # 只检查清单与文件是否齐全
 *
 * 备份的是「记忆本身」：卡片、概念表、各类索引、配置、导出原文。
 * 会话原始流水（~/.dsh/sessions）不在其中——那是 DSH 的资产，卡片只用指针指向它。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const ROOT = join(homedir(), '.dsh-memory-assistant')
const FILES = [
  'cards.jsonl',
  'concepts.json',
  'concepts.meta.json',
  'config.json',
  'ask_log.jsonl',
  'feedback.jsonl',
  'usage.jsonl',
  'import/units.json',
  'import/unit-index.json',
  'import/unit-times.json',
  'import/covered.json',
  'import/imported-units.json',
  'import/import.state.json',
  'export/sessions.md',
]

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const die = (m) => {
  console.error(m)
  process.exit(1)
}

function copyTree(from, to) {
  let n = 0
  for (const rel of FILES) {
    const src = join(from, rel)
    if (!existsSync(src)) continue
    const dst = join(to, rel)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    n++
  }
  return n
}

function countLines(p) {
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

if (cmd === 'backup') {
  const out = flag('out', join(homedir(), 'memory-backups'))
  const dir = join(out, 'memory-backup-' + stamp())
  mkdirSync(dir, { recursive: true })
  const n = copyTree(ROOT, dir)
  const manifest = {
    kind: 'dsh-memory-assistant/backup',
    createdAt: new Date().toISOString(),
    sourceRoot: ROOT,
    files: n,
    cards: countLines(join(ROOT, 'cards.jsonl')),
    concepts: existsSync(join(ROOT, 'concepts.json')) ? Object.keys(JSON.parse(readFileSync(join(ROOT, 'concepts.json'), 'utf8'))).length : 0,
    list: FILES.filter((f) => existsSync(join(ROOT, f))),
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1))
  console.log(JSON.stringify({ ok: true, dir, ...manifest, list: undefined }, null, 1))
} else if (cmd === 'verify') {
  const dir = args[1] || die('用法: mem-backup verify <备份目录>')
  const mf = join(dir, 'manifest.json')
  if (!existsSync(mf)) die('不是有效备份（缺 manifest.json）：' + dir)
  const manifest = JSON.parse(readFileSync(mf, 'utf8'))
  const missing = (manifest.list || []).filter((f) => !existsSync(join(dir, f)))
  console.log(JSON.stringify({ ok: missing.length === 0, createdAt: manifest.createdAt, cards: manifest.cards, concepts: manifest.concepts, missing }, null, 1))
  if (missing.length) process.exit(2)
} else if (cmd === 'restore') {
  const dir = args[1] || die('用法: mem-backup restore <备份目录>')
  if (!existsSync(join(dir, 'manifest.json'))) die('不是有效备份（缺 manifest.json）：' + dir)
  const safety = ROOT + '.bak-before-restore-' + stamp()
  mkdirSync(safety, { recursive: true })
  const saved = copyTree(ROOT, safety)
  const n = copyTree(dir, ROOT)
  console.log(JSON.stringify({ ok: true, restoredFiles: n, previousSavedTo: safety, previousFiles: saved }, null, 1))
} else {
  console.log('用法:\n  mem-backup backup  [--out <目录>]\n  mem-backup restore <备份目录>\n  mem-backup verify  <备份目录>')
}
