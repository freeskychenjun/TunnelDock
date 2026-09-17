// cloudflared 生命周期：定位二进制 → 起快隧道 → 解析公网 URL → 探活 → 可 kill
import { spawn, ChildProcess, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface TunnelHandle {
  url: string
  child: ChildProcess
}

const CANDIDATES = [
  process.env.TUNNELDOCK_CLOUDFLARED, // 用户/开发环境指定
  app.isPackaged ? join(process.resourcesPath, 'cloudflared.exe') : null, // 安装包内置
  'C:\\Users\\Administrator\\.cloudflared\\cloudflared.exe', // 本机现成二进制（开发期）
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
].filter(Boolean) as string[]

export function locateCloudflared(): string | null {
  for (const p of CANDIDATES) {
    if (existsSync(p)) return p
  }
  try {
    const out = execFileSync('where', ['cloudflared'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const first = out.split(/\r?\n/)[0]?.trim()
    if (first && existsSync(first)) return first
  } catch {
    /* PATH 上没有 */
  }
  return null
}

// Quick Tunnel 主机名固定是多词形式（如 dominant-instruction-enb-lime）；
// 单词的 api.trycloudflare.com 是 Cloudflare 自家 API 端点，会出现在日志里，必须排除
const URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com/

export function startTunnel(
  proxyPort: number,
  timeoutMs = 60000,
  onLog?: (line: string) => void
): Promise<TunnelHandle> {
  const exe = locateCloudflared()
  if (!exe) {
    return Promise.reject(new Error('未找到 cloudflared（可设置环境变量 TUNNELDOCK_CLOUDFLARED 指定路径）'))
  }
  onLog?.(`启动 cloudflared: ${exe} -> 127.0.0.1:${proxyPort}`)
  return new Promise<TunnelHandle>((resolve, reject) => {
    const child = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${proxyPort}`, '--no-autoupdate'], {
      windowsHide: true
    })
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('60 秒内未取得公网地址（cloudflared 无输出）'))
    }, timeoutMs)

    const onData = (d: Buffer): void => {
      buf += d.toString()
      // 关键行透传（ERR / 隧道地址），全量日志太大
      for (const line of d.toString().split(/\r?\n/)) {
        if (/ERR|trycloudflare\.com|Register|failed/i.test(line)) onLog?.(line.trim().slice(0, 200))
      }
      const m = buf.match(URL_RE)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ url: m[0], child })
      }
    }
    child.stderr?.on('data', onData)
    child.stdout?.on('data', onData)
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 启动失败: ${e.message}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 提前退出（code ${code}）`))
    })
  })
}

/** URL 打印出来后边缘节点还要几秒才可达：轮询探活。
 *  expectText：要求响应正文包含该片段（如登录页特征），防止把日志里的无关域名误当隧道地址。 */
export async function probeReady(url: string, timeoutMs = 30000, expectText?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      if (res.status < 500) {
        if (!expectText) return
        const body = await res.text()
        if (body.includes(expectText)) return
        lastErr = '响应不含期望特征'
      } else {
        lastErr = `HTTP ${res.status}`
      }
    } catch (e) {
      lastErr = (e as Error).message
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`公网地址 ${url} 探活超时（${lastErr}）`)
}

export function stopTunnel(child: ChildProcess): void {
  try {
    child.kill()
  } catch {
    /* 已退出 */
  }
}
