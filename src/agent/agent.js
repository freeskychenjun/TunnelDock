/**
 * TunnelDock RT agent — 本机反向隧道客户端（utilityProcess）
 *
 * 架构: 手机 → <hostname>(Worker+DO) ⇄ wss(443) ⇄ 本进程 → 127.0.0.1:目标端口
 * 移植自自研 cf-worker-tunnel/agent/agent.py（Node 版，供 Electron 内嵌）。
 *
 * 通道（与 Worker/DO 的控制帧协议一一对应）:
 *   下行: req / ws-open / ws-data / ws-close
 *   上行: res-start / chunk / end / error / ws-data / ws-close
 *
 * 启动: utilityProcess.fork(agent.js, [JSON.stringify(cfg)])
 *   cfg = { hostname, agentSecret, targetHost, targetPort, tokenFile?, edgeIps? }
 * 上报: parentPort.postMessage({type:'ready'|'log'|'offline', ...})
 *
 * 国内网络适配:
 *  - 只向 443 拨 wss，不碰被 DPI 封的 7844
 *  - edgeIps 非空时用「TCP 连边缘 IP + SNI/Host 归域名」的进程内钉 IP（无需改 hosts）
 * 独立运行支持（非 utilityProcess，如手工测试）: postMessage 退化为 stdout JSON 行
 */
import WebSocket from 'ws'
import http from 'node:http'
import fs from 'node:fs'

const CHUNK = 32768

const parentPort = process.parentPort || { postMessage() {} }
if (!process.parentPort) {
  parentPort.postMessage = (m) => {
    try { console.log(JSON.stringify(m)) } catch { /* noop */ }
  }
}

let cfg = null
try {
  cfg = JSON.parse(process.argv[process.argv.length - 1])
} catch (e) {
  parentPort.postMessage({ type: 'fatal', message: '配置解析失败: ' + e.message })
  throw e
}

const { hostname, agentSecret, targetHost, targetPort, tokenFile, edgeIps } = cfg

function log(msg, level = 'info') {
  try {
    parentPort.postMessage({ type: 'log', level, message: String(msg).slice(0, 500) })
  } catch {
    /* 主进程已退出 */
  }
}

// ── 令牌引导（同 proxy.cjs / agent.py 策略）──
let tokenCache = { mtimeMs: 0, size: 0, token: '' }

function latestToken() {
  if (!tokenFile) return ''
  try {
    const st = fs.statSync(tokenFile)
    if (tokenCache.token && st.mtimeMs === tokenCache.mtimeMs && st.size === tokenCache.size) {
      return tokenCache.token
    }
    const fd = fs.openSync(tokenFile, 'r')
    const tailLen = Math.min(st.size, 512 * 1024)
    const buf = Buffer.alloc(tailLen)
    fs.readSync(fd, buf, 0, tailLen, st.size - tailLen)
    fs.closeSync(fd)
    const m = [...buf.toString('utf8').matchAll(/token=([A-Za-z0-9_\-]+)/g)]
    if (m.length > 0) {
      tokenCache = { mtimeMs: st.mtimeMs, size: st.size, token: m[m.length - 1][1] }
      return tokenCache.token
    }
  } catch (e) {
    log(`读 tokenFile 失败: ${e.message}`, 'warn')
  }
  return ''
}

// ── 发送队列：控制帧串行化（对应 agent.py 的 send_lock）──
let sendChain = Promise.resolve()
function sendJson(ws, obj) {
  const data = JSON.stringify(obj)
  sendChain = sendChain.then(
    () =>
      new Promise((resolve) => {
        try {
          ws.send(data, () => resolve())
        } catch {
          resolve()
        }
      })
  )
  return sendChain
}

// ── HTTP 请求转发 ──
const STRIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'accept-encoding', 'origin'
])

