// cloudflared 生命周期：定位二进制 → 起快隧道 → 解析公网 URL → 探活 → 可 kill
// M3：命名隧道（固定域名，需 Cloudflare 账号 + cert.pem + 自有域名）
import { spawn, ChildProcess, execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

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

// ---------- M3：命名隧道（固定域名） ----------

export function cloudflaredDir(): string {
  return join(process.env.USERPROFILE || '.', '.cloudflared')
}

export function hasOriginCert(): boolean {
  return existsSync(join(cloudflaredDir(), 'cert.pem'))
}

function cfSync(args: string[], timeoutMs = 30000): string {
  const exe = locateCloudflared()
  if (!exe) throw new Error('未找到 cloudflared')
  return execFileSync(exe, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
}

const ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** 确保（幂等）：隧道存在 + DNS 路由指向它；返回隧道 UUID */
export function ensureNamedTunnel(tunnelName: string, hostname: string): string {
  let tunnelId = ''
  try {
    const list = cfSync(['tunnel', 'list'])
    const m = list.split(/\r?\n/).find((l) => l.includes(tunnelName))
    if (m) tunnelId = (m.match(ID_RE) || [''])[0]
  } catch {
    /* list 失败按不存在处理 */
  }
  if (!tunnelId) {
    const created = cfSync(['tunnel', 'create', tunnelName])
    tunnelId = (created.match(ID_RE) || [''])[0]
    if (!tunnelId) throw new Error(`创建隧道失败：${created.slice(0, 200)}`)
  }
  // DNS 路由（已存在且指向同一隧道时 cloudflared 报错，忽略之）
  try {
    cfSync(['tunnel', 'route', 'dns', tunnelId, hostname])
  } catch (e) {
    const msg = (e as Error).message || ''
    if (!/already exists|已存在/i.test(msg)) throw e
  }
  return tunnelId
}

/** 启动命名隧道：写 ingress 配置 → cloudflared run；URL 固定为 https://hostname */
export function startNamedTunnel(opts: {
  tunnelName: string
  hostname: string
  proxyPort: number
  serviceId: string
  onLog?: (line: string) => void
  timeoutMs?: number
}): Promise<TunnelHandle> {
  const exe = locateCloudflared()
  if (!exe) return Promise.reject(new Error('未找到 cloudflared'))
  if (!hasOriginCert()) {
    return Promise.reject(new Error('尚未完成 Cloudflare 授权（cert.pem 缺失）'))
  }
  const tunnelId = ensureNamedTunnel(opts.tunnelName, opts.hostname)
  const credFile = join(cloudflaredDir(), `${tunnelId}.json`)
  const cfgDir = join(app.getPath('userData'), 'data', 'tunnels')
  mkdirSync(cfgDir, { recursive: true })
  const cfgFile = join(cfgDir, `${opts.serviceId}.yml`)
  writeFileSync(
    cfgFile,
    [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${credFile}`,
      'no-autoupdate: true',
      'ingress:',
      `  - hostname: ${opts.hostname}`,
      `    service: http://127.0.0.1:${opts.proxyPort}`,
      '  - service: http_status:404',
      ''
    ].join('\n'),
    'utf8'
  )
  return new Promise<TunnelHandle>((resolve, reject) => {
    const child = spawn(exe, ['tunnel', '--config', cfgFile, 'run'], { windowsHide: true })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('命名隧道 60 秒内未注册成功'))
    }, opts.timeoutMs ?? 60000)
    const onData = (d: Buffer): void => {
      const text = d.toString()
      for (const line of text.split(/\r?\n/)) {
        if (/ERR|Registered|Failed/i.test(line)) opts.onLog?.(line.trim().slice(0, 200))
      }
      if (!settled && /Registered tunnel connection/i.test(text)) {
        settled = true
        clearTimeout(timer)
        resolve({ url: `https://${opts.hostname}`, child })
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

/** 供外部检查登录状态用 */
export function waitForCert(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      if (hasOriginCert()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 1500)
    }
    tick()
  })
}
