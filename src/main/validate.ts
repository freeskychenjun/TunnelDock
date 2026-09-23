// 纯函数与常量（不 import electron，供 node:test 直接驱动）
import { randomInt } from 'crypto'

export function genPin(): string {
  return String(randomInt(10000000, 100000000)) // 8 位数字
}

// 目标地址归一化：容错用户输入（剥协议头/路径/空白，转小写）
// "http://172.14.60.197/" → "172.14.60.197"
export function normalizeHost(input: string): string {
  let s = String(input || '').trim()
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '') // http:// https:// 等
  s = s.replace(/\/.*$/, '') // 路径
  s = s.replace(/:\d+$/, '') // 端口（端口应填在端口框；这里避免拼进 host）
  return s.toLowerCase()
}

export const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/ // 主机名或 IPv4

// Quick Tunnel 主机名固定是多词形式（如 dominant-instruction-enb-lime）；
// 单词的 api.trycloudflare.com 是 Cloudflare 自家 API 端点，会出现在日志里，必须排除
export const QUICK_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com/

// 命名隧道 ingress yml（tunnel.ts 生成）解析：免 API 重启时从本地配置恢复隧道 UUID 与域名。
// 任何字段缺失/不合法都返回 null，调用方回落到走 CF API 的完整 ensure
export function parseTunnelYml(text: string): { tunnelId: string; hostname: string } | null {
  const tunnelId = (text.match(/^tunnel:\s*(\S+)$/m) || [])[1] ?? ''
  const hostname = (text.match(/^\s*-\s*hostname:\s*(\S+)$/m) || [])[1] ?? ''
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return UUID_RE.test(tunnelId) && hostname ? { tunnelId, hostname } : null
}
