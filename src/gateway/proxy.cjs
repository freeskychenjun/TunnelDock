'use strict'
// TunnelDock 通用网关代理（跑在 utilityProcess 里，零第三方依赖）
// 职责：PIN 口令墙（网页登录 + Basic）+ 会话 Cookie + 按 IP 限速 + WebSocket 透传
// 蓝本：本会话自研的 auth-proxy.js（去掉了 DSH 特有的 token/Host 逻辑，加入限速）
const http = require('http')
const net = require('net')
const crypto = require('crypto')
const fs = require('fs')

const cfgArg = process.argv.find((a) => a.startsWith('{'))
const cfg = cfgArg ? JSON.parse(cfgArg) : {}
const LISTEN_HOST = cfg.listenHost || '127.0.0.1'
const LISTEN_PORT = Number(cfg.listenPort || 0) // 0 = OS 分配，实际端口经 postMessage 上报
const TARGET_HOST = cfg.targetHost || '127.0.0.1'
const TARGET_PORT = Number(cfg.targetPort || 80)
const PIN = String(cfg.pin || '')
const SERVICE_NAME = cfg.serviceName || 'service'
const UPSTREAM_HOST = `${TARGET_HOST}:${TARGET_PORT}`
// 服务自带令牌引导（如 dsh web 的启动 token）：从指定文件里取最新一条
// `token=xxx` 作为 ?token= 引导一次。留空 = 不启用。
const TOKEN_SOURCE_FILE = cfg.tokenSource || ''

const AUTH_USER = 'tunneldock' // Basic 认证用户名，口令即 PIN
const COOKIE_NAME = 'td_auth'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const LOGIN_PATH = '/_td_auth'
const FAIL_WINDOW_MS = 60000 // 限速窗口
const FAIL_MAX = 5 // 窗口内最多失败次数
const BLOCK_MS = 60000 // 超限封锁时长
const sessions = new Map() // token -> expiry
const fails = new Map() // ip -> { times: [], blockedUntil }

function post(msg) {
  try {
    process.parentPort.postMessage(msg) // 生产：utilityProcess
  } catch {
    try {
      process.send(msg) // node:test 经 child_process.fork 驱动（见 tests/unit）
    } catch {
      /* 主进程不在了 */
    }
  }
}

// HTML 转义：服务名 / next 都会被拼进登录页，不转义就是注入点
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const BASIC_EXPECTED = 'Basic ' + Buffer.from(`${AUTH_USER}:${PIN}`).toString('base64')

function secureEqual(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function validBasic(req) {
  const h = req.headers['authorization']
  if (!h || !h.startsWith('Basic ')) return false
  return secureEqual(h, BASIC_EXPECTED)
}

function cookieToken(req) {
  const cookie = req.headers['cookie'] || ''
  const part = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE_NAME + '='))
  return part ? part.slice(COOKIE_NAME.length + 1) : null
}

function validCookie(req) {
  const t = cookieToken(req)
  if (!t) return false
  const exp = sessions.get(t)
  if (!exp) return false
  if (Date.now() > exp) {
    sessions.delete(t)
    return false
  }
  return true
}

function newSession() {
  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, Date.now() + SESSION_TTL_MS)
  return token
}

// ---- 按 IP 限速（只对“口令错误的失败”计数，成功即清零） ----
// 真实客户端 IP：gateway 只监听 127.0.0.1，所有公网流量的 socket 对端都是本机
// cloudflared——直接用 socket 地址会把全部访客算成同一个 IP（一错全封）。
// cf-connecting-ip 由 Cloudflare 边缘强制覆写，隧道路径上不可伪造。
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }
  return req.socket.remoteAddress || '?' // 本地直连调试
}
function isBlocked(ip) {
  const r = fails.get(ip)
  return !!r && r.blockedUntil > Date.now()
}
function recordFail(ip) {
  const now = Date.now()
  const r = fails.get(ip) || { times: [], blockedUntil: 0 }
  r.times = r.times.filter((t) => now - t < FAIL_WINDOW_MS)
  r.times.push(now)
  if (r.times.length >= FAIL_MAX) {
    r.blockedUntil = now + BLOCK_MS
    r.times = []
    post({ type: 'log', level: 'warn', message: `IP ${ip} 连续口令错误 ${FAIL_MAX} 次，封锁 ${BLOCK_MS / 1000}s` })
  }
  fails.set(ip, r)
}

