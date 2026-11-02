#!/usr/bin/env node
/**
 * dsh-upgrade-report.mjs — 升级工作流「阶段 0」：把"要不要升、升之前要动什么"变成一份报告。
 *
 * 它做四件事：
 *   1. 定位「当前在用的 dsh」（尊重 launcher 的 dshPath，否则挑 _npx 里最新的 bin.js）；
 *   2. 从 npm registry 取 dist-tags 与目标版本的依赖清单，与当前版本做 diff
 *      （新增 / 移除 / 版本区间变化 / 疑似改名）；
 *   3. 扫描本机所有本地插件（profile 的 node_modules、$DSH_HOME/plugins、项目里的 plugin/），
 *      收集它们引用到的 @deepseek-ai/* 包与 ctx 服务；
 *   4. 交叉核对：目标版本里是否还存在这些包 —— 这是"破坏性变更"最可靠的机器信号。
 *
 * 为什么用 registry 的依赖清单而不是发布说明：包被删掉/改名时，依赖清单一定会变，
 * 而发布说明可能漏写。实测 0.2.1 里 dsh-invariants 消失、agent-presets 改名，
 * 都是从依赖清单 diff 出来的。
 *
 * 唯一它做不到的事：抓 GitHub 发布说明（本机到 api.github.com 的连接会被中断），
 * 所以报告里会输出一个 URL，由 agent 用 web_fetch 抓取。
 *
 * 用法：
 *   node dsh-upgrade-report.mjs
 *   node dsh-upgrade-report.mjs --profile web --out .\reports
 *   node dsh-upgrade-report.mjs --dsh-bin "D:\dsh-versions\0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js"
 *   node dsh-upgrade-report.mjs --no-scan-plugins          # 只比版本与依赖，不扫插件
 *   node dsh-upgrade-report.mjs --json                     # 同时落一份机器可读的 json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REGISTRY = 'https://registry.npmjs.org'
const ABBREVIATED = 'application/vnd.npm.install-v1+json'

// 被 `| Select-Object -First N` 之类提前关掉管道时，console.log 会抛 EPIPE。
// 报告已经写盘了，不该因为显示被截断而算失败。
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
const PKG = '@deepseek-ai/dsh'
const REPO = 'deepseek-ai/deepseek-harness'

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs (argv) {
  const out = {
    dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    profile: 'web',
    workspace: '',
    launcherConfig: join(process.env.LOCALAPPDATA || '', 'DeepSeekHarness', 'config.json'),
    outDir: '',
    dshBin: '',
    scanPlugins: true,
    json: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dsh-home') out.dshHome = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--workspace') out.workspace = argv[++i]
    else if (a === '--launcher-config') out.launcherConfig = argv[++i]
    else if (a === '--out') out.outDir = argv[++i]
    else if (a === '--dsh-bin') out.dshBin = argv[++i]
    else if (a === '--no-scan-plugins') out.scanPlugins = false
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0) }
  }
  if (!out.outDir) out.outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports')
  return out
}

const HELP = `用法: node dsh-upgrade-report.mjs [选项]
  --dsh-home <dir>         DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
  --profile <name>         profile 名（默认 web）
  --workspace <dir>        额外扫描的工程目录（其下 plugin/* 会被扫描）
  --launcher-config <file> launcher 的 config.json（默认 %LOCALAPPDATA%\\DeepSeekHarness\\config.json）
  --dsh-bin <file>         直接指定当前 dsh 的 lib/bin.js
  --out <dir>              报告输出目录
  --no-scan-plugins        跳过本地插件扫描
  --json                   额外输出机器可读 json
`

// ── 小工具 ───────────────────────────────────────────────────────────────────
function readJson (p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function exists (p) { try { statSync(p); return true } catch { return false } }

async function fetchJson (url, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: ABBREVIATED, 'user-agent': 'dsh-upgrade-report' } })
      if (res.status === 404) return { notFound: true }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

/** 极简 semver：只为判断"目标版本是否落在插件声明的范围内"，不是完整实现。 */
function parseVer (v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}
function cmpPre (a, b) {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? -1 : 1
}
function cmpVer (a, b) {
  const x = parseVer(a); const y = parseVer(b)
  if (!x || !y) return 0
  if (x.major !== y.major) return x.major < y.major ? -1 : 1
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1
  return cmpPre(x.pre, y.pre)
}
const RANGE_RE = /^(\^|~|>=|>|<=|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** 简化判断；不满足时也返回原因，便于报告里解释。 */
function satisfies (target, range) {
  if (!range || typeof range !== 'string') return { ok: true, why: 'no range' }
  const alts = range.split('||').map((s) => s.trim()).filter(Boolean)
  if (alts.length === 0) return { ok: true, why: 'empty range' }
  const t = parseVer(target)
  if (!t) return { ok: true, why: 'unparsable target' }
  const notes = []
  for (const alt of alts) {
    const m = RANGE_RE.exec(alt)
    if (!m) { notes.push(`无法解析: ${alt}`); continue }
    const [, op = '', mj, mn, pt, pre] = m
    const lower = `${mj}.${mn}.${pt}${pre ? '-' + pre : ''}`
    const lo = cmpVer(target, lower)
    if (op === '>=') { if (lo >= 0) return { ok: true, why: alt }; notes.push(`${target} < ${lower}`); continue }
    if (op === '>') { if (lo > 0) return { ok: true, why: alt }; notes.push(`${target} <= ${lower}`); continue }
    if (op === '<' || op === '<=') {
      if (op === '<' ? lo < 0 : lo <= 0) return { ok: true, why: alt }
      notes.push(`${target} 不符合 ${alt}`); continue
    }
    if (op === '' || op === '=') { if (lo === 0) return { ok: true, why: alt }; notes.push(`不等于 ${lower}`); continue }
    // ^ 与 ~
    let upperMinor = +mn
    let upperMajor = +mj
    if (op === '^') { if (+mj > 0) upperMajor = +mj + 1; else upperMinor = +mn + 1 }
    else { upperMinor = +mn + 1 }
    const upper = `${upperMajor}.${upperMinor}.0`
    const hi = cmpVer(target, upper)
    const sameCore = t.major === +mj && t.minor === +mn && t.patch === +pt
    const preOk = !t.pre || sameCore
    if (lo >= 0 && hi < 0 && preOk) return { ok: true, why: alt }
    notes.push(`${target} 不在 ${alt} 内`)
  }
  return { ok: false, why: notes.join('; ') }
}

async function pool (items, limit, worker) {
  const results = new Array(items.length)
  let idx = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      try { results[i] = await worker(items[i], i) } catch (err) { results[i] = { error: err.message } }
    }
  })
  await Promise.all(runners)
  return results
}

