// 服务编排 + IPC：发布 = 网关代理(utilityProcess) + cloudflared 快隧道
// M2：断线自动重连（指数退避）、随应用启动自动恢复、系统通知、自定义口令
import { ipcMain, BrowserWindow, app, Notification } from 'electron'
import { join } from 'path'
import { rmSync } from 'fs'
import { registry, ServiceConfig, genPin } from './registry'
import { startGateway, stopGateway, GatewayHandle } from './gateway'
import { startTunnel, startNamedTunnel, probeReady, stopTunnel, hasOriginCert, deleteNamedTunnel, tunnelsDir } from './tunnel'
import { startAgent, stopAgent, AgentHandle } from './agentProc'
import { initRtAccount, getRtAccount, rtToken, rtSetup, rtDeploy, rtForget, syncPins, rtStatus, EDGE_IPS } from './rt'
import type { ServiceState } from '../shared/types'
import type { ChildProcess } from 'child_process'

interface Runtime {
  gateway: GatewayHandle | null
  tunnelChild: ChildProcess | null
  agent: AgentHandle | null // RT 模式：wss 反连 agent（自带断线重连）
  status: ServiceState
  desired: 'running' | 'stopped'
  attempts: number
  reconnectTimer: NodeJS.Timeout | null
  starting: Promise<unknown> | null // 单飞：防止并发启动
}

const runtimes = new Map<string, Runtime>()
const BACKOFF_MS = [5000, 15000, 60000, 300000] // 退避表；封顶 5 分钟后无限慢速重试，不转 error
// 国内 ISP 对 cloudflared 边缘 7844 存在间歇性 DPI 阻断（QUIC/http2 同时被掐，恢复窗口随机出现），
// 放弃重试服务就永远上不来——所以重连永不停止，窗口一开即自愈。
// QUIC（UDP）被掐时奇数次重连轮换 http2（TCP）；一旦某服务用 http2 成功过，后续（含手动重启）直接用 http2
const http2Prefs = new Set<string>()

function rt(id: string): Runtime {
  let r = runtimes.get(id)
  if (!r) {
    r = {
      gateway: null,
      tunnelChild: null,
      agent: null,
      status: { id, status: 'idle', url: null, error: null, attempt: 0 },
      desired: 'stopped',
      attempts: 0,
      reconnectTimer: null,
      starting: null
    }
    runtimes.set(id, r)
  }
  return r
}

function broadcast(): void {
  const states = [...runtimes.values()].map((r) => r.status)
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('td:event', states)
  }
}

function setStatus(id: string, patch: Partial<ServiceState>): void {
  const r = rt(id)
  r.status = { ...r.status, ...patch }
  broadcast()
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch {
    /* 通知失败不影响主流程 */
  }
}

function clearReconnect(r: Runtime): void {
  if (r.reconnectTimer) {
    clearTimeout(r.reconnectTimer)
    r.reconnectTimer = null
  }
}

function teardown(r: Runtime): void {
  if (r.tunnelChild) stopTunnel(r.tunnelChild)
  stopGateway(r.gateway)
  stopAgent(r.agent)
  r.tunnelChild = null
  r.gateway = null
  r.agent = null
}

