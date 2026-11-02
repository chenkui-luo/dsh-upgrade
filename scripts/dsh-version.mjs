#!/usr/bin/env node
/**
 * dsh-version.mjs — 钉住 / 解除 launcher 使用的 dsh 版本，并给出诊断。
 *
 * 为什么需要它：launcher 的 Resolve-DshEntry 在 config.json 的 dshPath 为空时，
 * 会去 _npx 缓存里挑「bin.js 修改时间最新」的那个。这意味着任何人随手跑一次
 * `npx @deepseek-ai/dsh`，你的启动器就可能静默跳到新版本 —— 而插件还没跟上。
 * 钉住版本把这件事变成「你决定才发生」。
 *
 * 三条子命令：
 *   status            当前钉在哪、自动挑会挑到谁、各自版本
 *   pin --bin <path>  钉住指定 bin.js（会先备份 config.json，写后读回验证）
 *   unpin             解除钉住，回到自动挑选
 *
 * 写入规则：UTF-8 无 BOM、2 空格缩进（与手写 JSON 一致，launcher 用 ConvertFrom-Json
 * 读取，不关心缩进）。先写临时文件再 rename，避免写坏配置。
 *
 * 用法：
 *   node dsh-version.mjs status
 *   node dsh-version.mjs pin --bin "D:\dsh-versions\0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js"
 *   node dsh-version.mjs pin --dir "D:\dsh-versions\0.2.1-rc.2"
 *   node dsh-version.mjs unpin --dry-run
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'

const DEFAULT_CONFIG = join(process.env.LOCALAPPDATA || '', 'DeepSeekHarness', 'config.json')
const REL_BIN = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

process.stdout.on('error', () => {})

function parseArgs (argv) {
  const out = { cmd: argv[0] || 'status', config: DEFAULT_CONFIG, bin: '', dir: '', dryRun: false, json: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--bin') out.bin = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0) }
  }
  return out
}

const HELP = `用法: node dsh-version.mjs <status|pin|unpin> [选项]
  --config <file>   launcher 的 config.json（默认 %LOCALAPPDATA%\\DeepSeekHarness\\config.json）
  --bin <file>      pin: 指向 ...\\@deepseek-ai\\dsh\\lib\\bin.js
  --dir <dir>       pin: 指向一个安装了 @deepseek-ai/dsh 的目录（自动拼出 bin.js）
  --dry-run         只打印将要写入的内容，不落盘
  --json            以 JSON 输出
`

function readConfig (p) {
  if (!existsSync(p)) return null
  const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

function versionOfBin (bin) {
  const pj = join(dirname(dirname(bin)), 'package.json')
  if (!existsSync(pj)) return null
  try { return JSON.parse(readFileSync(pj, 'utf8')).version || null } catch { return null }
}

function autoCandidates () {
  const root = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  const out = []
  if (!existsSync(root)) return out
  for (const d of readdirSync(root)) {
    const bin = join(root, d, REL_BIN)
    if (!existsSync(bin)) continue
    out.push({ bin, version: versionOfBin(bin), mtime: statSync(bin).mtimeMs, from: `_npx/${d}` })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function writeConfigAtomic (p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
}

function backup (p) {
  if (!existsSync(p)) return null
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const dst = `${p}.bak-${stamp}`
  copyFileSync(p, dst)
  return dst
}

function resolveTargetBin (args) {
  if (args.bin) {
    const p = resolve(args.bin)
    if (!existsSync(p)) throw new Error(`--bin 指向的文件不存在: ${p}`)
    return p
  }
  if (args.dir) {
    const p = join(resolve(args.dir), REL_BIN)
    if (!existsSync(p)) throw new Error(`--dir 下没有 ${REL_BIN}: ${p}`)
    return p
  }
  throw new Error('pin 需要 --bin 或 --dir')
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const cfg = readConfig(args.config)
  if (!cfg) throw new Error(`读不到 launcher 配置: ${args.config}`)

  const pinned = typeof cfg.dshPath === 'string' ? cfg.dshPath.trim() : ''
  const pinnedOk = pinned !== '' && existsSync(pinned)

  if (args.cmd === 'status') {
    const auto = autoCandidates()
    const info = {
      config: args.config,
      pinned: pinned || '(空 = 自动挑选)',
      pinnedExists: pinned ? pinnedOk : null,
      pinnedVersion: pinned && pinnedOk ? versionOfBin(pinned) : null,
      effective: pinned && pinnedOk ? { bin: pinned, version: versionOfBin(pinned), how: 'dshPath（已钉住）' } : (auto[0] ? { bin: auto[0].bin, version: auto[0].version, how: `自动挑选：${auto[0].from}` } : null),
      autoCandidates: auto.map((a) => ({ bin: a.bin, version: a.version, from: a.from }))
    }
    if (args.json) { console.log(JSON.stringify(info, null, 2)); return }
    console.log('=== dsh 版本状态 ===')
    console.log(`config           : ${info.config}`)
    console.log(`dshPath          : ${info.pinned}${pinned && !pinnedOk ? '  ← 指向的文件不存在！' : ''}`)
    console.log(`当前生效         : ${info.effective ? `${info.effective.version}  (${info.effective.how})` : '(未找到任何可用安装)'}`)
    if (auto.length > 0) {
      console.log('自动挑选候选（按修改时间）:')
      for (const a of auto) console.log(`  - ${a.version}  ${a.from}  ${a.bin}`)
    }
    if (pinned && pinnedOk && auto[0] && auto[0].bin !== pinned) {
      console.log(`\n提示：已钉住 ${info.pinnedVersion}，而自动挑选会选 ${auto[0].version}。这正是"钉住"起作用的地方。`)
    }
    return
  }

  if (args.cmd === 'pin') {
    const bin = resolveTargetBin(args)
    const ver = versionOfBin(bin)
    const next = { ...cfg, dshPath: bin }
    if (args.dryRun) {
      console.log('[dry-run] 将写入:')
      console.log(JSON.stringify(next, null, 2))
      return
    }
    const bak = backup(args.config)
    writeConfigAtomic(args.config, next)
    // 读回验证：这一步不能省
    const back = readConfig(args.config)
    if (!back || back.dshPath !== bin) throw new Error('写入后读回不一致，配置可能未生效')
    console.log(`[OK] 已钉住 → ${ver || '(版本未知)'}`)
    console.log(`     dshPath = ${bin}`)
    if (bak) console.log(`     备份    = ${bak}`)
    console.log('     重启服务后生效：Launch-DeepSeekHarness.ps1 -Restart')
    return
  }

  if (args.cmd === 'unpin') {
    const next = { ...cfg, dshPath: '' }
    if (args.dryRun) {
      console.log('[dry-run] 将写入:')
      console.log(JSON.stringify(next, null, 2))
      return
    }
    const bak = backup(args.config)
    writeConfigAtomic(args.config, next)
    const back = readConfig(args.config)
    if (!back || back.dshPath !== '') throw new Error('写入后读回不一致，配置可能未生效')
    const auto = autoCandidates()
    console.log('[OK] 已解除钉住（dshPath 置空），回到按修改时间自动挑选')
    if (bak) console.log(`     备份 = ${bak}`)
    if (auto[0]) console.log(`     下次启动会用: ${auto[0].version}  (${auto[0].from})`)
    return
  }

  throw new Error(`未知子命令: ${args.cmd}（支持 status / pin / unpin）`)
}

try { main() } catch (err) {
  console.error('[FAIL] ' + err.message)
  process.exit(1)
}
