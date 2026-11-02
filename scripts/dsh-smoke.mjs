#!/usr/bin/env node
/**
 * dsh-smoke.mjs — 阶段 3 的机器冒烟：确认一个 dsh web 实例真的能对外提供页面。
 *
 * 为什么不直接用 curl：`dsh web` 的鉴权是「首请求带 ?token= → 303 + Set-Cookie → 再请求 /」。
 * 跟随跳转但不带 Cookie 的客户端（curl -L、fetch 默认）只会拿到 401，看起来像坏了，
 * 其实协议是对的。所以这里按浏览器的两步走。
 *
 * 用法：
 *   node dsh-smoke.mjs --url "http://127.0.0.1:3081/?token=xxxx"
 *   node dsh-smoke.mjs --port 3081 --token xxxx
 *   node dsh-smoke.mjs --url "..." --json
 *
 * 退出码：0 全过；1 有失败项。
 */

const TIMEOUT_MS = 20000

process.stdout.on('error', () => {})

function parseArgs (argv) {
  const out = { url: '', port: '', token: '', json: false, base: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') out.url = argv[++i]
    else if (a === '--port') out.port = argv[++i]
    else if (a === '--token') out.token = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log('用法: node dsh-smoke.mjs --url "<带 token 的地址>" | --port <n> --token <t>')
      process.exit(0)
    }
  }
  return out
}

async function get (url, opts = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, redirect: opts.redirect || 'manual' })
    const text = res.headers.get('content-type')?.includes('text') ? await res.text() : ''
    return { res, text }
  } finally {
    clearTimeout(t)
  }
}

const checks = []
function record (name, ok, detail) {
  checks.push({ name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`[${tag}] ${name}${detail ? '  — ' + detail : ''}`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  let entry = args.url
  if (!entry) {
    if (!args.port) throw new Error('需要 --url 或 --port')
    const base = `http://127.0.0.1:${args.port}`
    entry = args.token ? `${base}/?token=${args.token}` : base
  }
  const u = new URL(entry)
  const base = `${u.protocol}//${u.host}`

  console.log(`目标: ${base}   token: ${u.searchParams.get('token') ? '有' : '无'}`)

  // 1) 令牌握手
  const step1 = await get(entry).catch((e) => ({ error: e.message }))
  if (step1.error) {
    record('服务可达', false, step1.error)
    return finish(args)
  }
  record('服务可达', true, `HTTP ${step1.res.status}`)

  const setCookies = step1.res.headers.getSetCookie
    ? step1.res.headers.getSetCookie()
    : [step1.res.headers.get('set-cookie')].filter(Boolean)
  const location = step1.res.headers.get('location')
  const isRedirect = step1.res.status >= 300 && step1.res.status < 400
  record('令牌握手返回跳转', isRedirect, isRedirect ? `${step1.res.status} -> ${location}` : `意外状态 ${step1.res.status}`)
  record('下发鉴权 Cookie', setCookies.length > 0, setCookies.length ? setCookies.map((c) => c.split('=')[0]).join(', ') : '没有 Set-Cookie')

  if (!isRedirect || setCookies.length === 0) {
    // 裸地址或令牌无效时，这里就是终点：401 也如实记录
    const body = step1.text.slice(0, 120)
    record('页面可用', false, step1.res.status === 401 ? '401 需要鉴权（地址没带 token？）' : body)
    return finish(args)
  }

  // 2) 带 Cookie 取页面
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  const step2 = await get(base + '/', { headers: { cookie } }).catch((e) => ({ error: e.message }))
  if (step2.error) {
    record('页面可用', false, step2.error)
    return finish(args)
  }
  const ct = step2.res.headers.get('content-type') || ''
  record('页面返回 200', step2.res.status === 200, `HTTP ${step2.res.status} ${ct}`)
  record('返回的是 HTML', ct.includes('text/html'), ct || '(无 content-type)')
  record('页面非空', step2.text.length > 1000, `${step2.text.length} 字节`)
  const hasBoot = /__DSH_BOOT__|window\.__DSH/.test(step2.text)
  record('含客户端引导数据', hasBoot, hasBoot ? '' : '没找到 __DSH_BOOT__（可能是精简外壳）')

  finish(args)
}

function finish (args) {
  const failed = checks.filter((c) => !c.ok)
  const summary = { target: args.url || args.port, passed: checks.length - failed.length, failed: failed.length, checks }
  if (args.json) console.log(JSON.stringify(summary, null, 2))
  console.log(`\n结果: ${summary.passed} 通过 / ${summary.failed} 失败`)
  // 不要用 process.exit()：fetch 的 keep-alive 连接还在关闭中，强退会触发 libuv 断言
  // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），让退出码变成 0xC0000409。
  // 设 exitCode 后自然退出即可。
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((e) => { console.error('[FAIL] ' + e.message); process.exit(1) })