async function startService(id: string, isReconnect = false): Promise<ServiceState> {
  const svc = registry.get(id)
  if (!svc) throw new Error('服务不存在')
  if (svc.transport === 'wss') return startRtService(id)
  const r = rt(id)
  if (r.starting) return r.status // 单飞：已有启动流程在跑
  r.desired = 'running'
  if (r.status.status === 'ready') return r.status // 已在线

  r.starting = (async (): Promise<void> => {
    setStatus(id, { status: 'starting', url: null, error: null, attempt: r.attempts })
    try {
      // 1) 网关代理（OS 分配端口）
      const gw = await startGateway(
        {
          listenPort: 0,
          targetHost: svc.targetHost,
          targetPort: svc.targetPort,
          pin: svc.pin,
          serviceName: svc.name,
          tokenSource: svc.tokenFile || ''
        },
        (level, msg) => console.log(`[gateway:${svc.name}] ${level} ${msg}`)
      )
      r.gateway = gw
      // 网关进程崩溃监督（此前只有 cloudflared 有）：utilityProcess 意外退出时
      // 走同一条重连链路，否则 cloudflared 会指着一个死端口永远 502
      gw.process.on('exit', () => {
        const cur = rt(id)
        if (cur.gateway === gw && cur.desired === 'running') {
          cur.gateway = null
          scheduleReconnect(id, '网关代理进程退出，正在重建')
        }
      })

      // 2) 隧道：有域名走命名隧道（固定地址），否则免费临时地址
      // QUIC 失败后的重连按奇偶轮换协议（奇数次 http2、偶数次回 QUIC）、或本服务曾用 http2 成功过 → 强制 http2（TCP）
      const forceHttp2 = http2Prefs.has(svc.id) || (isReconnect && r.attempts % 2 === 1)
      const cfLog = (line: string): void => console.log(`[cf:${svc.name}] ${line}`)
      const t = svc.hostname
        ? await startNamedTunnel({
            tunnelName: `tunneldock-${svc.id}`,
            hostname: svc.hostname,
            proxyPort: gw.port,
            serviceId: svc.id,
            onLog: cfLog,
            forceHttp2
          })
        : await startTunnel(gw.port, 60000, cfLog, forceHttp2)
      r.tunnelChild = t.child
      t.child.on('exit', () => {
        const cur = rt(id)
        if (cur.desired === 'running') scheduleReconnect(id)
        // 主动停止（desired=stopped）不触发重连
      })

      // 3) 探活（边缘节点就绪需要几秒；必须认出我们自己的登录页，防误配垃圾域名）
      //    命名隧道例外：隧道已注册成功（Registered），若只是本机连不上 CF 边缘 443
      //    （国内网络间歇阻断，kind=unreachable），对外部网络（手机）隧道仍是通的——
      //    降级为警告，不拆隧道；内容不对（mismatch）仍按失败处理，那是真配置错误
      try {
        await probeReady(t.url, 30000, 'TunnelDock')
      } catch (e) {
        if (!svc.hostname || (e as Error & { kind?: string }).kind !== 'unreachable') throw e
        console.warn(`[probe] ${svc.name}: 本机无法直连 CF 边缘（${(e as Error).message}），隧道已注册，按已上线处理`)
        notify(
          'TunnelDock 隧道已上线（本机探活未通过）',
          `${svc.name} 隧道已注册，但本机当前无法直连 Cloudflare 边缘；手机等外部网络可能仍可正常访问`
        )
      }

      const wasReconnect = r.attempts > 0
      r.attempts = 0
      if (forceHttp2) http2Prefs.add(svc.id) // 记住：这个网络环境下 http2 才通
      setStatus(id, { status: 'ready', url: t.url, error: null, attempt: 0 })
      if (wasReconnect || isReconnect) {
        console.log(`E2E_URL2=${t.url}`) // E2E 重连观测点
        notify('TunnelDock 隧道已恢复', `${svc.name} 已重新上线：${t.url}`)
      }
    } catch (e) {
      teardown(r)
      const msg = (e as Error).message
      if (r.desired === 'running') {
        // 启动失败也按退避无限重试（比如开机时网络还没就绪、ISP 间歇阻断边缘 7844）
        scheduleReconnect(id, msg)
      } else {
        setStatus(id, { status: 'error', url: null, error: msg, attempt: r.attempts })
      }
      throw e // 抛给调用方即时看到原因（e2e 的 E2E_FAIL 也依赖这里），重试在后台继续
    }
  })()
  try {
    await r.starting
  } finally {
    r.starting = null
  }
  return rt(id).status
}

/** RT（wss 反向隧道）模式的启动：拉起 agent utilityProcess，等它的 ready 上报
 *  重连由 agent 内部自理（指数退避+钉 IP 轮换）；这里只反映状态 */
