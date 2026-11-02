#!/usr/bin/env node
/**
 * dsh-switch-detached.mjs — 把切换交给一个"独立于本会话"的进程，并把它自己的输出写进日志。
 *
 * 为什么必须 detach：dsh-switch.ps1 的第 5 步会重启 dsh web，而那个进程正是
 * 承载本对话的进程。从对话里直接跑，会在中途把自己杀掉，结果无从得知。
 *
 * 为什么用 node 而不是 PowerShell 的 Start-Process：
 *   Windows PowerShell 5.1 里 `Start-Process -RedirectStandardOutput ... -WindowStyle Hidden`
 *   组合会抛 "Unable to find the specified file"（本仓库 launcher 的注释记录过）。
 *   node 的 spawn 把子进程 stdout/stderr 直接接到一个文件描述符上，不经过管道，稳定。
 *
 * 用法：
 *   node dsh-switch-detached.mjs --version 0.2.1-rc.2 --plan     # 干跑，验证管道
 *   node dsh-switch-detached.mjs --version 0.2.1-rc.2            # 真正切换
 */

import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.stdout.on('error', () => {})

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs (argv) {
  const out = { version: '', plan: false, skipBackup: false, backupRoot: 'D:\\dsh-backup', logDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') out.version = argv[++i]
    else if (a === '--plan') out.plan = true
    else if (a === '--skip-backup') out.skipBackup = true
    else if (a === '--backup-root') out.backupRoot = argv[++i]
    else if (a === '--log-dir') out.logDir = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log('用法: node dsh-switch-detached.mjs --version <ver> [--plan] [--skip-backup] [--backup-root <dir>] [--log-dir <dir>]')
      process.exit(0)
    }
  }
  if (!out.version) throw new Error('需要 --version')
  if (!out.logDir) out.logDir = join(out.backupRoot, 'switch-logs')
  return out
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const child = join(HERE, 'dsh-switch.ps1')
  if (!existsSync(child)) throw new Error('找不到 dsh-switch.ps1: ' + child)
  if (!existsSync(args.logDir)) mkdirSync(args.logDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const log = join(args.logDir, `switch-${args.version}-${stamp}.log`)

  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', child, '-Version', args.version, '-BackupRoot', args.backupRoot]
  if (!args.plan) psArgs.push('-Apply')
  if (args.skipBackup) psArgs.push('-SkipBackup')

  // stdio 接到文件描述符（不是管道）：沙箱下管道捕获会 EPERM，文件描述符没问题。
  // 注意：这里**不能**在 spawn 之后 closeSync(fd)。关掉父进程这一侧的句柄会让子进程
  // 继承到的句柄失效，日志变成 0 字节（实测踩过）。父进程退出时由系统回收即可。
  const fd = openSync(log, 'a')
  const shell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const p = spawn(shell, psArgs, {
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    detached: true
  })
  p.unref()

  console.log(`模式  : ${args.plan ? 'PLAN（子进程干跑，不改任何东西）' : 'APPLY（会重启服务）'}`)
  console.log(`子进程: pid ${p.pid}`)
  console.log(`日志  : ${log}`)
  console.log('')
  console.log('这是独立进程，本会话被重启打断也照样跑完。稍后用：')
  console.log(`  node -e "console.log(require('fs').readFileSync(String.raw\`${log}\`,'utf8').split('\\n').slice(-40).join('\\n'))"`)
  console.log('或直接读上面的日志路径。')
}

try { main() } catch (e) { console.error('[FAIL] ' + e.message); process.exitCode = 1 }
