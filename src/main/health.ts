// 数据面健康看门狗：弥补「进程活着但隧道已僵死」的检测盲区
//
// 背景：既有重连全部由信号驱动——cloudflared/网关进程退出、agent 上报 offline。
// 但 2026-10-13 的 ISP 封锁事件暴露了第三种形态：TCP 半开（本机以为连着，
// 对端早已不在），任何信号都不会来，UI 永远显示 ready。本模块从外部视角
// 周期性探活公网地址，连续判死则交回既有 scheduleReconnect 链路重建。
//
// 判定（judgeProbe 纯函数，单测 tests/unit/health.test.ts）：
//   alive   = HTTP <500（PIN 墙的 200/302/401、源站 2xx/4xx 都说明隧道层是通的）
//   down    = 530（CF 1033：命名隧道无活跃连接器）；Worker 在 agent 离线时的
//             「隧道离线/隧道请求超时」文案；其余 5xx 是源站自身的问题，不算隧道的账
//   unknown = 本机连不上 CF 边缘——无法观测，隧道对外部网络可能仍是好的
//             （同 probeReady 的 unreachable 语义），本轮跳过不动作
import https from 'node:https'

export type ProbeVerdict = 'alive' | 'down' | 'unknown'

export function judgeProbe(status: number | null, body: string): ProbeVerdict {
  if (status == null) return 'unknown'
  if (status < 500) return 'alive'
  if (status === 530) return 'down'
  if (/隧道离线|隧道请求超时/.test(body)) return 'down'
  return 'alive'
}

/** 单次 HTTPS GET。ip 非空 = 进程内钉 IP：TCP 连该地址，SNI/Host 仍按域名
 *  （CF 边缘按 SNI 路由，任何边缘 IP 都能服务任意代理域名——同 agent 的钉 IP 手法）。 */
function httpsGet(url: string, ip: string | null, timeoutMs: number): Promise<{ status: number | null; body: string }> {
  const u = new URL(url)
  return new Promise((resolve) => {
    let done = false
    const finish = (status: number | null, body: string): void => {
      if (done) return
      done = true
      resolve({ status, body })
    }
    const req = https.request(
      {
        host: ip ?? u.hostname,
        servername: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Host: u.hostname, 'User-Agent': 'TunnelDock-HealthCheck/1.0' },
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        res.on('data', (c: Buffer) => {
          if (body.length < 8192) body += c.toString('utf8')
        })
        res.on('end', () => finish(res.statusCode ?? null, body))
        res.on('error', () => finish(res.statusCode ?? null, body))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      finish(null, '')
    })
    req.on('error', () => finish(null, ''))
    req.end()
  })
}

/** 探测一个服务的公网地址：先走 DNS 解析，连不上再钉 edgeIps 兜底
 *  （有的网络把 DNS 解析出的 CF 网段全拦了、只有个别 IP 可达——2026-10 实测）。 */
export async function probeService(url: string, edgeIps: string[]): Promise<ProbeVerdict> {
  let status: number | null = null
  let body = ''
  for (const ip of [null, ...edgeIps.slice(0, 2)]) {
    const r = await httpsGet(url, ip, 8000)
    if (r.status != null) {
      status = r.status
      body = r.body
      break
    }
  }
  return judgeProbe(status, body)
}

export interface WatchdogTarget {
  id: string
  name: string
  url: string
}

export interface WatchdogHooks {
  /** 每轮要探活的服务（调用方自行过滤：desired=running 且 status=ready 且有 url） */
  targets(): WatchdogTarget[]
  /** 连续 DOWN_THRESHOLD 轮判死后回调（恢复动作由调用方接既有重连链路） */
  onDown(target: WatchdogTarget): void
  edgeIps: string[]
}

const PROBE_INTERVAL_MS = 5 * 60 * 1000
export const DOWN_THRESHOLD = 2

export function startHealthWatchdog(hooks: WatchdogHooks): { stop(): void } {
  const fails = new Map<string, number>()
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      for (const t of hooks.targets()) {
        const verdict = await probeService(t.url, hooks.edgeIps)
        if (verdict !== 'down') {
          fails.delete(t.id)
          continue
        }
        const n = (fails.get(t.id) ?? 0) + 1
        console.log(`[health] ${t.name} 探活判死 ${n}/${DOWN_THRESHOLD}（${t.url}）`)
        if (n >= DOWN_THRESHOLD) {
          fails.delete(t.id)
          hooks.onDown(t)
        } else {
          fails.set(t.id, n)
        }
      }
    })().finally(() => {
      busy = false
    })
  }, PROBE_INTERVAL_MS)
  return { stop: () => clearInterval(timer) }
}