async function startRtService(id: string): Promise<ServiceState> {
  const svc = registry.get(id)
  if (!svc) throw new Error('服务不存在')
  if (!svc.hostname) throw new Error('wss 模式需要子域名：先在「反向隧道」向导里完成部署')
  const acc = getRtAccount()
  if (!acc) throw new Error('尚未配置反向隧道：请先打开「反向隧道」向导完成 Cloudflare 部署')
  const r = rt(id)
  if (r.starting) return r.status
  r.desired = 'running'
  if (r.status.status === 'ready') return r.status

  r.starting = (async (): Promise<void> => {
    setStatus(id, { status: 'starting', url: null, error: null, attempt: r.attempts })
    const handle = startAgent(
      {
        hostname: svc.hostname,
        agentSecret: acc.agentSecret,
        targetHost: svc.targetHost,
        targetPort: svc.targetPort,
        tokenFile: svc.tokenFile || undefined,
        edgeIps: EDGE_IPS
      },
      (ev) => {
        const cur = rt(id)
        if (cur.desired !== 'running' || cur.agent !== handle) return
        if (ev.type === 'ready') {
          cur.attempts = 0
          setStatus(id, { status: 'ready', url: `https://${svc.hostname}`, error: null, attempt: 0 })
        } else if (ev.type === 'offline') {
          // agent 会自动重连；这里给用户可见的"重连中"状态
          setStatus(id, { status: 'starting', url: null, error: '连接断开，自动重连中', attempt: Math.max(1, cur.attempts) })
        } else if (ev.type === 'log') {
          console.log(`[agent:${svc.name}] ${ev.level || 'info'} ${ev.message || ''}`)
        } else if (ev.type === 'fatal') {
          console.error(`[agent:${svc.name}] fatal ${ev.message}`)
        }
      },
      (code) => {
        const cur = rt(id)
        if (cur.agent === handle) cur.agent = null
        if (cur.desired === 'running') scheduleReconnect(id, `agent 进程退出（code ${code}）`)
      }
    )
    r.agent = handle
    // 等 ready（含钉 IP 轮换，最长给 90s；超时也不杀——agent 可能仍在慢速重试）
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 90000)
      const poll = setInterval(() => {
        if (rt(id).status.status === 'ready' || rt(id).desired !== 'running') {
          clearTimeout(timer)
          clearInterval(poll)
          resolve()
        }
      }, 500)
    })
  })()
  try {
    await r.starting
  } finally {
    r.starting = null
  }
  return rt(id).status
}

function scheduleReconnect(id: string, reason = '隧道连接断开'): void {  const r = rt(id)
  if (r.reconnectTimer) return // 已有重连在排队（网关与隧道可能接连退出，只排一次）
  const delay = BACKOFF_MS[Math.min(r.attempts, BACKOFF_MS.length - 1)]
  r.attempts += 1
  const svc = registry.get(id)
  if (r.attempts === BACKOFF_MS.length) {
    // 刚进入最慢一档：提示一次（无限重试不能反复弹通知），此后静默自愈
    notify(
      'TunnelDock 转入慢速重连',
      `${svc?.name ?? id} 持续连不上 Cloudflare 边缘，之后每 5 分钟自动重试，网络恢复后会自动上线`
    )
  }
  setStatus(id, { status: 'starting', url: null, error: `${reason}，${Math.round(delay / 1000)}s 后第 ${r.attempts} 次重连`, attempt: r.attempts })
  clearReconnect(r)
  r.reconnectTimer = setTimeout(() => {
    r.reconnectTimer = null
    teardown(r)
    void startService(id, true).catch(() => {
      /* 状态已在内部处理 */
    })
  }, delay)
}

function stopService(id: string): ServiceState {
  const r = rt(id)
  r.desired = 'stopped'
  clearReconnect(r)
  r.attempts = 0
  teardown(r)
  setStatus(id, { status: 'idle', url: null, error: null, attempt: 0 })
  return r.status
}

/** 应用退出时统一回收（will-quit 调用）：停全部隧道与网关，不留孤儿进程 */
export function shutdownAll(): void {
  for (const r of runtimes.values()) {
    r.desired = 'stopped'
    clearReconnect(r)
    teardown(r)
  }
}