function loginPage(next, error) {
  const err = error ? `<div class="err">PIN 或口令错误，请重试</div>` : ''
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'">
<title>TunnelDock · ${esc(SERVICE_NAME)}</title><style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:34px 30px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
h1{font-size:17px;margin:0 0 4px;font-weight:600}.sub{color:#94a3b8;font-size:13px;margin:0 0 22px}
label{display:block;font-size:13px;color:#c3c9d4;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2b3340;background:#0f1319;color:#eef1f5;font-size:15px;letter-spacing:2px}
input:focus{outline:none;border-color:#3b82f6}
button{width:100%;margin-top:20px;padding:11px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{background:#2a1517;border:1px solid #5b2328;color:#ff9aa0;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:6px}
.brand{margin-top:18px;text-align:center;color:#475569;font-size:11px}
</style></head><body>
<form class="card" method="POST" action="${LOGIN_PATH}">
<h1>⚓ ${esc(SERVICE_NAME)}</h1><p class="sub">TunnelDock 保护的服务 · 请输入 PIN 访问</p>${err}
<label for="p">PIN（8 位数字）</label><input id="p" name="pin" type="password" inputmode="numeric" autocomplete="off" required autofocus>
<input type="hidden" name="next" value="${esc(safeNext)}">
<button type="submit">进 入</button>
<div class="brand">powered by TunnelDock</div>
</form></body></html>`
}

function setAuthCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    // Secure：隧道恒为 HTTPS，会话 Cookie 不应经 http 明文外泄
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  )
}

function proxyReq(req, res) {
  const headers = Object.assign({}, req.headers, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers['host'] || ''
  })
  headers['host'] = UPSTREAM_HOST // 通用服务按目标地址重写 Host
  // 剥掉浏览器来源头：隧道域名与重写后的 Host 不同源，
  // 像 pi-web / DSH 这类带 Host/Origin 围栏的服务会把 /api 全部 403。
  // 信任边界由本代理的 PIN 承担，上游不再需要这些头做 CSRF 判断。
  delete headers['authorization']
  delete headers['origin']
  delete headers['referer']
  delete headers['sec-fetch-site']
  const options = { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers, agent: false } // agent:false —— 不复用上游连接，避免客户端断开后第一个请求撞上半死 socket
  const proxy = http.request(options, (pres) => {
    // 服务令牌引导：上游对根路径回 401 且请求未带 token 参数时，
    // 从令牌源文件取最新 token 重定向一次（带上 token 后上游会下发会话 Cookie）。
    // 只在无 token 参数时重定向 → 天然防循环（令牌失效则透传 401）。
    if (TOKEN_SOURCE_FILE && pres.statusCode === 401 && req.method === 'GET') {
      const u = new URL(req.url || '/', 'http://x')
      const isRoot = u.pathname === '/' || u.pathname === '/index.html'
      if (isRoot && !u.searchParams.has('token')) {
        try {
          const text = fs.readFileSync(TOKEN_SOURCE_FILE, 'utf8')
          const found = text.match(/token=([A-Za-z0-9_-]+)/g)
          if (found && found.length > 0) {
            const tok = found[found.length - 1].slice(6)
            post({ type: 'log', level: 'info', message: '上游 401 → 注入服务令牌引导' })
            pres.resume() // 丢弃上游响应体
            res.writeHead(303, { Location: '/?token=' + encodeURIComponent(tok), 'Cache-Control': 'no-store' })
            res.end()
            return
          }
        } catch {
          /* 令牌文件读失败 → 按原样透传 401 */
        }
      }
    }
    res.writeHead(pres.statusCode, pres.headers)
    pres.pipe(res)
    // 双向流错误兜底：客户端中途断开（关页面/换网络/SSE 被杀）会触发
    // res/pres 的 error/aborted —— 不处理会让未捕获错误击穿整个进程
    pres.on('error', () => proxy.destroy())
    res.on('error', () => {
      pres.destroy()
      proxy.destroy()
    })
    res.on('close', () => {
      if (!pres.complete) pres.destroy()
    })
  })
  proxy.on('error', (e) => {
    post({ type: 'log', level: 'error', message: `上游连接失败: ${e.message}` })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad Gateway: 目标服务不可达（' + SERVICE_NAME + '）')
  })
  req.on('error', () => proxy.destroy())
  req.pipe(proxy)
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req)
  if (validCookie(req) || validBasic(req)) {
    if (validBasic(req) && !cookieToken(req)) setAuthCookie(res, newSession())
    fails.delete(ip)
    proxyReq(req, res)
    return
  }
  if (isBlocked(ip)) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' })
    res.end('Too Many Requests')
    return
  }

  const u = new URL(req.url || '/', 'http://x')

  if (req.method === 'POST' && u.pathname === LOGIN_PATH) {
    // 登录表单体积极小；上限兜底防未认证的大包内存耗尽（body 无上限地 += 是 DoS 面）
    let body = ''
    let oversized = false
    req.on('data', (c) => {
      if (oversized) return
      body += c
      if (body.length > 8192) {
        oversized = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (oversized) return
      const p = new URLSearchParams(body)
      const pin = p.get('pin') || ''
      const next = p.get('next') || '/'
      if (secureEqual(pin, PIN)) {
        setAuthCookie(res, newSession())
        const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/'
        res.writeHead(303, { Location: safeNext })
        res.end()
        post({ type: 'log', level: 'info', message: `IP ${ip} 通过 PIN 登录` })
      } else {
        recordFail(ip)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPage(next, true))
      }
    })
    return
  }

  if (u.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(loginPage(u.pathname, false))
})

// WebSocket / upgrade 透传（浏览器随握手带会话 Cookie；未认证直接 401）
server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(req)
  if (!(validCookie(req) || validBasic(req))) {
    if (isBlocked(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
    } else {
      recordFail(ip) // 未认证的 WS 尝试也计入限速
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    }
    socket.destroy()
    return
  }
  let requestHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const name = k.toLowerCase()
    if (name === 'host') {
      requestHead += `host: ${UPSTREAM_HOST}\r\n`
      continue
    }
    // 与普通请求一致：上游不接收浏览器来源头（见 proxyReq 注释）
    if (name === 'origin' || name === 'referer' || name === 'sec-fetch-site') continue
    if (Array.isArray(v)) v.forEach((x) => (requestHead += `${k}: ${x}\r\n`))
    else requestHead += `${k}: ${v}\r\n`
  }
  requestHead += '\r\n'
  const client = net.connect(TARGET_PORT, TARGET_HOST, () => {
    client.write(requestHead)
    if (head && head.length) client.write(head)
    socket.pipe(client).pipe(socket)
  })
  client.on('error', () => socket.destroy())
  socket.on('error', () => client.destroy())
})

server.on('error', (e) => post({ type: 'fatal', message: e.message }))

// 会话与限速记录的周期清扫：过期 token / 消失 IP 的失败记录不常驻内存
setInterval(() => {
  const now = Date.now()
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t)
  for (const [ip, r] of fails) {
    if (r.blockedUntil < now && r.times.every((t) => now - t >= FAIL_WINDOW_MS)) fails.delete(ip)
  }
}, 10 * 60 * 1000).unref()

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  post({ type: 'listening', port: server.address().port })
  post({ type: 'log', level: 'info', message: `gateway 就绪: ${LISTEN_HOST}:${server.address().port} -> ${UPSTREAM_HOST}` })
})
