// classbuzz 后台启停编排：start / stop / status / logs
// 用法：node scripts/classbuzz.mjs start|stop|status|logs [--no-open]
//
// 注意：natapp 内网穿透是「开机自启的服务」，本脚本不负责启停它，
// 只在启动时探测它是否在跑，并读取已配置的公网域名预填到教师页。
import { spawn, execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runDir = path.join(root, '.run')
const publicUrlFile = path.join(root, 'public-url.txt')
const isWin = process.platform === 'win32'

const cmd = process.argv[2] || 'start'
const openBrowser = !process.argv.includes('--no-open')
const PORT = Number(process.env.PORT) || 3000

// ---------- 小工具 ----------

function ensureRunDir() {
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true })
}

function lanIPs() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // 虚拟网卡（VMware/VirtualBox/Docker/Hyper-V 等）学生手机不在这些子网，排除
    const virtual = /vmware|vmnet|virtualbox|vbox|docker|hyper-?v|vethernet|loopback|tap|tun|teredo|zero-?config/i.test(
      name || '',
    )
    if (virtual) continue
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue
      out.push(i.address)
    }
  }
  return out
}

// 服务端启动时会打印自己算好的局域网地址，直接用它，保证与二维码里的地址一致
function lanUrlsFromLog() {
  const txt = tail(path.join(runDir, 'server.log'), 40)
  const urls = []
  for (const line of txt.split('\n')) {
    const m = line.match(/https?:\/\/([^\s:]+):(\d+)/)
    if (!m) continue
    if (m[1] === 'localhost' || m[1] === '127.0.0.1') continue
    if (Number(m[2]) !== PORT) continue
    urls.push(`http://${m[1]}:${m[2]}`)
  }
  return [...new Set(urls)]
}

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, host)
  })
}

async function waitPort(port, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function killPid(pid) {
  if (!pid || !/^\d+$/.test(String(pid))) return
  try {
    if (isWin) execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
    else process.kill(-Number(pid), 'SIGTERM')
  } catch {
    // 已经没了
  }
}

function pidByPort(port) {
  if (!isWin) return null
  try {
    const out = execSync('netstat -ano', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    for (const line of out.split('\n')) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const pid = line.trim().split(/\s+/).pop()
        if (pid && /^\d+$/.test(pid)) return Number(pid)
      }
    }
  } catch {
    // ignore
  }
  return null
}

// natapp 是否在跑（开机自启的服务，只探测不启停）
function natappRunning() {
  if (!isWin) return false
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq natapp.exe" /NH', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()
    return /natapp\.exe/i.test(out)
  } catch {
    return false
  }
}

function readPid(name) {
  try {
    return fs.readFileSync(path.join(runDir, name + '.pid'), 'utf8').trim()
  } catch {
    return null
  }
}

function writePid(name, pid) {
  fs.writeFileSync(path.join(runDir, name + '.pid'), String(pid))
}

function clearPid(name) {
  try {
    fs.unlinkSync(path.join(runDir, name + '.pid'))
  } catch {
    // ignore
  }
}

function tail(file, lines = 20) {
  try {
    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    return all.slice(-lines).join('\n')
  } catch {
    return '(no log yet)'
  }
}

// 公网地址：public-url.txt（第一行非注释）> 环境变量
function publicUrl() {
  const env = process.env.CB_PUBLIC_URL
  if (env) return env.trim()
  try {
    const lines = fs
      .readFileSync(publicUrlFile, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
    if (lines[0]) return lines[0]
  } catch {
    // ignore
  }
  return null
}

function openUrl(url) {
  try {
    if (isWin) {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // 打不开就算了，手动访问即可
  }
}

// 上课前自检：公网地址能不能真的打开
async function probe(url, timeoutMs = 8000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'manual' })
    return { ok: r.status < 500, status: r.status }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '超时' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 启动 ----------

async function startServer() {
  ensureRunDir()
  const old = readPid('server')
  if (old && pidAlive(old)) {
    console.log(`classbuzz 已在运行 (pid=${old})，跳过。`)
    return
  }
  // 端口已被占用 = 服务已经用别的方式跑着（比如前台版 start_classbuzz.bat），别再起一个
  if (await portOpen(PORT)) {
    const p = pidByPort(PORT)
    console.log(`端口 ${PORT} 已被占用 (pid=${p || '未知'})，视为已在运行，跳过启动。`)
    if (p) writePid('server', p)
    return
  }
  const logFd = fs.openSync(path.join(runDir, 'server.log'), 'w')
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(PORT) },
  })
  writePid('server', child.pid)
  console.log(`[*] classbuzz 服务已启动 (pid=${child.pid})  -> .run/server.log`)
}

