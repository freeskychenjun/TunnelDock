// proxy.cjs（PIN 墙网关）单测：经 child_process.fork 真实拉起（post() 带 fork 回退），
// 对着本地 http+ws 上游打真实请求，覆盖登录墙 / XSS 转义 / 限速 / Cookie / 透传 / WS。
// e2e 结构性测不出“按 IP”行为（公网流量全来自同一个 cloudflared socket），这里用
// 伪造 cf-connecting-ip 头补上这个盲区。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket as WsClient, WebSocketServer } from 'ws'

const PROXY_CJS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'gateway', 'proxy.cjs')
const PIN = '12345678'
const XSS_NAME = '<img src=x onerror=alert(1)>'

let proxy: ChildProcess
let proxyPort = 0
let upstreamPort = 0
const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('UPSTREAM:' + (req.url || '/'))
})
const wss = new WebSocketServer({ server: upstream, path: '/ws' })
wss.on('connection', (socket) => socket.on('message', (m) => socket.send('echo:' + m.toString())))

before(async () => {
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  upstreamPort = (upstream.address() as { port: number }).port

  proxy = fork(PROXY_CJS, [
    JSON.stringify({ listenPort: 0, targetHost: '127.0.0.1', targetPort: upstreamPort, pin: PIN, serviceName: XSS_NAME })
  ])
  proxy.stderr?.on('data', (d) => process.stderr.write(`[proxy] ${d}`))
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const [msg] = (await Promise.race([once(proxy, 'message'), new Promise((r) => setTimeout(() => r([null]), 500))])) as [
      { type?: string; port?: number } | null
    ]
    if (msg && msg.type === 'listening' && msg.port) {
      proxyPort = msg.port
      return
    }
  }
  throw new Error('proxy 10 秒内未上报 listening')
})

after(() => {
  proxy.kill()
  wss.close()
  upstream.close()
})

const base = (): string => `http://127.0.0.1:${proxyPort}`

test('未认证访问 → 登录页（不到上游）', async () => {
  const res = await fetch(base() + '/some/page', { redirect: 'manual' })
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.ok(body.includes('TunnelDock 保护的服务'))
  assert.ok(!body.includes('UPSTREAM:'))
})

test('XSS：服务名被转义（不出现原始 <img）', async () => {
  const res = await fetch(base() + '/')
  const body = await res.text()
  assert.ok(body.includes('&lt;img'), '应出现转义后的服务名')
  assert.ok(!body.includes('<img'), '原始 <img 不得出现')
  assert.ok(body.includes('Content-Security-Policy'), '登录页应带 CSP')
})

test('XSS：POST next 属性逃逸被转义', async () => {
  const res = await fetch(base() + '/_td_auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'pin=00000000&next=/' + encodeURIComponent('" autofocus onfocus=alert(2) x="')
  })
  const body = await res.text()
  assert.ok(body.includes('PIN 或口令错误'), '错误 PIN 应回登录页')
  assert.ok(body.includes('&quot; autofocus'), 'next 中的引号必须转义')
  assert.ok(!body.includes('" autofocus onfocus'), '不得出现原始属性逃逸序列')
})

test('正确 PIN → 303 + Secure/HttpOnly 会话 Cookie', async () => {
  const res = await fetch(base() + '/_td_auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `pin=${PIN}&next=%2F`,
    redirect: 'manual'
  })
  assert.equal(res.status, 303)
  const cookie = res.headers.get('set-cookie') || ''
  assert.ok(cookie.includes('td_auth='), '应下发会话 Cookie')
  assert.ok(cookie.includes('HttpOnly'))
  assert.ok(cookie.includes('Secure'), '会话 Cookie 必须带 Secure')
})

test('带会话 Cookie → 透传到上游', async () => {
  const login = await fetch(base() + '/_td_auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `pin=${PIN}&next=%2F`,
    redirect: 'manual'
  })
  const token = (login.headers.get('set-cookie') || '').match(/td_auth=([^;]+)/)?.[1]
  assert.ok(token, '应能取到会话 token')
  const res = await fetch(base() + '/real/page', { headers: { cookie: `td_auth=${token}` } })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'UPSTREAM:/real/page')
})

test('Basic 认证（tunneldock:PIN）→ 透传到上游', async () => {
  const auth = Buffer.from(`tunneldock:${PIN}`).toString('base64')
  const res = await fetch(base() + '/', { headers: { authorization: `Basic ${auth}` } })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'UPSTREAM:/')
})

test('限速按真实客户端 IP：A 被封不牵连 B（回归：此前全站共用 127.0.0.1 一个桶）', async () => {
  const A = { 'cf-connecting-ip': '203.0.113.1' }
  const B = { 'cf-connecting-ip': '203.0.113.2' }
  for (let i = 0; i < 5; i++) {
    const res = await fetch(base() + '/_td_auth', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...A },
      body: 'pin=00000000&next=%2F'
    })
    assert.equal(res.status, 200) // 错误 PIN 返回登录页（200）
  }
  const blocked = await fetch(base() + '/', { headers: A })
  assert.equal(blocked.status, 429, 'A 第 6 次应被 429 封锁')
  const other = await fetch(base() + '/', { headers: B })
  assert.equal(other.status, 200, 'B 不应受 A 牵连')
})

test('登录 POST 体超 8KB → 连接被断（未认证内存 DoS 防护）', async () => {
  await assert.rejects(
    fetch(base() + '/_td_auth', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'pin=' + 'x'.repeat(9 * 1024)
    })
  )
})

test('WebSocket：带会话 Cookie 升级 → 101 并回声', async () => {
  const login = await fetch(base() + '/_td_auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `pin=${PIN}&next=%2F`,
    redirect: 'manual'
  })
  const token = (login.headers.get('set-cookie') || '').match(/td_auth=([^;]+)/)?.[1]
  assert.ok(token)
  const socket = new WsClient(`ws://127.0.0.1:${proxyPort}/ws`, { headers: { cookie: `td_auth=${token}` } })
  const got = new Promise<string>((resolve, reject) => {
    socket.on('open', () => socket.send('ping-from-test'))
    socket.on('message', (m) => resolve(m.toString()))
    socket.on('error', reject)
    setTimeout(() => reject(new Error('WS 5 秒无回声')), 5000)
  })
  assert.equal(await got, 'echo:ping-from-test')
  socket.close()
})

test('WebSocket：未认证升级 → 401', async () => {
  const socket = new WsClient(`ws://127.0.0.1:${proxyPort}/ws`)
  const code = await new Promise<number>((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    socket.on('open', () => resolve(101))
    socket.on('error', () => resolve(-1))
    setTimeout(() => resolve(-2), 5000)
  })
  assert.equal(code, 401)
})
