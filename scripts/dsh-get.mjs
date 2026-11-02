#!/usr/bin/env node
/**
 * dsh-get.mjs — 带鉴权地 GET 一个 dsh 实例上的路径，打印响应。
 *
 * 用途：调试插件自己的 HTTP 端点。PowerShell 的 Invoke-WebRequest 在 -MaximumRedirection 0
 * 时拿不到 Set-Cookie，所以这里用 node 的 fetch 走两步握手（与 dsh-smoke.mjs 同法）。
 *
 * 用法：
 *   node dsh-get.mjs --url "http://127.0.0.1:3081/?token=xxx" --path /wallpaper-engine/inventory
 *   node dsh-get.mjs --url "..." --path /wallpaper-engine/inventory --keys
 */

process.stdout.on('error', () => {})

function parseArgs (argv) {
  const out = { url: '', path: '', keys: false, maxBytes: 4000, save: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') out.url = argv[++i]
    else if (a === '--path') out.path = argv[++i]
    else if (a === '--keys') out.keys = true
    else if (a === '--save') out.save = argv[++i]
    else if (a === '--max-bytes') out.maxBytes = Number(argv[++i])
    else if (a === '--help' || a === '-h') { console.log('用法: node dsh-get.mjs --url "<带 token 的地址>" --path <路径> [--keys] [--save <file>]'); process.exit(0) }
  }
  if (!out.url || !out.path) throw new Error('需要 --url 与 --path')
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const u = new URL(args.url)
  const base = `${u.protocol}//${u.host}`

  const r1 = await fetch(args.url, { redirect: 'manual' })
  const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean)
  if (sc.length === 0) { console.error(`握手未拿到 Cookie（HTTP ${r1.status}）`); process.exitCode = 1; return }
  const cookie = sc.map((c) => c.split(';')[0]).join('; ')

  const r2 = await fetch(base + args.path, { headers: { cookie } })
  const text = await r2.text()
  console.log(`GET ${args.path} -> HTTP ${r2.status}  ${r2.headers.get('content-type') || ''}  ${text.length} 字节`)
  if (args.save) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(args.save, text, 'utf8')
    console.log(`已保存: ${args.save}`)
  }
  if (r2.status !== 200) { console.log(text.slice(0, 500)); process.exitCode = 1; return }

  if (args.keys) {
    try {
      const j = JSON.parse(text)
      console.log('--- 顶层字段 ---')
      for (const [k, v] of Object.entries(j)) {
        let desc
        if (Array.isArray(v)) desc = `数组(${v.length})`
        else if (v === null) desc = 'null'
        else if (typeof v === 'object') desc = `对象{${Object.keys(v).slice(0, 6).join(', ')}}`
        else desc = String(v).slice(0, 80)
        console.log(`  ${k} : ${desc}`)
      }
    } catch (e) { console.log('（不是 JSON）') }
    return
  }
  console.log(text.slice(0, args.maxBytes))
}

main().catch((e) => { console.error('[FAIL] ' + e.message); process.exitCode = 1 })
