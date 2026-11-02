#!/usr/bin/env node
/**
 * dsh-compat-check.mjs — 逐个核对「已安装的插件」是否声明支持「正在运行的 DSH 内核」。
 *
 * 与 dsh-upgrade-report.mjs 的分工：
 *   - report 回答"要不要升、升之前哪些包会断"（当前版本 vs registry 最新）
 *   - 本脚本回答"已经升完了，还有哪些插件没跟上当前内核"
 *
 * 判据（由强到弱）：
 *   1. 硬冲突：插件源码 import 的 @deepseek-ai 包，在目标内核版本上没有对应发布 → 必挂
 *   2. peer 范围：插件声明的 @deepseek-ai/* peerDependencies 不接受目标版本 → 未适配
 *   3. engines.dsh：插件显式声明的内核范围不接受目标版本 → 未适配
 *   4. 未声明：既没有 engines.dsh 也没有官方 peer → 只能靠运行时（是否挂载）判断
 *   5. 挂载核对：把"已安装的客户端插件"与"实际出现在引导数据里的条目"对比，
 *      找出装了但没挂上的（这一条能抓到声明没问题、实际却没加载的情况）
 *
 * 用法：
 *   node dsh-compat-check.mjs
 *   node dsh-compat-check.mjs --profile web --json
 *   node dsh-compat-check.mjs --kernel 0.2.1-rc.2 --no-mount-check
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

process.stdout.on('error', () => {})

const REGISTRY = 'https://registry.npmjs.org'
const ABBREVIATED = 'application/vnd.npm.install-v1+json'

function parseArgs (argv) {
  const out = {
    dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    profile: 'web',
    kernel: '',
    mountCheck: true,
    json: false,
    workspace: ''
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dsh-home') out.dshHome = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--kernel') out.kernel = argv[++i]
    else if (a === '--workspace') out.workspace = argv[++i]
    else if (a === '--no-mount-check') out.mountCheck = false
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') { console.log('见文件头注释'); process.exit(0) }
  }
  return out
}

const exists = (p) => { try { statSync(p); return true } catch { return false } }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// ── 极简 semver（与 dsh-upgrade-report.mjs 同一套简化规则）─────────────────
function parseVer (v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}
function cmpPre (a, b) { if (a === b) return 0; if (!a) return 1; if (!b) return -1; return a < b ? -1 : 1 }
function cmpVer (a, b) {
  const x = parseVer(a); const y = parseVer(b)
  if (!x || !y) return 0
  if (x.major !== y.major) return x.major < y.major ? -1 : 1
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1
  return cmpPre(x.pre, y.pre)
}
const RANGE_RE = /^(\^|~|>=|>|<=|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
function satisfies (target, range) {
  if (!range || typeof range !== 'string') return { ok: true, why: 'no range' }
  const alts = range.split('||').map((s) => s.trim()).filter(Boolean)
  const t = parseVer(target)
  if (!t) return { ok: true, why: 'unparsable target' }
  const notes = []
  for (const alt of alts) {
    const m = RANGE_RE.exec(alt)
    if (!m) { notes.push(`无法解析 ${alt}`); continue }
    const [, op = '', mj, mn, pt, pre] = m
    const lower = `${mj}.${mn}.${pt}${pre ? '-' + pre : ''}`
    const lo = cmpVer(target, lower)
    if (op === '>=') { if (lo >= 0) return { ok: true, why: alt }; notes.push(`${target} < ${lower}`); continue }
    if (op === '>') { if (lo > 0) return { ok: true, why: alt }; notes.push(`${target} <= ${lower}`); continue }
    if (op === '<' || op === '<=') { if (op === '<' ? lo < 0 : lo <= 0) return { ok: true, why: alt }; notes.push(`${target} 不符合 ${alt}`); continue }
    if (op === '' || op === '=') { if (lo === 0) return { ok: true, why: alt }; notes.push(`不等于 ${lower}`); continue }
    let upperMinor = +mn; let upperMajor = +mj
    if (op === '^') { if (+mj > 0) upperMajor = +mj + 1; else upperMinor = +mn + 1 } else { upperMinor = +mn + 1 }
    const upper = `${upperMajor}.${upperMinor}.0`
    const hi = cmpVer(target, upper)
    // 预发布版本是否放行：DSH 自己用 semver.satisfies({ includePrerelease: true }) 判定
    // （见 dsh-app-boot 的 plugin-compatibility 段），所以这里同样不设"同一 tuple"限制。
    // 实测：`^0.2.0-rc.1` 在 includePrerelease 下接受 0.2.1-rc.2。
    if (lo >= 0 && hi < 0) return { ok: true, why: alt }
    notes.push(`${target} 不在 ${alt} 内`)
  }
  return { ok: false, why: notes.join('; ') }
}

async function fetchJson (url, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: ABBREVIATED, 'user-agent': 'dsh-compat-check' } })
      if (res.status === 404) return { notFound: true }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))) }
  }
  throw last
}
async function pool (items, limit, worker) {
  const results = new Array(items.length); let idx = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      try { results[i] = await worker(items[i]) } catch (e) { results[i] = { error: e.message } }
    }
  }))
  return results
}

// ── 内核版本 ───────────────────────────────────────────────────────────────
/** 从 bin.js 路径反推该安装的 node_modules 根目录。 */
function modulesRootOf (bin) {
  // <root>\node_modules\@deepseek-ai\dsh\lib\bin.js
  return dirname(dirname(dirname(dirname(bin))))
}

