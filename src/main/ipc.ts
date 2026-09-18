// 服务编排 + IPC：发布 = 网关代理(utilityProcess) + cloudflared 快隧道
// M2：断线自动重连（指数退避）、随应用启动自动恢复、系统通知、自定义口令
import { ipcMain, BrowserWindow, app, Notification } from 'electron'
import { join } from 'path'
import { registry, ServiceConfig, genPin } from './registry'
import { startGateway, stopGateway, GatewayHandle } from './gateway'
import { startTunnel, startNamedTunnel, probeReady, stopTunnel, hasOriginCert } from './tunnel'
import type { ChildProcess } from 'child_process'

export interface ServiceState {
  id: string
  status: 'idle' | 'starting' | 'ready' | 'error' | 'stopping'
  url: string | null
  error: string | null
  attempt: number // 重连次数（0 = 首次启动或已成功）
}

interface Runtime {
  gateway: GatewayHandle | null
  tunnelChild: ChildProcess | null
  status: ServiceState
  desired: 'running' | 'stopped'
  attempts: number
  reconnectTimer: NodeJS.Timeout | null
  starting: Promise<unknown> | null // 单飞：防止并发启动
}

const runtimes = new Map<string, Runtime>()
const BACKOFF_MS = [5000, 15000, 60000] // 退避表；超过次数转 error
// QUIC（UDP）被网络掐断的环境下自动降级 http2（TCP）：
// 首次失败后的重连即切 http2；一旦某服务用 http2 成功过，后续（含手动重启）直接用 http2
const http2Prefs = new Set<string>()

function rt(id: string): Runtime {
  let r = runtimes.get(id)
  if (!r) {
    r = {
      gateway: null,
      tunnelChild: null,
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
  r.tunnelChild = null
  r.gateway = null
}

async function startService(id: string, isReconnect = false): Promise<ServiceState> {
  const svc = registry.get(id)
  if (!svc) throw new Error('服务不存在')
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
      // QUIC 失败后的重连、或本服务曾用 http2 成功过 → 强制 http2（TCP）
      const forceHttp2 = http2Prefs.has(svc.id) || (isReconnect && r.attempts >= 1)
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
      await probeReady(t.url, 30000, 'TunnelDock')

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
      if (r.desired === 'running' && r.attempts < BACKOFF_MS.length) {
        // 启动失败也按退避重试（比如开机时网络还没就绪）
        scheduleReconnect(id, msg)
      } else {
        setStatus(id, { status: 'error', url: null, error: msg, attempt: r.attempts })
        throw e
      }
    }
  })()
  try {
    await r.starting
  } finally {
    r.starting = null
  }
  return rt(id).status
}

function scheduleReconnect(id: string, reason = '隧道连接断开'): void {
  const r = rt(id)
  if (r.reconnectTimer) return // 已有重连在排队（网关与隧道可能接连退出，只排一次）
  const delay = BACKOFF_MS[Math.min(r.attempts, BACKOFF_MS.length - 1)]
  r.attempts += 1
  const svc = registry.get(id)
  if (r.attempts > BACKOFF_MS.length) {
    setStatus(id, { status: 'error', url: null, error: `${reason}，自动重连 ${r.attempts - 1} 次仍失败，已停止重试`, attempt: r.attempts })
    notify('TunnelDock 重连失败', `${svc?.name ?? id} 多次重连失败，请手动启动`)
    return
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

export function registerIpc(): void {
  ipcMain.handle('td:list', () => registry.list())
  ipcMain.handle('td:states', () => [...runtimes.values()].map((r) => r.status))
  ipcMain.handle('td:create', (_e, p: { name: string; targetHost: string; targetPort: number; pin?: string }) => {
    if (!p?.name || !p?.targetHost || !p?.targetPort) throw new Error('参数不完整')
    if (p.pin !== undefined && !/^[0-9A-Za-z@#$%^&*-]{6,32}$/.test(p.pin)) {
      throw new Error('自定义口令需 6-32 位，仅限字母/数字/@#$%^&*-')
    }
    return registry.add(String(p.name).slice(0, 30), String(p.targetHost), Number(p.targetPort), p.pin)
  })
  ipcMain.handle('td:start', (_e, id: string) => startService(id))
  ipcMain.handle('td:stop', (_e, id: string) => stopService(id))
  ipcMain.handle('td:remove', (_e, id: string) => {
    stopService(id)
    return registry.remove(id)
  })
  ipcMain.handle('td:resetPin', (_e, id: string) => {
    const pin = genPin()
    const svc = registry.update(id, { pin })
    if (!svc) throw new Error('服务不存在')
    if (rt(id).status.status === 'ready') stopService(id)
    return svc
  })
  ipcMain.handle('td:setPin', (_e, id: string, pin: string) => {
    if (!/^[0-9A-Za-z@#$%^&*-]{6,32}$/.test(String(pin))) {
      throw new Error('自定义口令需 6-32 位，仅限字母/数字/@#$%^&*-')
    }
    const svc = registry.update(id, { pin: String(pin) })
    if (!svc) throw new Error('服务不存在')
    if (rt(id).status.status === 'ready') stopService(id)
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
