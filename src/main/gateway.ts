// 网关代理的 utilityProcess 封装：fork、等 listening 上报端口、停止
import { utilityProcess, UtilityProcess, app } from 'electron'
import { join } from 'path'

// gateway.js 需要磁盘上的真实文件：打包后它在 app.asar.unpacked 里（electron-builder asarUnpack）
function gatewayModule(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'gateway.js')
  }
  return join(__dirname, 'gateway.js')
}

export interface GatewayHandle {
  process: UtilityProcess
  port: number
}

export interface GatewayConfig {
  listenPort: number // 0 = OS 分配
  targetHost: string
  targetPort: number
  pin: string
  serviceName: string
  tokenSource: string // 令牌引导源文件（proxy.cjs 读 cfg.tokenSource）；空 = 不启用
}

export function startGateway(cfg: GatewayConfig, onLog?: (level: string, msg: string) => void): Promise<GatewayHandle> {
  return new Promise<GatewayHandle>((resolve, reject) => {
    const proc = utilityProcess.fork(gatewayModule(), [JSON.stringify(cfg)], {
      serviceName: `td-gateway-${cfg.serviceName}`
    })
    const timer = setTimeout(() => {
      reject(new Error('网关代理 10 秒内未就绪'))
      try {
        proc.kill()
      } catch {
        /* noop */
      }
    }, 10000)

    proc.on('message', (msg: unknown) => {
      const m = (msg && typeof msg === 'object' ? msg : { data: msg }) as {
        type?: string
        port?: number
        level?: string
        message?: string
      }
      if (m.type === 'listening' && m.port) {
        clearTimeout(timer)
        resolve({ process: proc, port: m.port })
      } else if (m.type === 'log' && onLog) {
        onLog(m.level || 'info', m.message || '')
      } else if (m.type === 'fatal') {
        clearTimeout(timer)
        reject(new Error(`网关代理启动失败: ${m.message}`))
      }
    })
    proc.on('exit', () => clearTimeout(timer))
  })
}

export function stopGateway(handle: GatewayHandle | null | undefined): void {
  if (!handle) return
  try {
    handle.process.kill()
  } catch {
    /* 已退出 */
  }
}
