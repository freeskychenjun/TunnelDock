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

// ── 发送队列：控制帧优先车道 + 数据车道（对应 agent.py 的 send_lock，但分车道）──
// 单条 WSS 复用多请求时，若所有帧共用一条 FIFO，大文件的 chunk 会把后续请求的
// res-start 挤到 20s 之后（Worker pending 超时 → 504，浏览器并行加载页面全灭——
// 2026-10-15 实测 8 并发请求全部 21s 504、串行全部 1.5s 正常）。控制帧
// （res-start/end/error/ws-close）走优先车道尽快发出；chunk/ws-data 走数据车道
// 按序排队；end/error/ws-close 排在自己请求的 chunk 之后入优先车道，
// 单请求内的帧顺序语义不变，跨请求不再互相阻塞。
let dataChain = Promise.resolve()
let ctrlChain = Promise.resolve()
// 当前存活的 DO 连接 + 最近数据活动时刻。断链时在途帧会经 liveWs 短暂等待重连，
// 但**不做跨连接的流续传**：断链瞬间滞留在网络中的字节已丢失，续传会产出
// "带洞但看起来完整"的响应（比失败更糟）。真正的完整性由"断链即中止在途流、
// 让客户端明确失败并重试"保证（见 connectOnceWrapped 的 close 处理与 DO 侧 abort）。
let liveWs = null
let lastIoAt = 0 // 本连接最近一次非心跳收/发（数据活动证据，心跳判死用）
const activeReqs = new Set() // 在途 HTTP 请求（断链时全部中止）
function sendRaw(_ws, data) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const trySend = () => {
      if (liveWs) {
        try {
          liveWs.send(data, () => { lastIoAt = Date.now(); resolve() })
        } catch { resolve() }
      } else if (Date.now() - startedAt < 8000) {
        setTimeout(trySend, 500) // 无活连接（僵死判停/重连中）：短暂等待
      } else {
        resolve() // 8s 仍无连接：放弃本帧（在途流已随断链中止）
      }
    }
    trySend()
  })
}
function sendCtrl(ws, obj) {
  ctrlChain = ctrlChain.then(() => sendRaw(ws, JSON.stringify(obj)))
  return ctrlChain
}
function sendData(ws, obj) {
  dataChain = dataChain.then(() => sendRaw(ws, JSON.stringify(obj)))
  return dataChain
}
/** 在数据车道当前尾部之后执行（end/error 排到自己 chunk 的后面） */
function afterData(fn) {
  dataChain = dataChain.then(fn)
  return dataChain
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

  // 在途登记：任何 ws 断链时统一中止（见 close 处理），保证不产出带洞的流
  const entry = { req: null, res: null, done: false }
  activeReqs.add(entry)
  const finish = () => { entry.done = true; activeReqs.delete(entry) }

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
      entry.res = res
      // 响应已开始：撤销 20s 空闲超时——SSE/流式响应允许长时间静默
      // （DSH 的 /plugins/events 实测连上 21s 即被掐，应用侧表现为"连接超时"；
      //   首字节仍受 20s 保护，这里只放宽已开始响应的流，留 10 分钟兜底防僵死泄漏）
      req.setTimeout(600000)
      // 令牌引导: 根路径 401 且未带 token → 303 到带 token 的地址（只引导一次）
      if (res.statusCode === 401 && tokenFile && !/[?&]token=/.test(reqPath)) {
        const token = latestToken()
        if (token) {
          res.resume() // 弃掉响应体
          finish()
          const sep = reqPath.includes('?') ? '&' : '?'
          void sendCtrl(ws, {
            type: 'res-start', id: reqId, status: 303,
            headers: { Location: `${reqPath}${sep}token=${token}` }
          }).then(() => sendCtrl(ws, { type: 'end', id: reqId }))
          log(`${method} ${reqPath.slice(0, 60)} → 303 (token 引导)`)
          return
        }
      }

      const respHeaders = {}
      for (const [k, v] of Object.entries(res.headers)) {
        respHeaders[k] = Array.isArray(v) && k !== 'set-cookie' ? v.join(', ') : v
      }
      void sendCtrl(ws, { type: 'res-start', id: reqId, status: res.statusCode || 502, headers: respHeaders })

      // 流式转发为 chunk 帧（node http 模块已解好 chunked，直接流式切片）
      res.on('data', (buf) => {
        for (let i = 0; i < buf.length; i += CHUNK) {
          void sendData(ws, { type: 'chunk', id: reqId, data: buf.subarray(i, i + CHUNK).toString('base64') })
        }
      })
      res.on('end', () => {
        void afterData(() => sendCtrl(ws, { type: 'end', id: reqId }))
        log(`${method} ${reqPath.slice(0, 60)} → ${res.statusCode}`)
        finish()
      })
      res.on('error', (e) => {
        void afterData(() =>
          sendCtrl(ws, { type: 'error', id: reqId, message: String(e.message).slice(0, 200) }))
        finish()
      })
    }
  )
  entry.req = req
  req.on('timeout', () => {
    req.destroy(new Error('本地服务响应超时'))
  })
  req.on('error', (e) => {
    void sendCtrl(ws, { type: 'error', id: reqId, message: String(e.message).slice(0, 200) })
    log(`请求失败 ${reqPath.slice(0, 60)}: ${e.message}`, 'warn')
    finish()
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
    void sendData(ws, {
      type: 'ws-data', id: cid, bin: isBinary,
      data: isBinary ? Buffer.from(data).toString('base64') : data.toString('utf8')
    })
  })
  const closed = () => {
    wsConns.delete(cid)
    void afterData(() => sendCtrl(ws, { type: 'ws-close', id: cid }))
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
//
// 心跳：建连后每 5s 重发一次 hello（DO 对任何时刻的 hello 都回 ack——老版本
// Worker 也认，无版本耦合）。半开连接不会触发 close 事件，2026-10 的封锁事件
// 实测会这样僵死；判死门槛 = 无 ack **且无数据活动**（见 beat() 内注释）。
// 密集心跳兼作 keepalive（实测空闲链路比高频流量链路更容易被中间设备静默掐死）。
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
    let hbTimer = null
    let hbWait = null
    const stopHeartbeat = () => {
      if (hbTimer) clearInterval(hbTimer)
      if (hbWait) clearTimeout(hbWait)
      hbTimer = null
      hbWait = null
    }
    const beat = () => {
      if (hbWait) return // 上一拍还没回 ack，等它的 deadline
      hbWait = setTimeout(() => {
        hbWait = null
        // 判死门槛：既要没 ack，也要**没有数据活动**。大传输时 DO 忙于写流
        // （背压）会延迟 hello-ack，只看 ack 就会把正在传输的健康连接误杀——
        // 断链瞬间在途字节丢失，续传产出带洞响应，这正是大文件随机截断的推手。
        // 有数据流动 = 连接活着；只有"没 ack 且静默"才是真僵死。
        if (Date.now() - lastIoAt < 5000) return // 有活动：本拍豁免，下拍再看
        if (liveWs === ws) liveWs = null // 判死即停发，等新连接
        log('心跳 5s 无 ack 且无数据活动，判定连接僵死，重建', 'warn')
        try { ws.terminate() } catch { /* close 兜住 */ }
      }, 5000)
      try { ws.send(JSON.stringify({ type: 'hello' })) } catch { /* close 兜住 */ }
    }
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
      lastIoAt = Date.now() // 任何下行帧（ack/req/ws-*）都是链路活着的证据
      let frame
      try {
        frame = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (frame.type === 'hello-ack') {
        if (hbWait) {
          clearTimeout(hbWait)
          hbWait = null
        }
        if (!acked) {
          acked = true
          if (ackTimer) clearTimeout(ackTimer)
          wsConns.clear()
          liveWs = ws // 供 sendRaw 续传：本连接存活期间所有响应帧经它发送
          parentPort.postMessage({ type: 'ready' })
          log(`已连接 (https://${hostname}${edgeIp ? ' via ' + edgeIp : ''})`)
          hbTimer = setInterval(beat, 5000)
        }
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
      stopHeartbeat()
      if (liveWs === ws) liveWs = null
      // 断链即中止全部在途请求：断链瞬间滞留在网络中的字节已丢失，无法无损续传；
      // 中止让浏览器拿到明确失败（DO 侧同步 abort 对应流），重试即可——
      // 绝不让"带洞的 200"流到客户端（那会执行损坏的 JS，比失败更糟）
      for (const e of activeReqs) {
        if (e.done) continue
        e.done = true
        try { if (e.res) e.res.destroy(new Error('隧道断开')) } catch { /* 已关 */ }
        try { if (e.req) e.req.destroy(new Error('隧道断开')) } catch { /* 已关 */ }
      }
      activeReqs.clear()
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
  // 边缘候选轮换指针：某条路径反复僵死（10/15 晚实测 162.159.136.4 被间歇掐）
  // 时，重连优先试下一条，避免在同一条病态路径上反复横跳
  let rotation = 0
  while (!stopped) {
    const edgeFallback = Array.isArray(edgeIps) ? [...edgeIps] : []
    if (edgeFallback.length > 0) {
      rotation = (rotation + 1) % edgeFallback.length
      edgeFallback.push(...edgeFallback.splice(0, rotation))
    }
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
