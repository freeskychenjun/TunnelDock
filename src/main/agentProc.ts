// RT agent 的 utilityProcess 封装：fork、等 ready 上报、停止
import { utilityProcess, UtilityProcess, app } from 'electron'
import { join } from 'path'

// agent.js 需要磁盘上的真实文件：打包后它在 app.asar.unpacked 里（electron-builder asarUnpack）
function agentModule(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'agent.js')
  }
  return join(__dirname, 'agent.js')
}

export interface AgentHandle {
  process: UtilityProcess
}

export interface AgentConfig {
  hostname: string // 该服务的公网子域名（wss 反连目标）
  agentSecret: string
  targetHost: string
  targetPort: number
  tokenFile?: string // 令牌引导源文件；空 = 不启用
  edgeIps?: string[] // DNS 抽风时的备选边缘 IP（进程内钉 IP，不改 hosts）
}

export function startAgent(
  cfg: AgentConfig,
  onEvent?: (ev: { type: 'ready' | 'offline' | 'log' | 'fatal'; level?: string; message?: string }) => void,
  onExit?: (code: number) => void
): AgentHandle {
  const proc = utilityProcess.fork(agentModule(), [JSON.stringify(cfg)], {
    serviceName: `td-agent-${cfg.hostname.replace(/[^a-z0-9-]/gi, '-')}`
  })
  proc.on('message', (msg: unknown) => {
    const m = (msg && typeof msg === 'object' ? msg : { data: msg }) as {
      type?: string
      level?: string
      message?: string
    }
    if (m.type) onEvent?.(m as { type: 'ready' | 'offline' | 'log' | 'fatal'; level?: string; message?: string })
  })
  if (onExit) proc.on('exit', onExit)
  return { process: proc }
}

export function stopAgent(handle: AgentHandle | null | undefined): void {
  if (!handle) return
  try {
    handle.process.kill()
  } catch {
    /* 已退出 */
  }
}
