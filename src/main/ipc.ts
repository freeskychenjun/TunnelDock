// 服务编排 + IPC：发布 = 网关代理(utilityProcess) + cloudflared 快隧道；状态机广播给渲染层
import { ipcMain, BrowserWindow, app } from 'electron'
import { registry, ServiceConfig, genPin } from './registry'
import { startGateway, stopGateway, GatewayHandle } from './gateway'
import { startTunnel, probeReady, stopTunnel } from './tunnel'
import type { ChildProcess } from 'child_process'

export interface ServiceState {
  id: string
  status: 'idle' | 'starting' | 'ready' | 'error' | 'stopping'
  url: string | null
  error: string | null
}

interface Runtime {
  gateway: GatewayHandle | null
  tunnelChild: ChildProcess | null
  status: ServiceState
}

const runtimes = new Map<string, Runtime>()

function rt(id: string): Runtime {
  let r = runtimes.get(id)
  if (!r) {
    r = { gateway: null, tunnelChild: null, status: { id, status: 'idle', url: null, error: null } }
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

async function startService(id: string): Promise<ServiceState> {
  const svc = registry.get(id)
  if (!svc) throw new Error('服务不存在')
  const r = rt(id)
  if (r.status.status === 'starting' || r.status.status === 'ready') return r.status

  setStatus(id, { status: 'starting', url: null, error: null })
  try {
    // 1) 网关代理（OS 分配端口）
    const gw = await startGateway(
      {
        listenPort: 0,
        targetHost: svc.targetHost,
        targetPort: svc.targetPort,
        pin: svc.pin,
        serviceName: svc.name
      },
      (level, msg) => console.log(`[gateway:${svc.name}] ${level} ${msg}`)
    )
    r.gateway = gw

    // 2) 快隧道指向代理
    const t = await startTunnel(gw.port)
    r.tunnelChild = t.child
    t.child.on('exit', () => {
      // 云端断开/进程退出：非主动停止则标记错误
      const cur = rt(id)
      if (cur.status.status === 'ready' || cur.status.status === 'starting') {
        cur.gateway = null
        cur.tunnelChild = null
        setStatus(id, { status: 'error', url: null, error: '隧道连接断开，请重新启动' })
      }
    })

    // 3) 探活（边缘节点就绪需要几秒）
    await probeReady(t.url)

    setStatus(id, { status: 'ready', url: t.url, error: null })
    return rt(id).status
  } catch (e) {
    stopGateway(r.gateway)
    if (r.tunnelChild) stopTunnel(r.tunnelChild)
    r.gateway = null
    r.tunnelChild = null
    const msg = (e as Error).message
    setStatus(id, { status: 'error', url: null, error: msg })
    throw new Error(msg)
  }
}

function stopService(id: string): ServiceState {
  const r = rt(id)
  if (r.tunnelChild) stopTunnel(r.tunnelChild)
  stopGateway(r.gateway)
  r.tunnelChild = null
  r.gateway = null
  setStatus(id, { status: 'idle', url: null, error: null })
  return r.status
}

export function registerIpc(): void {
  ipcMain.handle('td:list', () => registry.list())
  ipcMain.handle('td:states', () => [...runtimes.values()].map((r) => r.status))
  ipcMain.handle('td:create', (_e, p: { name: string; targetHost: string; targetPort: number }) => {
    if (!p?.name || !p?.targetHost || !p?.targetPort) throw new Error('参数不完整')
    return registry.add(String(p.name).slice(0, 30), String(p.targetHost), Number(p.targetPort))
  })
  ipcMain.handle('td:start', async (_e, id: string) => startService(id))
  ipcMain.handle('td:stop', (_e, id: string) => stopService(id))
  ipcMain.handle('td:remove', (_e, id: string) => {
    stopService(id)
    return registry.remove(id)
  })
  ipcMain.handle('td:resetPin', (_e, id: string) => {
    const pin = genPin()
    const svc = registry.update(id, { pin })
    if (!svc) throw new Error('服务不存在')
    // PIN 变了，正在跑的发布必须重启才生效
    if (rt(id).status.status === 'ready') stopService(id)
    return svc
  })
}

/** E2E 用：发布一个 demo 服务并把结果打到 stdout（--publish-demo） */
export async function publishDemo(targetPort: number): Promise<void> {
  let svc: ServiceConfig | undefined = registry.list().find((s) => s.name === 'e2e-demo')
  if (!svc) svc = registry.add('e2e-demo', '127.0.0.1', targetPort)
  console.log(`E2E_PIN=${svc.pin}`)
  try {
    const st = await startService(svc.id)
    console.log(`E2E_URL=${st.url}`)
  } catch (e) {
    console.log(`E2E_FAIL=${(e as Error).message}`)
    app.exit(1)
  }
}
