/**
 * e2e-rt — 反向隧道（wss RT）全链路自动化测试
 *
 * 前置（Token 不入库，全部走环境变量；缺任一则跳过并提示）：
 *   RT_E2E_TOKEN      CF API Token（Workers Scripts Edit + DNS Edit + Routes Edit）
 *   RT_E2E_ACCOUNT_ID 账号 id
 *   RT_E2E_ZONE_ID    zone id
 *   RT_E2E_HOST       专用测试子域名（如 e2e-rt.example.com；DNS 记录会自动建/清）
 * 可选：
 *   RT_E2E_PACKAGED=1  测安装版（release/win-unpacked/TunnelDock.exe）而非开发版 electron
 *
 * 步骤：部署 Worker+DNS+路由 → 起 demo(4591 HTTP/SSE/WS) → 独立 userData 启动应用 →
 *       等 agent ready → 验证 登录/取页/SSE/WS/错误 PIN 限速 429 → 清场
 * 用法：node scripts/e2e-rt.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import https from 'node:https'
import WebSocket from 'ws'

const TOKEN = process.env.RT_E2E_TOKEN || ''           // Workers Scripts/Routes 权限
const DNS_TOKEN = process.env.RT_E2E_DNS_TOKEN || TOKEN // DNS Edit 权限（cloudflared login 签发的 token 带此权限）
const ACCOUNT = process.env.RT_E2E_ACCOUNT_ID || ''
const ZONE = process.env.RT_E2E_ZONE_ID || ''
const HOST = process.env.RT_E2E_HOST || ''
const PACKAGED = process.env.RT_E2E_PACKAGED === '1'
const PIN = 'e2epin01'
const PIN_BAD = '000000'
const PORT = 4591

if (!TOKEN || !ACCOUNT || !ZONE || !HOST) {
  console.log('E2E_RT_SKIP=缺少 RT_E2E_TOKEN/RT_E2E_ACCOUNT_ID/RT_E2E_ZONE_ID/RT_E2E_HOST 环境变量')
  process.exit(0)
}

const API = 'https://api.cloudflare.com/client/v4'
let failed = 0
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

async function cf(path, init = {}) {
  const resp = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) }
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok || json?.success === false) {
    throw new Error(`${path} → ${resp.status}: ${JSON.stringify(json?.errors || json).slice(0, 300)}`)
  }
  return json?.result
}

async function cfDns(path, init = {}) {
  const resp = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${DNS_TOKEN}`, ...(init.headers || {}) }
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok || json?.success === false) {
    throw new Error(`${path} → ${resp.status}: ${JSON.stringify(json?.errors || json).slice(0, 300)}`)
  }
  return json?.result
}

// ---- 1. 云端部署 ----
const agentSecret = randomBytes(24).toString('hex')
const workerCode = readFileSync(new URL('../src/worker/tunnel.js', import.meta.url), 'utf8')
const metadata = {
  main_module: 'worker.js',
  compatibility_date: '2025-01-01',
  bindings: [
    { type: 'durable_object_namespace', name: 'TUNNEL', class_name: 'Tunnel' },
    { type: 'plain_text', name: 'AGENT_SECRET', text: agentSecret },
    { type: 'plain_text', name: 'PINS_JSON', text: JSON.stringify({ [HOST]: { sid: 'e2e', pin: PIN } }) }
  ]
}
const form = (meta) => {
  const f = new FormData()
  f.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json')
  f.append('worker.js', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.js')
  return f
}
let deployErr = ''
try {
  // DNS（幂等）
  const old = await cfDns(`/zones/${ZONE}/dns_records?type=A&name=${encodeURIComponent(HOST)}`)
  for (const r of old || []) await cfDns(`/zones/${ZONE}/dns_records/${r.id}`, { method: 'DELETE' })
  await cfDns(`/zones/${ZONE}/dns_records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'A', name: HOST, content: '192.0.2.1', proxied: true, ttl: 1 })
  })
  // Worker（10061 时补 DO 迁移）
  try {
    await cf(`/accounts/${ACCOUNT}/workers/scripts/tunneldock-e2e`, { method: 'PUT', body: form(metadata) })
  } catch (e) {
    if (!String(e.message).includes('10061')) throw e
    await cf(`/accounts/${ACCOUNT}/workers/scripts/tunneldock-e2e`, {
      method: 'PUT',
      body: form({ ...metadata, migrations: { new_tag: 'v1', new_sqlite_classes: ['Tunnel'] } })
    })
  }
  // 路由（幂等）
  const routes = await cf(`/zones/${ZONE}/workers/routes`)
  if (!(routes || []).some((r) => r.pattern === `${HOST}/*`)) {
    await cf(`/zones/${ZONE}/workers/routes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: `${HOST}/*`, script: 'tunneldock-e2e' })
    })
  }
} catch (e) {
  deployErr = e.message
}
ok('云端部署（DNS+Worker+路由）', !deployErr, deployErr)

// ---- 2. demo 服务（HTTP/SSE/WS echo）----
const { createServer } = await import('node:http')
const { WebSocketServer } = await import('ws')
const demo = createServer((req, res) => {
  if (req.url === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let i = 0
    const t = setInterval(() => {
      res.write(`data: tick-${i}\n\n`)
      if (++i >= 3) { clearInterval(t); res.end() }
    }, 300)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(`hello from e2e-rt: ${req.method} ${req.url}`)
})
const wss = new WebSocketServer({ server: demo })
wss.on('connection', (ws) => ws.on('message', (d, b) => ws.send(b ? Buffer.from(d) : `echo:${d}`)))
await new Promise((r, rej) => {
  demo.once('error', rej)
  demo.listen(PORT, '127.0.0.1', r)
}).catch((e) => {
  console.log(`E2E_RT_FAIL=demo 端口被占用（${e.message}），先清理残留 node 进程`)
  process.exit(1)
})

// ---- 3. 独立 userData 启动应用 ----
const ud = join(process.env.TEMP || '/tmp', 'td-e2e-rt')
rmSync(ud, { recursive: true, force: true })
mkdirSync(join(ud, 'data'), { recursive: true })
writeFileSync(join(ud, 'data', 'account.json'), JSON.stringify({
  tokenEnc: TOKEN, plainToken: true, accountId: ACCOUNT, accountName: 'e2e',
  zoneId: ZONE, zoneName: HOST.split('.').slice(1).join('.'), agentSecret
}))
writeFileSync(join(ud, 'data', 'services.json'), JSON.stringify([{
  id: 'e2e01', name: 'e2e-rt', targetHost: '127.0.0.1', targetPort: PORT, pin: PIN,
  hostname: HOST, tokenFile: '', transport: 'wss', autoStart: true, createdAt: Date.now()
}]))

const env = {
  ...process.env,
  NODE_OPTIONS: '',
  TUNNELDOCK_USER_DATA: ud,
  TUNNELDOCK_ALLOW_PACKAGED_DATA_OVERRIDE: '1'
}
let app
if (PACKAGED) {
  delete env.TUNNELDOCK_ALLOW_PACKAGED_DATA_OVERRIDE // 打包版钩子走不了就 SKIP 提示（见 index.ts）
  app = spawn(join(process.cwd(), 'release', 'win-unpacked', 'TunnelDock.exe'), ['--hidden'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
} else {
  env.ELECTRON_RUN_AS_NODE = undefined
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'), ['out/main/index.js', '--hidden'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}
let ready = false
const appLog = []
app.stdout.on('data', (d) => {
  const line = d.toString()
  appLog.push(line)
  if (line.includes(`已连接`) || /宸茶繛鎺/.test(line)) ready = true
})
app.stderr.on('data', (d) => appLog.push(d.toString()))

// ---- 4. 等就绪（最长 3 分钟：边缘轮换 + 体检）----
const deadline = Date.now() + 180000
while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000))
ok('应用启动 + agent 连接（hello-ack 体检通过）', ready, ready ? '' : appLog.join('').slice(-300))

// ---- 5. 验证 ----
function req(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: HOST, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    r.on('error', reject)
    r.setTimeout(25000, () => r.destroy(new Error('timeout')))
    if (body) r.write(body)
    r.end()
  })
}

if (ready) {
  // 登录（上一轮错误 PIN 测试可能留下 60s 封锁 → 等待重试一次）
  let login = await req('/__login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'pin=' + PIN
  })
  if (login.status === 429) {
    console.log('      （IP 限速残留，等 65s）')
    await new Promise((r) => setTimeout(r, 65000))
    login = await req('/__login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'pin=' + PIN
    })
  }
  ok('PIN 登录 302', login.status === 302, `got ${login.status}`)
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')

  // 取页
  const page = await req('/', { headers: { Cookie: cookie } }).catch((e) => ({ status: 0, body: e.message }))
  ok('取页 200 + 本地内容', page.status === 200 && page.body.includes('hello from e2e-rt'), `got ${page.status} ${page.body.slice(0, 40)}`)

  // SSE
  const sse = await req('/sse', { headers: { Cookie: cookie } }).catch((e) => ({ status: 0, text: e.message }))
  ok('SSE 3 ticks', sse.status === 200 && (String(sse.body).match(/tick-\d/g) || []).length === 3, `got ${sse.status}`)

  // WS echo
  const wsResult = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://${HOST}/ws`, { handshakeTimeout: 15000, headers: { Cookie: cookie } })
    const t = setTimeout(() => resolve('timeout'), 20000)
    ws.on('open', () => ws.send('ping'))
    ws.on('message', (d) => { clearTimeout(t); ws.close(); resolve(d.toString()) })
    ws.on('error', (e) => { clearTimeout(t); resolve('ERR ' + e.message) })
  })
  ok('WS echo', wsResult === 'echo:ping', String(wsResult).slice(0, 40))

  // 错误 PIN 限速（6 次 → 429）
  let got429 = false
  for (let i = 0; i < 6 && !got429; i++) {
    const r = await req('/__login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'pin=' + PIN_BAD
    })
    if (r.status === 429) got429 = true
  }
  ok('错误 PIN 限速 429', got429)
}

// ---- 6. 清场 ----
try { app.kill() } catch {}
try { demo.close() } catch {}
try { rmSync(ud, { recursive: true, force: true }) } catch {}
try { spawnSync('taskkill', ['/IM', PACKAGED ? 'TunnelDock.exe' : 'electron.exe', '/F'], { stdio: 'ignore' }) } catch {}

console.log(failed === 0 ? 'E2E_RT_PASS' : `E2E_RT_FAIL=${failed}`)
process.exit(failed === 0 ? 0 : 1)