// ── 1. 定位当前在用的 dsh ────────────────────────────────────────────────────
function locateCurrentDsh (args) {
  const candidates = []
  const fromArg = (bin, how) => candidates.push({ bin, how })

  if (args.dshBin) fromArg(args.dshBin, '命令行 --dsh-bin')
  const cfg = readJson(args.launcherConfig)
  if (cfg && cfg.dshPath && exists(cfg.dshPath)) fromArg(cfg.dshPath, 'launcher config.json 的 dshPath（已钉住）')

  const npxRoot = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  if (exists(npxRoot)) {
    for (const d of readdirSync(npxRoot)) {
      const bin = join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (exists(bin)) candidates.push({ bin, how: `_npx 缓存 (${d})`, mtime: statSync(bin).mtimeMs })
    }
  }
  if (candidates.length === 0) return null

  const pinned = candidates.filter((c) => c.how.includes('dshPath'))
  if (pinned.length > 0) return { ...pinned[0], pinned: true }
  candidates.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return { ...candidates[0], pinned: false, others: candidates.slice(1) }
}

// ── 2. registry ─────────────────────────────────────────────────────────────
async function getPackument () {
  const doc = await fetchJson(`${REGISTRY}/${PKG.replace('/', '%2f')}`)
  if (doc.notFound) throw new Error('registry 上没有 @deepseek-ai/dsh')
  return doc
}

// ── 3. 扫描本地插件 ─────────────────────────────────────────────────────────
const SPEC_RE = /['"](@deepseek-ai\/[a-z0-9][a-z0-9.-]*)['"]/g
const CTX_RE = /\bctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g
const INJECT_RE = /\binject\s*[=:]\s*\[([^\]]*)\]/g

