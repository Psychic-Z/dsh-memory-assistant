#!/usr/bin/env node
/**
 * 打一个可发布的包：把当前插件目录复制到 release/，并按市场要求改名。
 *
 *   node tools/prepare-release.mjs --owner <你的 GitHub 账号> [--name dsh-memory-assistant] [--out release]
 *
 * 只做三件事：
 *   1. 复制运行需要的文件（index/bin/lib/skills/client/patch/README/LICENSE/package.json）
 *   2. 把包名从 @local/dsh-memory-assistant 换成正式名，同步 client.js 的模块 id 与 patch 的 name
 *   3. 去掉 private，补 repository/homepage/author
 *
 * 不改当前目录的任何文件 —— 正在用的 link: 安装不会被打断。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const name = arg('name', 'dsh-memory-assistant')
const owner = arg('owner', 'OWNER')
const out = resolve(pkgDir, arg('out', '../release'))

const src = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const target = join(out, name)

if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
  console.error('包名不合法：' + name + '（只允许小写字母、数字、- _ .，可带一个 @scope/）')
  process.exit(1)
}
if (owner === 'OWNER') console.warn('⚠ 没给 --owner：repository 里会留下 OWNER 占位，发布前记得改')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const FILES = ['index.js', 'bin', 'lib', 'skills', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.png', 'icon-256.png', 'icon-180.png']
const missing = FILES.filter((f) => !existsSync(join(pkgDir, f)))
if (missing.length) {
  console.error('缺文件：' + missing.join(', '))
  process.exit(1)
}
for (const f of FILES) cpSync(join(pkgDir, f), join(target, f), { recursive: true })

// 1) package.json
const next = {
  ...src,
  name,
  private: false,
  description: src.description,
  repository: { type: 'git', url: `https://github.com/${owner}/${name}` },
  homepage: `https://github.com/${owner}/${name}#readme`,
  author: owner,
  license: 'MIT',
}
writeFileSync(join(target, 'package.json'), JSON.stringify(next, null, 2) + '\n')

// 2) client.js 的模块 id 必须等于包名，否则宿主等不到工厂、面板不出现
const clientPath = join(target, 'client.js')
const clientSrc = readFileSync(clientPath, 'utf8')
const clientNext = clientSrc.replace(/id:\s*"@local\/dsh-memory-assistant"/, `id: "${name}"`)
if (clientNext === clientSrc) console.warn('⚠ client.js 里没找到 @local/dsh-memory-assistant，检查模块 id')
writeFileSync(clientPath, clientNext)

// 3) patch 的 name 也必须等于包名
const patchPath = join(target, 'cordis.patch.yml')
const patchNext = readFileSync(patchPath, 'utf8').replace(/name:\s*'@local\/dsh-memory-assistant'/, `name: '${name}'`)
writeFileSync(patchPath, patchNext)

// 4) 自检：release/ 里不该再有 @local/
const leftovers = []
for (const f of ['package.json', 'client.js', 'cordis.patch.yml']) {
  const text = readFileSync(join(target, f), 'utf8')
  if (text.includes('@local/dsh-memory-assistant')) leftovers.push(f)
}
if (leftovers.length) {
  console.error('⚠ 这些文件里还残留 @local/：' + leftovers.join(', '))
  process.exit(1)
}

console.log(`已生成：${target}`)
console.log(`包名 ${name} · 版本 ${next.version} · 文件 ${FILES.length} 组`)
console.log('')
console.log('下一步：')
console.log(`  cd "${target}" && pnpm pack`)
console.log(`  # 产物 ${name}-${next.version}.tgz 挂到 GitHub Release，或 npm publish`)
console.log(`  # 自测：dsh plugin --profile test add <tgz 路径或 npm 名>`)