async function cmdStart() {
  console.log('============================================================')
  console.log(' classbuzz 启动中 ...')
  console.log('============================================================')
  await startServer()

  const up = await waitPort(PORT, 15000)
  if (!up) {
    console.log(`\n[ERROR] 服务没在 ${PORT} 端口起来，看日志：`)
    console.log(tail(path.join(runDir, 'server.log'), 30))
    process.exitCode = 1
    return
  }

  const pub = publicUrl()
  console.log('\n------------------------------------------------------------')
  console.log(`  本机:   http://localhost:${PORT}/host`)
  const lan = lanUrlsFromLog()
  for (const u of lan.length ? lan : lanIPs().map((ip) => `http://${ip}:${PORT}`)) {
    console.log(`  局域网: ${u}/host`)
  }
  if (pub) {
    console.log(`  公网:   ${pub}/host`)
    const res = await probe(pub.replace(/\/+$/, '') + '/')
    console.log(
      `  公网自检: ${res.ok ? 'OK (HTTP ' + res.status + ')' : '失败 (' + (res.error || res.status) + ')'}`,
    )
    if (/^https:\/\//i.test(pub)) {
      console.log('  [注意] 该地址是 https，但 natapp 隧道通常只走明文 http，手机会连不上 -> 改成 http://')
    }
  } else {
    console.log('  公网:   未配置（编辑 public-url.txt 填一行公网地址即可自动带出）')
  }
  console.log(`  穿透:   natapp ${natappRunning() ? '运行中' : '未运行（开机自启的话应已就绪）'}`)
  console.log('------------------------------------------------------------')
  console.log('  停止: node scripts/classbuzz.mjs stop   （或双击 stop_all.bat）')
  console.log('  日志: node scripts/classbuzz.mjs logs')

  const target = pub
    ? `http://localhost:${PORT}/host?public=${encodeURIComponent(pub)}`
    : `http://localhost:${PORT}/host`
  if (openBrowser) {
    openUrl(target)
    console.log('  已打开教师页' + (pub ? '（公网地址已自动预填）' : ''))
  }
}

// ---------- 停止 ----------

function cmdStop() {
  console.log('============================================================')
  console.log(' classbuzz 停止中 ...')
  console.log('============================================================')

  const pid = readPid('server')
  if (pid) {
    killPid(pid)
    clearPid('server')
    console.log(`  服务已停止 (pid=${pid})`)
  } else {
    console.log('  服务无记录')
  }

  // 兜底：端口上还挂着进程就杀掉
  const byPort = pidByPort(PORT)
  if (byPort) {
    killPid(byPort)
    console.log(`  [兜底] 杀掉仍占用 ${PORT} 的进程 (pid=${byPort})`)
  }

  // 清掉历史遗留的 natapp pid 记录（natapp 本身是服务，不动它）
  clearPid('natapp')

  console.log('全部停止。natapp 保持运行（开机自启，未改动）。')
}

// ---------- 状态 / 日志 ----------

async function cmdStatus() {
  const sPid = readPid('server')
  const up = await portOpen(PORT)
  const pub = publicUrl()
  console.log('------------------------------------------------------------')
  console.log(`  服务进程: ${sPid || '无'} ${sPid && pidAlive(sPid) ? '(存活)' : ''}`)
  console.log(`  端口 ${PORT}: ${up ? '监听中' : '未监听'}`)
  console.log(`  natapp:    ${natappRunning() ? '运行中' : '未运行'}`)
  console.log(`  公网地址: ${pub || '未配置'}`)
  console.log('------------------------------------------------------------')
}

function cmdLogs() {
  console.log('===== server.log =====')
  console.log(tail(path.join(runDir, 'server.log'), 30))
}

if (cmd === 'start') await cmdStart()
else if (cmd === 'stop') cmdStop()
else if (cmd === 'status') await cmdStatus()
else if (cmd === 'logs') cmdLogs()
else {
  console.log('用法: node scripts/classbuzz.mjs start|stop|status|logs [--no-open]')
  process.exitCode = 1
}
