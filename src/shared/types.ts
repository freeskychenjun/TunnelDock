// 跨进程共享类型：单一来源，main / preload / renderer 都从这里取
// （此前同样的接口在 registry.ts / preload / env.d.ts 各写一份，已出现字段漂移）

export interface ServiceConfig {
  id: string
  name: string
  targetHost: string
  targetPort: number
  pin: string
  hostname: string // 留空 = 免费临时地址（Quick Tunnel）；填域名 = 命名隧道固定地址
  tokenFile: string // 服务自带令牌的来源文件（如 dsh web 的 pm2 日志）；留空 = 不启用引导
  autoStart: boolean
  createdAt: number
}

export interface ServiceState {
  id: string
  status: 'idle' | 'starting' | 'ready' | 'error' | 'stopping'
  url: string | null
  error: string | null
  attempt: number // 重连次数（0 = 首次启动或已成功）
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
}

export interface RemoveResult {
  removed: boolean
  cloudPurged: boolean // 是否连同删除了 Cloudflare 侧隧道
  cloudError?: string // 云端删除失败时的原因（本地删除不受影响）
}