function handleRequest(ws, frame) {
  const reqId = frame.id
  const method = frame.method || 'GET'
  const reqPath = frame.path || '/'
  const headers = frame.headers || {}
  const body = frame.body ? Buffer.from(frame.body, 'base64') : Buffer.alloc(0)

  const outHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (STRIP_HEADERS.has(k.toLowerCase())) continue
    outHeaders[k] = v
  }
  outHeaders['Content-Length'] = String(body.length)
  outHeaders.Connection = 'close'

  const req = http.request(
    {
      host: targetHost,
      port: targetPort,
      method,
      path: reqPath,
      headers: outHeaders,
      timeout: 20000
    },
    (res) => {
      // 令牌引导: 根路径 401 且未带 token → 303 到带 token 的地址（只引导一次）
      if (res.statusCode === 401 && tokenFile && !/[?&]token=/.test(reqPath)) {
        const token = latestToken()
        if (token) {
          res.resume() // 弃掉响应体
          const sep = reqPath.includes('?') ? '&' : '?'
          void sendJson(ws, {
            type: 'res-start', id: reqId, status: 303,
            headers: { Location: `${reqPath}${sep}token=${token}` }
          }).then(() => sendJson(ws, { type: 'end', id: reqId }))
          log(`${method} ${reqPath.slice(0, 60)} → 303 (token 引导)`)
          return
        }
      }

      const respHeaders = {}
      for (const [k, v] of Object.entries(res.headers)) {
        respHeaders[k] = Array.isArray(v) && k !== 'set-cookie' ? v.join(', ') : v
      }
      void sendJson(ws, { type: 'res-start', id: reqId, status: res.statusCode || 502, headers: respHeaders })

      // 流式转发为 chunk 帧（node http 模块已解好 chunked，直接流式切片）
      res.on('data', (buf) => {
        for (let i = 0; i < buf.length; i += CHUNK) {
          void sendJson(ws, { type: 'chunk', id: reqId, data: buf.subarray(i, i + CHUNK).toString('base64') })
        }
      })
      res.on('end', () => {
        void sendJson(ws, { type: 'end', id: reqId })
        log(`${method} ${reqPath.slice(0, 60)} → ${res.statusCode}`)
      })
      res.on('error', (e) => {
        void sendJson(ws, { type: 'error', id: reqId, message: String(e.message).slice(0, 200) })
      })
    }
  )
  req.on('timeout', () => {
    req.destroy(new Error('本地服务响应超时'))
  })
  req.on('error', (e) => {
    void sendJson(ws, { type: 'error', id: reqId, message: String(e.message).slice(0, 200) })
    log(`请求失败 ${reqPath.slice(0, 60)}: ${e.message}`, 'warn')
  })
  req.end(body)
}

// ── 浏览器 WS 中转: connId → 本地 ws 客户端（未连上先缓冲）──
const wsConns = new Map()

