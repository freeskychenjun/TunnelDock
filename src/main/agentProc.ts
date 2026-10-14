// RT agent 的 utilityProcess 封装：fork、等 ready 上报、停止
// 注意：agent 是 esbuild 产的 ESM 单文件（rollup CJS 化会破坏 ws 的上行发送——M2b 实测坑），
// 入口名 agent.mjs；需要磁盘真实文件，打包后在 app.asar.unpacked 里
import { utilityProcess, UtilityProcess, app } from 'electron'
import { join } from 'path'

function agentModule(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'agent.mjs')
  }
  return join(__dirname, 'agent.mjs')
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