/** 应用启动时恢复所有 autoStart 的发布（错峰启动，避免同时抢隧道） */
export function autoRestore(): void {
  const targets = registry.list().filter((s) => s.autoStart)
  targets.forEach((s, i) => {
    setTimeout(
      () =>
        void startService(s.id).catch(() => {
          /* 启动失败已进状态机/重连 */
        }),
      800 + i * 1500
    )
  })
  if (targets.length > 0) console.log(`AUTO_RESTORE=${targets.length}`)
}

// ---- 应用级开机自启 ----
function getAppAutostart(): boolean {
  const settings = app.getLoginItemSettings()
  return settings.openAtLogin
}

function setAppAutostart(on: boolean): void {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
  } else {
    // 开发模式：注册 electron.exe + 入口脚本
    const entry = join(app.getAppPath(), 'out', 'main', 'index.js')
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [entry, '--hidden'] })
  }
}

/** RT 已配置时，服务变更后同步 PINS_JSON（失败只记日志，不打断本地操作） */
function maybeSyncPins(): void {
  if (!getRtAccount()) return
  void syncPins().catch((e) => console.error(`[rt] PINS 同步失败: ${(e as Error).message}`))
}

export function registerIpc(): void {
  ipcMain.handle('td:list', () => registry.list())
  ipcMain.handle('td:states', () => [...runtimes.values()].map((r) => r.status))
  ipcMain.handle('td:appInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform
  }))
  ipcMain.handle(
    'td:create',
    (_e, p: { name: string; targetHost: string; targetPort: number; pin?: string; transport?: string }) => {
      if (!p?.name || !p?.targetHost || !p?.targetPort) throw new Error('参数不完整')
      if (p.pin !== undefined && !/^[0-9A-Za-z@#$%^&*-]{6,32}$/.test(p.pin)) {
        throw new Error('自定义口令需 6-32 位，仅限字母/数字/@#$%^&*-')
      }
      const transport = p.transport === 'wss' ? ('wss' as const) : undefined
      const svc = registry.add(String(p.name).slice(0, 30), String(p.targetHost), Number(p.targetPort), p.pin)
      if (transport) registry.update(svc.id, { transport })
      // RT 模式：新服务要进 PINS_JSON（子域名在下次部署时分配；这里只重部署 vars）
      void maybeSyncPins()
      return registry.get(svc.id)
    }
  )
  ipcMain.handle('td:start', (_e, id: string) => startService(id))
  ipcMain.handle('td:stop', (_e, id: string) => stopService(id))
  ipcMain.handle('td:remove', async (_e, id: string, purgeCloud?: boolean) => {
    const svc = registry.get(id)
    stopService(id)
    const removed = registry.remove(id)
    let cloudPurged = false
    let cloudError: string | undefined
    if (svc) {
      try {
        rmSync(join(tunnelsDir(), `${svc.id}.yml`), { force: true }) // 本地 ingress 配置一并清
      } catch {
        /* 尽力删除 */
      }
      if (svc.hostname && purgeCloud) {
        if (svc.transport === 'wss') {
          // RT 模式：删该子域的 DNS 记录（Worker/路由不动，其他服务不受影响）
          const acc = getRtAccount()
          const token = rtToken()
          if (acc && token) {
            try {
              const { deleteDnsRecord } = await import('./cloudapi')
              await deleteDnsRecord(token, acc.zoneId, svc.hostname)
              cloudPurged = true
            } catch (e) {
              cloudError = (e as Error).message
            }
          }
        } else {
          try {
            deleteNamedTunnel(`tunneldock-${svc.id}`)
            cloudPurged = true
          } catch (e) {
            cloudError = (e as Error).message
          }
        }
      }
      void maybeSyncPins()
    }
    return { removed, cloudPurged, cloudError }
  })
  ipcMain.handle('td:resetPin', (_e, id: string) => {
    const pin = genPin()
    const svc = registry.update(id, { pin })
    if (!svc) throw new Error('服务不存在')
    if (rt(id).status.status === 'ready') stopService(id)
    void maybeSyncPins()
    return svc
  })
  ipcMain.handle('td:setPin', (_e, id: string, pin: string) => {
    if (!/^[0-9A-Za-z@#$%^&*-]{6,32}$/.test(String(pin))) {
      throw new Error('自定义口令需 6-32 位，仅限字母/数字/@#$%^&*-')
    }
    const svc = registry.update(id, { pin: String(pin) })
    if (!svc) throw new Error('服务不存在')
    if (rt(id).status.status === 'ready') stopService(id)
    void maybeSyncPins()
    return svc
  })
  ipcMain.handle('td:setAutoStart', (_e, id: string, on: boolean) => {
    const svc = registry.update(id, { autoStart: on === true })
    if (!svc) throw new Error('服务不存在')
    return svc
  })
  ipcMain.handle('td:setHostname', (_e, id: string, hostname: string) => {
    const host = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (host && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
      throw new Error('域名格式不对（如 pi.example.com）')
    }
    if (host && !hasOriginCert()) {
      throw new Error('尚未完成 Cloudflare 授权，无法使用固定域名')
    }
    const svc = registry.update(id, { hostname: host })
    if (!svc) throw new Error('服务不存在')
    // 域名变更 = 隧道形态变化，正在跑的必须重启生效
    if (rt(id).status.status === 'ready') stopService(id)
    return svc
  })
  ipcMain.handle('td:hasOriginCert', () => hasOriginCert())
  // ---- 传输模式切换（cloudflared ⇄ wss）----
  ipcMain.handle('td:setTransport', (_e, id: string, transport: string) => {
    const t = transport === 'wss' ? 'wss' : 'cloudflared'
    if (t === 'wss') {
      const acc = getRtAccount()
      if (!acc) throw new Error('尚未配置反向隧道：先在「反向隧道」向导完成部署')
    }
    const svc = registry.update(id, { transport: t === 'cloudflared' ? undefined : 'wss' })
    if (!svc) throw new Error('服务不存在')
    if (rt(id).status.status === 'ready') stopService(id)
    void maybeSyncPins()
    return svc
  })
  // ---- 反向隧道（RT）向导 ----
  ipcMain.handle('rt:status', () => rtStatus())
  ipcMain.handle('rt:setup', (_e, token: string, dnsToken?: string) => rtSetup(token, dnsToken))
  ipcMain.handle('rt:deploy', (_e, token: string, zoneId: string, dnsToken?: string) => rtDeploy(token, zoneId, dnsToken))
  ipcMain.handle('rt:forget', () => rtForget())
  ipcMain.handle('td:setTokenFile', (_e, id: string, file: string) => {
    const f = String(file || '').trim()
    const svc = registry.update(id, { tokenFile: f })
    if (!svc) throw new Error('服务不存在')
    // 令牌引导变更需重启网关生效
    if (rt(id).status.status === 'ready') stopService(id)
    return svc
  })
  ipcMain.handle('td:appAutostart:get', () => getAppAutostart())
  ipcMain.handle('td:appAutostart:set', (_e, on: boolean) => {
    setAppAutostart(on === true)
    return getAppAutostart()
  })
}

/** E2E 用：发布一个 demo 服务并把结果打到 stdout（--publish-demo） */
export async function publishDemo(targetPort: number, customPin?: string): Promise<void> {
  let svc: ServiceConfig | undefined = registry.list().find((s) => s.name === 'e2e-demo')
  if (!svc) svc = registry.add('e2e-demo', '127.0.0.1', targetPort, customPin)
  else if (customPin) svc = registry.update(svc.id, { pin: customPin }) ?? svc
  console.log(`E2E_PIN=${svc.pin}`)
  try {
    const st = await startService(svc.id)
    console.log(`E2E_URL=${st.url}`)
  } catch (e) {
    console.log(`E2E_FAIL=${(e as Error).message}`)
    app.exit(1)
  }
}