function dialLocalWs(ws, cid, frame) {
  const wsPath = frame.path || '/'
  const hs = frame.headers || {}
  const extra = {}
  if (hs.cookie) extra.Cookie = hs.cookie
  // 注意: 不转发 Origin——带白名单围栏的服务只信任回环/局域网（同 auth-proxy.js 配方）
  const subproto = (hs['sec-websocket-protocol'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (subproto.length > 0) extra['Sec-WebSocket-Protocol'] = subproto.join(', ')

  const local = new WebSocket(`ws://${targetHost}:${targetPort}${wsPath}`, {
    headers: extra,
    handshakeTimeout: 10000,
    perMessageDeflate: false,
    maxPayload: 8 * 1024 * 1024
  })

  const conn = wsConns.get(cid)
  if (!conn) {
    // 浏览器侧已断
    local.on('open', () => local.close())
    return
  }
  conn.ws = local

  local.on('open', () => {
    for (const item of conn.buf) {
      try { local.send(item) } catch { /* 忽略 */ }
    }
    conn.buf = []
    log(`中转建立 ${wsPath.slice(0, 60)}`)
  })
  local.on('message', (data, isBinary) => {
    void sendJson(ws, {
      type: 'ws-data', id: cid, bin: isBinary,
      data: isBinary ? Buffer.from(data).toString('base64') : data.toString('utf8')
    })
  })
  const closed = () => {
    wsConns.delete(cid)
    void sendJson(ws, { type: 'ws-close', id: cid })
    try { local.close() } catch { /* 已关 */ }
    log(`中转结束 ${wsPath.slice(0, 60)}`)
  }
  local.on('close', closed)
  local.on('error', (e) => {
    log(`本地 WS 失败 ${wsPath.slice(0, 60)}: ${e.message}`, 'warn')
    closed()
  })
}

function handleWsFrame(ws, frame) {
  const cid = frame.id
  if (frame.type === 'ws-open') {
    wsConns.set(cid, { ws: null, buf: [] })
    dialLocalWs(ws, cid, frame)
  } else if (frame.type === 'ws-data') {
    const conn = wsConns.get(cid)
    if (!conn) return
    const data = frame.bin ? Buffer.from(frame.data, 'base64') : String(frame.data)
    if (conn.ws === null) conn.buf.push(data)
    else {
      try { conn.ws.send(data) } catch { /* 忽略 */ }
    }
  } else if (frame.type === 'ws-close') {
    const conn = wsConns.delete(cid)
    if (conn && conn.ws) {
      try { conn.ws.close() } catch { /* 已关 */ }
    }
  }
}

// ── 主连接（wss 直连 443；连接打开后挂起至关闭，等价 python 的 async with）──
// 打开后必须先过 hello/hello-ack 全双工体检（3s 内 DO 回不了 ack = 半瘫边缘，
// 只会下行通上行丢，浏览器 WS 中转也会楔死）→ 立刻断开换下一个候选
function connectOnceWrapped(edgeIp) {
  return new Promise((resolve, reject) => {
    const url = `wss://${hostname}/__agent?secret=${encodeURIComponent(agentSecret)}`
    const opts = {
      handshakeTimeout: 15000,
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024
    }
    if (edgeIp) {
      // 进程内钉 IP: TCP 连 edgeIp，SNI/Host 仍是 hostname
      opts.host = edgeIp
      opts.servername = hostname
      opts.headers = { Host: hostname }
    }
    const ws = new WebSocket(url, opts)
    let opened = false
    let acked = false
    let ackTimer = null
    ws.on('open', () => {
      opened = true
      try { ws.send(JSON.stringify({ type: 'hello' })) } catch { /* close 会兜住 */ }
      ackTimer = setTimeout(() => {
        if (!acked) {
          log(`边缘${edgeIp || '(默认解析)'} 上行不通（hello 无 ack），换节点`, 'warn')
          try { ws.terminate() } catch { /* 已关 */ }
        }
      }, 3000)
    })
    ws.on('message', (raw) => {
      if (!acked) {
        try {
          const probe = JSON.parse(raw.toString('utf8'))
          if (probe.type === 'hello-ack') {
            acked = true
            if (ackTimer) clearTimeout(ackTimer)
            wsConns.clear()
            parentPort.postMessage({ type: 'ready' })
            log(`已连接 (https://${hostname}${edgeIp ? ' via ' + edgeIp : ''})`)
            return
          }
        } catch {
          /* 非 JSON：交给业务逻辑 */
        }
      }
      let frame
      try {
        frame = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (frame.type === 'req') handleRequest(ws, frame)
      else if (frame.type === 'ws-open' || frame.type === 'ws-data' || frame.type === 'ws-close') {
        handleWsFrame(ws, frame)
      }
    })
    ws.on('error', (e) => {
      if (!acked) reject(e)
    })
    ws.on('close', () => {
      if (ackTimer) clearTimeout(ackTimer)
      parentPort.postMessage({ type: 'offline' })
      for (const [, conn] of wsConns) {
        try { if (conn.ws) conn.ws.close() } catch { /* 已关 */ }
      }
      wsConns.clear()
      if (acked) resolve()
      else reject(new Error(opened ? '边缘半瘫（上行不通）或连接未建立即关闭' : '连接未建立即关闭'))
    })
  })
}

let backoff = 2000
let stopped = false

async function run() {
  log(`agent 启动: ${hostname} → ${targetHost}:${targetPort}`)
  while (!stopped) {
    const edgeFallback = Array.isArray(edgeIps) ? [...edgeIps] : []
    let ok = false
    let lastErr = null
    // 实测教训（M2b）：默认 DNS 解析到的边缘节点会出现「下行通、上行丢」的半瘫，
    // 已验证可达的钉 IP 必须排在默认解析前面；默认解析只作最后兜底
    for (const ip of [...edgeFallback, null]) {
      try {
        await connectOnceWrapped(ip)
        ok = true
        break
      } catch (e) {
        lastErr = e
      }
    }
    if (ok) backoff = 2000
    else log(`连接失败: ${lastErr ? lastErr.message : '未知'}，${Math.round(backoff / 1000)}s 后重试`, 'warn')
    await new Promise((r) => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 30000)
  }
}

void run()
