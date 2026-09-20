// cloudflared 生命周期：定位二进制 → 起快隧道 → 解析公网 URL → 探活 → 可 kill
// M3：命名隧道（固定域名，需 Cloudflare 账号 + cert.pem + 自有域名）
import { spawn, ChildProcess, execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { QUICK_URL_RE } from './validate'

export interface TunnelHandle {
  url: string
  child: ChildProcess
}

const CANDIDATES = [
  process.env.TUNNELDOCK_CLOUDFLARED, // 用户/开发环境指定
  app.isPackaged ? join(process.resourcesPath, 'cloudflared.exe') : null, // 安装包内置
  join(process.env.USERPROFILE || '.', '.cloudflared', 'cloudflared.exe'), // 本机现成二进制（开发期）
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

// Quick Tunnel 地址正则见 ./validate（QUICK_URL_RE，附排除 api.trycloudflare.com 的原因）

export function startTunnel(
  proxyPort: number,
  timeoutMs = 60000,
  onLog?: (line: string) => void,
  forceHttp2 = false
): Promise<TunnelHandle> {
  const exe = locateCloudflared()
  if (!exe) {
    return Promise.reject(new Error('未找到 cloudflared（可设置环境变量 TUNNELDOCK_CLOUDFLARED 指定路径）'))
  }
  onLog?.(`启动 cloudflared: ${exe} -> 127.0.0.1:${proxyPort}${forceHttp2 ? '（http2/TCP）' : ''}`)
  return new Promise<TunnelHandle>((resolve, reject) => {
    const args = ['tunnel']
    if (forceHttp2) args.push('--protocol', 'http2') // UDP/QUIC 被网络掐死时走纯 TCP
    args.push('--url', `http://127.0.0.1:${proxyPort}`, '--no-autoupdate')
    const child = spawn(exe, args, {
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
      const text = d.toString()
      // 关键行透传（ERR / 隧道地址），全量日志太大
      for (const line of text.split(/\r?\n/)) {
        if (/ERR|trycloudflare\.com|Register|failed/i.test(line)) onLog?.(line.trim().slice(0, 200))
      }
      // 地址拿到后不再累积缓冲：cloudflared 常驻数天日志不断，无界 += 是内存泄漏
      if (settled) return
      buf += text
      if (buf.length > 262144) buf = buf.slice(-131072) // 兜底：只留尾部，正则窗口足够
      const m = buf.match(QUICK_URL_RE)
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

/** 按名字找隧道 UUID；词边界匹配防 8 位短 id 前缀撞车（tunneldock-ab 匹配到 tunneldock-abc） */
function findTunnelId(tunnelName: string): string {
  try {
    const list = cfSync(['tunnel', 'list'])
    const re = new RegExp(`${tunnelName}\\b`)
    const line = list.split(/\r?\n/).find((l) => re.test(l))
    return (line?.match(ID_RE) || [''])[0]
  } catch {
    return '' // list 失败按不存在处理
  }
}

/** 确保（幂等）：隧道存在 + DNS 路由指向它；返回隧道 UUID */
export function ensureNamedTunnel(tunnelName: string, hostname: string): string {
  let tunnelId = findTunnelId(tunnelName)
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

/** 删除 Cloudflare 侧隧道对象（cloudflared CLI 不支持删 DNS 记录——CNAME 会残留，
 *  但重新绑定同域名时 route dns -f 会自动覆盖，无需手动清理） */
export function deleteNamedTunnel(tunnelName: string): void {
  const tunnelId = findTunnelId(tunnelName)
  if (!tunnelId) return
  cfSync(['tunnel', 'delete', '-f', tunnelId])
}

/** 命名隧道 ingress 配置目录（与服务注册表同放 userData\data） */
export function tunnelsDir(): string {
  return join(app.getPath('userData'), 'data', 'tunnels')
}

/** 启动时清扫孤儿 cloudflared：上次异常退出可能留下带我们 ingress 配置的进程。
 *  判定 = 命中本实例配置路径 **且** 父进程已死（Windows 无进程收养，父 PID 恒定不漂移）。
 *  双条件缺一不可：开发实例与安装版可能共用同一 userData（Windows 大小写不敏感，
 *  TunnelDock/tunneldock 是同一目录），仅凭路径匹配会误杀正在服务的其他实例；
 *  仅凭父死判定则会误伤用户手动跑着的 cloudflared。 */
export function sweepOrphanTunnels(): void {
  try {
    const marker = join(app.getPath('userData'), 'data', 'tunnels')
    const psMarker = marker.replace(/'/g, "''") // PS 单引号转义
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$m = '${psMarker}'; $p = @(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }); $p.Count; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    )
    const n = Number((out.match(/\d+/) || ['0'])[0])
    if (n > 0) console.log(`[sweep] 清理了 ${n} 个残留 cloudflared 进程`)
  } catch {
    /* 清扫失败不阻塞启动 */
  }
}

/** 启动命名隧道：写 ingress 配置 → cloudflared run；URL 固定为 https://hostname */
export function startNamedTunnel(opts: {
  tunnelName: string
  hostname: string
  proxyPort: number
  serviceId: string
  onLog?: (line: string) => void
  timeoutMs?: number
  forceHttp2?: boolean
}): Promise<TunnelHandle> {
  const exe = locateCloudflared()
  if (!exe) return Promise.reject(new Error('未找到 cloudflared'))
  if (!hasOriginCert()) {
    return Promise.reject(new Error('尚未完成 Cloudflare 授权（cert.pem 缺失）'))
  }
  const tunnelId = ensureNamedTunnel(opts.tunnelName, opts.hostname)
  const credFile = join(cloudflaredDir(), `${tunnelId}.json`)
  const cfgDir = tunnelsDir()
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
    const runArgs = ['tunnel', '--config', cfgFile]
    if (opts.forceHttp2) runArgs.push('--protocol', 'http2')
    runArgs.push('run')
    const child = spawn(exe, runArgs, { windowsHide: true })
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
