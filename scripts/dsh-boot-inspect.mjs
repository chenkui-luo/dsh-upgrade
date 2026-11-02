#!/usr/bin/env node
/**
 * dsh-boot-inspect.mjs — 抓一个 dsh web 实例的引导数据，看客户端插件是否真的挂上了。
 *
 * 背景：截图能看"画面像不像对的"，但在某些机器上无头浏览器起不来（Chrome 156 的
 * 更新器 IPC、Edge 直接挂住）。这时退一步用本脚本：把页面 HTML 里的 __DSH_BOOT__
 * 取出来，数一数它声明了哪些客户端模块/插件。插件没挂上，这里就少条目。
 *
 * 用法：
 *   node dsh-boot-inspect.mjs --url "http://127.0.0.1:3081/?token=xxx"
 *   node dsh-boot-inspect.mjs --port 3081 --token xxx --save-html out.html
 */

import { writeFileSync } from 'node:fs'

process.stdout.on('error', () => {})

function parseArgs (argv) {
  const out = { url: '', port: '', token: '', saveHtml: '', json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') out.url = argv[++i]
    else if (a === '--port') out.port = argv[++i]
    else if (a === '--token') out.token = argv[++i]
    else if (a === '--save-html') out.saveHtml = argv[++i]
    else if (a === '--json') out.json = true
  }
  if (!out.url && out.port) out.url = `http://127.0.0.1:${out.port}/${out.token ? '?token=' + out.token : ''}`
  if (!out.url) throw new Error('需要 --url 或 --port')
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const u = new URL(args.url)
  const base = `${u.protocol}//${u.host}`

  const r1 = await fetch(args.url, { redirect: 'manual' })
  const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean)
  if (r1.status < 300 || r1.status >= 400 || sc.length === 0) {
    console.log(`握手异常: HTTP ${r1.status}，Set-Cookie ${sc.length} 个`)
    process.exitCode = 1
    return
  }
  const cookie = sc.map((c) => c.split(';')[0]).join('; ')
  const r2 = await fetch(base + '/', { headers: { cookie } })
  const html = await r2.text()
  if (!args.json) console.log(`页面: HTTP ${r2.status}, ${html.length} 字节`)
  if (args.saveHtml) { writeFileSync(args.saveHtml, html, 'utf8'); if (!args.json) console.log(`HTML 已存: ${args.saveHtml}`) }

  const idx = html.indexOf('__DSH_BOOT__')
  if (idx < 0) { console.log('没找到 __DSH_BOOT__'); process.exitCode = 1; return }

  // 打印引导数据附近的原文，便于看清结构
  if (!args.json) {
    const from = Math.max(0, idx - 80)
    const snippet = html.slice(from, from + 1200)
    console.log('\n--- __DSH_BOOT__ 附近原文 ---')
    console.log(snippet.replace(/\s+/g, ' ').slice(0, 900))
  }

  // 结构化取出引导数据：0.1.5 与 0.2.1 的 id 命名与是否带 release 字段都不同，
  // 按前缀正则去数会得出完全错误的结论（实测 0.1.5 只有 9 个前缀命中，0.2.1 有 24 个，
  // 但那只是 id 写法不同）。所以这里直接解析 JSON 取 entries[].id。
  const marker = '["__DSH_BOOT__"] = '
  const at = html.indexOf(marker)
  let entries = []
  let version = '(未知)'
  if (at >= 0) {
    const start = at + marker.length
    const end = html.indexOf('</script>', start)
    const raw = html.slice(start, end >= 0 ? end : html.length).trim()
    try {
      const boot = JSON.parse(raw)
      entries = Array.isArray(boot.entries) ? boot.entries.map((e) => e && e.id).filter(Boolean) : []
      if (boot.release && boot.release.version) version = boot.release.version
    } catch (err) {
      if (!args.json) console.log('引导 JSON 解析失败: ' + err.message)
    }
  }
  // 兜底：结构解析失败时退回前缀扫描
  if (entries.length === 0) {
    for (const m of html.matchAll(/["'](?:@linxin666\/|dsh-)[a-z0-9][a-z0-9./-]*["']/g)) entries.push(m[0].slice(1, -1))
  }
  entries = [...new Set(entries)].sort()

  if (args.json) {
    console.log(JSON.stringify({ version, count: entries.length, ids: entries }, null, 2))
    return
  }

  console.log(`\n版本: ${version}`)
  console.log(`\n--- 客户端插件条目（${entries.length} 个）---`)
  for (const n of entries) console.log('  ' + n)

  // 只列有客户端半边的插件：dsh-usage-notice 是纯宿主插件，页面里本来就不会出现
  const expect = ['dsh-sidebar-opacity', 'dsh-plugin-app-icon', 'dsh-plugin-restart', 'dsh-better-sidebar']
  console.log('\n--- 关键自建/第三方插件是否出现 ---')
  let missing = 0
  for (const e of expect) {
    const hit = entries.some((n) => n.includes(e))
    if (!hit) missing++
    console.log(`  ${hit ? 'FOUND  ' : 'ABSENT '} ${e}`)
  }
  console.log(`\n缺失 ${missing} / ${expect.length}`)
  process.exitCode = missing === 0 ? 0 : 1
}

main().catch((e) => { console.error('[FAIL] ' + e.message); process.exitCode = 1 })