function listPackageDirs (root, depth) {
  const out = []
  if (!exists(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        if (sub.name.startsWith('.')) continue
        out.push(join(full, sub.name))
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      out.push(full)
    }
  }
  return out
}

function walkJs (dir, acc, depth) {
  if (depth < 0) return acc
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

function scanPluginPackage (dir, origin) {
  const pjPath = join(dir, 'package.json')
  if (!exists(pjPath)) return null
  const pj = readJson(pjPath)
  if (!pj || !pj.name) return null
  if (!/dsh/i.test(pj.name)) return null

  const specifiers = new Set()
  const services = new Set()
  const injects = new Set()
  const files = walkJs(join(dir, 'lib'), [], 3)
  for (const f of files) {
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const m of text.matchAll(SPEC_RE)) specifiers.add(m[1])
    for (const m of text.matchAll(CTX_RE)) services.add(m[1])
    for (const m of text.matchAll(INJECT_RE)) {
      for (const s of m[1].matchAll(/['"]([a-zA-Z][a-zA-Z0-9_]*)['"]/g)) injects.add(s[1])
    }
  }
  const officialPeers = Object.entries(pj.peerDependencies || {})
    .filter(([k]) => k.startsWith('@deepseek-ai/'))
    .map(([k, v]) => `${k}@${v}`)
  const enginesDsh = (pj.engines && pj.engines.dsh) || (pj.dsh && pj.dsh.engines && pj.dsh.engines.dsh) || ''

  return {
    name: pj.name,
    version: pj.version || '(无版本)',
    origin,
    enginesDsh,
    officialPeers,
    specifiers: [...specifiers].sort(),
    services: [...services].sort(),
    injects: [...injects].sort(),
    sourceFiles: files.length
  }
}

function collectLocalPlugins (args) {
  const found = new Map()
  const roots = [
    { dir: join(args.dshHome, 'profiles', args.profile, 'node_modules'), origin: `profile ${args.profile} 的 node_modules` },
    { dir: join(args.dshHome, 'plugins'), origin: '$DSH_HOME/plugins' }
  ]
  if (args.workspace) roots.push({ dir: join(args.workspace, 'plugin'), origin: '项目内 plugin/' })

  for (const r of roots) {
    for (const dir of listPackageDirs(r.dir)) {
      const rec = scanPluginPackage(dir, r.origin)
      if (!rec) continue
      const key = `${rec.name}@${rec.version}`
      if (!found.has(key)) found.set(key, rec)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── 4. 主流程 ───────────────────────────────────────────────────────────────
async function main () {
  const args = parseArgs(process.argv.slice(2))
  const lines = []
  const log = (s = '') => { lines.push(s); console.log(s) }

  const cur = locateCurrentDsh(args)
  if (!cur) {
    console.error('[FAIL] 找不到本地已安装的 @deepseek-ai/dsh（检查 _npx 缓存或传 --dsh-bin）')
    process.exit(2)
  }
  const curPkg = readJson(join(dirname(dirname(cur.bin)), 'package.json'))
  const currentVersion = curPkg ? curPkg.version : '(未知)'
  const currentDeps = (curPkg && curPkg.dependencies) || {}

  log('# DSH 升级评估报告')
  log()
  log(`生成时间：${new Date().toLocaleString('zh-CN')}`)
  log(`DSH_HOME：\`${args.dshHome}\`  ·  profile：\`${args.profile}\``)
  log()
  log('## 1. 版本')
  log()
  log('| 项 | 值 |')
  log('|---|---|')
  log(`| 当前在用 | **${currentVersion}** |`)
  log(`| 来源 | ${cur.how}${cur.pinned ? '（已钉住，launcher 不会自动跳版本）' : '（未钉住：launcher 按 bin.js 修改时间挑最新）'} |`)
  log(`| 路径 | \`${cur.bin}\` |`)
  if (cur.others && cur.others.length > 0) {
    log(`| 其他可用 | ${cur.others.map((o) => `${readJson(join(dirname(dirname(o.bin)), 'package.json'))?.version || '?'} (${o.how})`).join('；')} |`)
  }

  const doc = await getPackument()
  const tags = doc['dist-tags'] || {}
  const target = tags.latest
  log(`| registry latest | **${target}** |`)
  const otherTags = Object.entries(tags).filter(([k]) => k !== 'latest')
  if (otherTags.length > 0) log(`| 其他 tag | ${otherTags.map(([k, v]) => `${k}=${v}`).join('，')} |`)
  log()

  if (!target) { console.error('[FAIL] registry 上没有 latest 标签'); process.exit(3) }
  const targetVer = doc.versions[target]
  const targetDeps = (targetVer && targetVer.dependencies) || {}

  if (cmpVer(target, currentVersion) <= 0) {
    log(`> 当前已是最新（${currentVersion} ≥ ${target}），无需升级。`)
    if (args.json) writeJsonReport(args, { currentVersion, target, upToDate: true })
    writeMarkdown(args, lines)
    return
  }

  // ── 依赖清单 diff ──
  const curKeys = Object.keys(currentDeps)
  const tgtKeys = Object.keys(targetDeps)
  const added = tgtKeys.filter((k) => !curKeys.includes(k))
  const removed = curKeys.filter((k) => !tgtKeys.includes(k))
  const changed = curKeys.filter((k) => tgtKeys.includes(k) && currentDeps[k] !== targetDeps[k])

  // 疑似改名：剥掉末段复数 s 后相同
  const norm = (n) => n.replace(/([a-z])(s)$/, '$1')
  const renames = []
  for (const r of removed) {
    const hit = added.find((a) => norm(a) === norm(r))
    if (hit) renames.push([r, hit])
  }

  log(`## 2. 依赖清单差异（${currentVersion} → ${target}）`)
  log()
  log(`官方包总数：${curKeys.length} → ${tgtKeys.length}；新增 ${added.length}，移除 ${removed.length}，区间变化 ${changed.length}`)
  log()
  if (renames.length > 0) {
    log('### 疑似改名（**这类最需要人工确认**）')
    log()
    log('| 旧包 | 新包 |')
    log('|---|---|')
    for (const [a, b] of renames) log(`| \`${a}\` | \`${b}\` |`)
    log()
  }
  if (removed.length > 0) {
    log('### 被移除的官方包（**依赖它们的插件会直接报错，因为包根本不存在了**）')
    log()
    for (const r of removed) log(`- \`${r}\`（原 ${currentDeps[r]}）`)
    log()
  }
  if (added.length > 0) {
    log('### 新增的官方包')
    log()
    for (const a of added) log(`- \`${a}\`（${targetDeps[a]}）`)
    log()
  }
  const changedOfficial = changed.filter((c) => c.startsWith('@deepseek-ai/'))
  const changedOther = changed.filter((c) => !c.startsWith('@deepseek-ai/'))
  if (changedOfficial.length > 0) {
    log('### 版本区间变化（官方包）')
    log()
    log('| 包 | 旧 | 新 |')
    log('|---|---|---|')
    for (const c of changedOfficial) log(`| \`${c}\` | ${currentDeps[c]} | ${targetDeps[c]} |`)
    log()
  }
  if (changedOther.length > 0) {
    log(`### 版本区间变化（第三方依赖，共 ${changedOther.length} 个，一般无需关注）`)
    log()
    log(changedOther.map((c) => `\`${c}\` ${currentDeps[c]} → ${targetDeps[c]}`).join('；'))
    log()
  }

  // ── 本地插件扫描与交叉核对 ──
  let plugins = []
  let missingRefs = []
  let peerIssues = []
  if (args.scanPlugins) {
    plugins = collectLocalPlugins(args)
    const referenced = new Set()
    for (const p of plugins) for (const s of p.specifiers) referenced.add(s)

    const refList = [...referenced].sort()
    const pkgDocs = new Map()
    await pool(refList, 6, async (name) => {
      try {
        const d = await fetchJson(`${REGISTRY}/${name.replace('/', '%2f')}`)
        pkgDocs.set(name, d.notFound ? null : d)
      } catch { pkgDocs.set(name, null) }
    })
    for (const name of refList) {
      const d = pkgDocs.get(name)
      if (!d) { missingRefs.push({ name, why: 'registry 上查不到这个包' }); continue }
      if (!d.versions || !d.versions[target]) {
        const has = d.versions ? Object.keys(d.versions) : []
        missingRefs.push({ name, why: `没有 ${target} 版本（该包最新 ${has.filter((v) => /^\d/.test(v)).sort(cmpVer).pop() || '未知'}）` })
      }
    }

    for (const p of plugins) {
      for (const peer of p.officialPeers) {
        const at = peer.lastIndexOf('@')
        const name = peer.slice(0, at)
        const range = peer.slice(at + 1)
        if (name === PKG || name.startsWith('@deepseek-ai/dsh')) {
          const r = satisfies(target, range)
          if (!r.ok) peerIssues.push({ plugin: p.name, peer, why: r.why })
        }
      }
    }

    log(`## 3. 本地插件（${plugins.length} 个）`)
    log()
    if (plugins.length === 0) {
      log('未扫描到本地插件（检查 --dsh-home / --profile / --workspace）。')
      log()
    } else {
      log('| 插件 | 版本 | engines.dsh | 引用官方包 | inject 服务 | 来源 |')
      log('|---|---|---|---|---|---|')
      for (const p of plugins) {
        log(`| \`${p.name}\` | ${p.version} | ${p.enginesDsh || '—'} | ${p.specifiers.length ? p.specifiers.join('<br>') : '**0 个**'} | ${p.injects.length ? p.injects.join(', ') : (p.services.length ? p.services.slice(0, 6).join(', ') : '—')} | ${p.origin} |`)
      }
      log()
    }

    log('## 4. 风险清单')
    log()
    if (missingRefs.length === 0 && peerIssues.length === 0) {
      log('- 没有发现"引用了目标版本不存在的包"或"peer 范围不满足"。这**不代表**一定兼容——服务方法的行为变化、DOM/类名变化查不出来。')
    }
    if (missingRefs.length > 0) {
      log('### 4.1 引用了目标版本里不存在的官方包（硬冲突）')
      log()
      for (const m of missingRefs) log(`- \`${m.name}\`：${m.why}`)
      log()
    }
    if (peerIssues.length > 0) {
      log('### 4.2 peer 范围不接受目标版本（需升级该插件）')
      log()
      log('| 插件 | 声明 | 原因 |')
      log('|---|---|---|')
      for (const i of peerIssues) log(`| \`${i.plugin}\` | \`${i.peer}\` | ${i.why} |`)
      log()
    }
  }

  // ── 发布说明 ──
  log('## 5. 发布说明（需要 agent 用 web_fetch 抓取）')
  log()
  log('本机到 `api.github.com` 的连接会被中断，脚本抓不到，请让 agent 用 web_fetch 取这两份：')
  log()
  log(`- \`https://api.github.com/repos/${REPO}/releases/tags/dsh-v${target}\``)
  log(`- \`https://api.github.com/repos/${REPO}/releases?per_page=10\`（看中间还夹了哪些版本）`)
  log()
  log('重点读「其他变更 / 破坏性变更」「问题修复」两节。')
  log()

  log('## 6. 下一步')
  log()
  log('1. 按上面「风险清单」决定哪些插件必须先升（第 4.1 / 4.2 节就是清单）。')
  log('2. 走隔离试运行：`scripts\\dsh-trial.ps1` 准备副本 home 与独立端口。')
  log('3. 试运行通过后，用 `scripts\\dsh-version.mjs pin` 切换正式环境。')
  log()

  writeMarkdown(args, lines)
  if (args.json) {
    writeJsonReport(args, { currentVersion, target, added, removed, changed, renames, plugins, missingRefs, peerIssues })
  }
}

function outPath (args, ext) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return join(args.outDir, `dsh-upgrade-report-${stamp}.${ext}`)
}

function writeMarkdown (args, lines) {
  mkdirSync(args.outDir, { recursive: true })
  const p = outPath(args, 'md')
  writeFileSync(p, lines.join('\n') + '\n', 'utf8')
  console.log(`\n[OK] 报告已写入: ${p}`)
}

function writeJsonReport (args, data) {
  mkdirSync(args.outDir, { recursive: true })
  const p = outPath(args, 'json')
  writeFileSync(p, JSON.stringify({ generatedAt: new Date().toISOString(), ...data }, null, 2), 'utf8')
  console.log(`[OK] JSON 已写入: ${p}`)
}

main().catch((err) => {
  console.error('[FAIL] ' + err.message)
  process.exit(1)
})