function resolveKernel (args) {
  if (args.kernel) return { version: args.kernel, how: '命令行 --kernel', modulesRoot: '' }
  const cfg = readJson(join(process.env.LOCALAPPDATA || '', 'DeepSeekHarness', 'config.json'))
  if (cfg && cfg.dshPath && exists(cfg.dshPath)) {
    const pj = readJson(join(dirname(dirname(cfg.dshPath)), 'package.json'))
    if (pj) return { version: pj.version, how: 'launcher 钉住的 dshPath', modulesRoot: modulesRootOf(cfg.dshPath) }
  }
  const npxRoot = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  if (exists(npxRoot)) {
    const cands = []
    for (const d of readdirSync(npxRoot)) {
      const bin = join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (!exists(bin)) continue
      const pj = readJson(join(dirname(dirname(bin)), 'package.json'))
      if (pj) cands.push({ version: pj.version, mtime: statSync(bin).mtimeMs, root: modulesRootOf(bin) })
    }
    cands.sort((a, b) => b.mtime - a.mtime)
    if (cands[0]) return { version: cands[0].version, how: '_npx 里最新的 bin.js', modulesRoot: cands[0].root }
  }
  return { version: '', how: '未找到', modulesRoot: '' }
}

// ── 扫描已安装插件 ─────────────────────────────────────────────────────────
// 只认真正的模块引用：import ... from 'x' / import('x') / require('x')。
// 用"任意引号里的包名"会把包名清单、诊断字符串、模板前缀（@deepseek-ai/dsh-${x}）
// 也算进来，产生大量假阳性（实测过）。
const SPEC_PATTERNS = [
  /\bfrom\s*['"](@deepseek-ai\/[a-z0-9][a-z0-9.-]*)['"]/g,
  /\brequire\(\s*['"](@deepseek-ai\/[a-z0-9][a-z0-9.-]*)['"]/g,
  /\bimport\(\s*['"](@deepseek-ai\/[a-z0-9][a-z0-9.-]*)['"]/g
]
/** 逐条判断某个 @deepseek-ai 包是否"随内核版本发布"（dsh 与 dsh-* 是；cordis / schemastery 不是）。 */
const isKernelVersioned = (name) => /^@deepseek-ai\/dsh(-|\/|$)/.test(name)

function walkJs (dir, acc, depth) {
  if (depth < 0 || !exists(dir)) return acc
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { walkJs(full, acc, depth - 1); continue }
    if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
    try { if (statSync(full).size > 3 * 1024 * 1024) continue } catch { continue }
    acc.push(full)
  }
  return acc
}

function listPackageDirs (root) {
  const out = []
  if (!exists(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        if (sub.name.startsWith('.')) continue
        out.push(join(full, sub.name))
      }
    } else out.push(full)
  }
  return out
}

function scanPackage (dir, origin) {
  const pj = readJson(join(dir, 'package.json'))
  if (!pj || !pj.name) return null
  if (!/dsh/i.test(pj.name)) return null
  const specifiers = new Set()
  for (const f of walkJs(join(dir, 'lib'), [], 3)) {
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const re of SPEC_PATTERNS) for (const m of text.matchAll(re)) specifiers.add(m[1])
  }
  const enginesDsh = (pj.dsh && pj.dsh.engines && pj.dsh.engines.dsh) || (pj.engines && pj.engines.dsh) || ''
  const peers = Object.entries(pj.peerDependencies || {})
    .filter(([k]) => k.startsWith('@deepseek-ai/'))
    .map(([k, v]) => ({ name: k, range: v }))
  const hasClient = Boolean(pj.dsh && pj.dsh.client)
  return {
    name: pj.name,
    version: pj.version || '(无)',
    origin,
    enginesDsh,
    peers,
    specifiers: [...specifiers].sort(),
    hasClient
  }
}

// ── 运行中实例的引导数据 ───────────────────────────────────────────────────
async function bootEntryIds () {
  const rec = readJson(join(process.env.LOCALAPPDATA || '', 'DeepSeekHarness', 'server-url.json'))
  if (!rec || !rec.url) return { ids: [], why: '没有 server-url.json（实例没在跑？）' }
  try {
    const u = new URL(rec.url)
    const r1 = await fetch(rec.url, { redirect: 'manual' })
    const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean)
    if (!sc.length) return { ids: [], why: '握手没拿到 Cookie（HTTP ' + r1.status + '）' }
    const cookie = sc.map((c) => c.split(';')[0]).join('; ')
    const r2 = await fetch(`${u.protocol}//${u.host}/`, { headers: { cookie } })
    const html = await r2.text()
    const marker = '["__DSH_BOOT__"] = '
    const at = html.indexOf(marker)
    if (at < 0) return { ids: [], why: '页面里没有 __DSH_BOOT__' }
    const start = at + marker.length
    const end = html.indexOf('</script>', start)
    const boot = JSON.parse(html.slice(start, end).trim())
    return { ids: (boot.entries || []).map((e) => e && e.id).filter(Boolean), version: boot.release && boot.release.version }
  } catch (e) { return { ids: [], why: e.message } }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main () {
  const args = parseArgs(process.argv.slice(2))
  const kernel = resolveKernel(args)
  if (!kernel.version) { console.error('找不到内核版本，传 --kernel'); process.exitCode = 2; return }

  const profileDir = join(args.dshHome, 'profiles', args.profile)
  const roots = [
    { dir: join(profileDir, 'node_modules'), origin: 'profile' },
    { dir: join(args.dshHome, 'plugins'), origin: '$DSH_HOME/plugins' }
  ]
  if (args.workspace) roots.push({ dir: join(args.workspace, 'plugin'), origin: '项目 plugin/' })

  const seen = new Map()
  for (const r of roots) {
    for (const dir of listPackageDirs(r.dir)) {
      const rec = scanPackage(dir, r.origin)
      if (!rec) continue
      const key = rec.name
      const prev = seen.get(key)
      if (!prev || prev.origin !== 'profile') seen.set(key, rec)
    }
  }
  const plugins = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))

  // 已装版本表：官方包由"内核安装"提供，插件自带依赖在 profile 里。
  // 只查 profile 会把所有 @deepseek-ai/* 误判成"未安装"（实测踩过）。
  const installed = new Map()
  for (const base of [kernel.modulesRoot, join(profileDir, 'node_modules')]) {
    if (!base || !exists(base)) continue
    for (const dir of listPackageDirs(base)) {
      const pj = readJson(join(dir, 'package.json'))
      if (pj && pj.name && pj.version && !installed.has(pj.name)) installed.set(pj.name, pj.version)
    }
  }

  // 只有 dsh-* 需要"在目标内核版本上有发布"；cordis/schemastery 走自己的版本线
  const referenced = new Set()
  for (const p of plugins) for (const s of p.specifiers) if (isKernelVersioned(s)) referenced.add(s)
  const docs = new Map()
  await pool([...referenced], 6, async (name) => {
    const d = await fetchJson(`${REGISTRY}/${name.replace('/', '%2f')}`).catch(() => null)
    docs.set(name, d && !d.notFound ? d : null)
  })

  const rows = plugins.map((p) => {
    const problems = []
    // 1) 硬冲突：import 了 kernel 版本化的包，但目标内核上没这个版本
    const missing = []
    for (const s of p.specifiers) {
      if (!isKernelVersioned(s)) {
        if (!installed.has(s)) missing.push(`${s}（未安装）`)
        continue
      }
      const d = docs.get(s)
      if (!d) { missing.push(`${s}（registry 查不到）`); continue }
      if (!d.versions || !d.versions[kernel.version]) missing.push(`${s}（没有 ${kernel.version} 版本）`)
    }
    if (missing.length) problems.push({ kind: '硬冲突', detail: '引用的包不可用: ' + missing.join('；') })
    // 2) peer 范围：dsh-* 比内核版本，其他比它自己的已装版本
    const badPeers = []
    for (const pr of p.peers) {
      const target = isKernelVersioned(pr.name) ? kernel.version : installed.get(pr.name)
      if (!target) { badPeers.push(`${pr.name}@${pr.range}（${pr.name} 未安装）`); continue }
      const r = satisfies(target, pr.range)
      if (!r.ok) badPeers.push(`${pr.name}@${pr.range}（实际 ${target}）`)
    }
    if (badPeers.length) problems.push({ kind: 'peer 不满足', detail: badPeers.join('，') })
    // 3) engines.dsh
    if (p.enginesDsh) {
      const r = satisfies(kernel.version, p.enginesDsh)
      if (!r.ok) problems.push({ kind: 'engines 不满足', detail: `声明 ${p.enginesDsh}，内核 ${kernel.version}` })
    }
    const undeclared = !p.enginesDsh && p.peers.length === 0
    return { ...p, problems, undeclared, ok: problems.length === 0 }
  })

  const mount = args.mountCheck ? await bootEntryIds() : { ids: [], why: 'skipped' }
  const mounted = new Set(mount.ids || [])
  for (const r of rows) {
    r.mounted = r.hasClient ? mount.ids.some((id) => id === r.name || id.endsWith('/' + r.name.split('/').pop())) : null
  }

  if (args.json) {
    console.log(JSON.stringify({ kernel, plugins: rows, mount: { count: mounted.size, why: mount.why } }, null, 2))
    return
  }

  console.log(`内核版本: ${kernel.version}   （来源：${kernel.how}）`)
  console.log(`运行中实例的客户端条目: ${mounted.size} 个${mount.why ? '  — ' + mount.why : ''}`)
  console.log('')
  console.log('| 插件 | 版本 | engines.dsh | 官方 peer | 判定 |')
  console.log('|---|---|---|---|---|')
  for (const r of rows) {
    const verdict = r.problems.length === 0
      ? (r.undeclared ? '⚠️ 未声明（靠运行时）' : '✅ 声明支持')
      : '❌ ' + r.problems.map((x) => x.kind).join(' / ')
    const peerNote = r.peers.length ? `${r.peers.length} 条` : '—'
    console.log(`| \`${r.name}\` | ${r.version} | ${r.enginesDsh || '—'} | ${peerNote} | ${verdict} |`)
  }
  console.log('')

  const bad = rows.filter((r) => r.problems.length > 0)
  if (bad.length) {
    console.log('## 需要处理')
    console.log('')
    for (const r of bad) for (const p of r.problems) console.log(`- \`${r.name}@${r.version}\` — **${p.kind}**：${p.detail}`)
    console.log('')
  } else {
    console.log('## 结论：没有发现声明层面的不兼容')
    console.log('')
  }

  const unmounted = rows.filter((r) => r.hasClient && r.mounted === false)
  if (mount.ids.length) {
    console.log('## 装了但没挂上（客户端插件）')
    console.log('')
    if (unmounted.length === 0) console.log('- 无：所有带客户端半边的插件都出现在引导数据里')
    else for (const r of unmounted) console.log(`- \`${r.name}@${r.version}\` — 已安装，但引导数据里没有它的条目`)
    console.log('')
  }

  const undeclared = rows.filter((r) => r.undeclared)
  if (undeclared.length) {
    console.log('## 未声明兼容范围（只能靠运行时判断）')
    console.log('')
    console.log(undeclared.map((r) => `\`${r.name}@${r.version}\``).join('，'))
    console.log('')
  }
}

main().catch((e) => { console.error('[FAIL] ' + e.message); process.exitCode = 1 })
