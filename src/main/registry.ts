// 服务配置持久化：JSON 原子写（临时文件 + rename），防半截文件
import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID, randomInt } from 'crypto'

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

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/ // 主机名或 IPv4

class Registry {
  private file = ''
  private cache: ServiceConfig[] = []

  init(): void {
    const dir = join(app.getPath('userData'), 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'services.json')
    try {
      const raw = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '') // 容错 BOM
      const parsed: unknown = JSON.parse(raw)
      // 容错：单对象（外部工具改写常见）也当作一条记录
      this.cache = Array.isArray(parsed) ? (parsed as ServiceConfig[]) : [parsed as ServiceConfig]
      this.cache = this.cache.filter((s) => s && typeof s.id === 'string')
    } catch {
      this.cache = []
    }
    // 自愈：历史数据里的 host 可能带协议头/路径（用户整段粘贴 URL 所致）；补缺省 hostname
    let dirty = false
    for (const s of this.cache) {
      const fixed = normalizeHost(s.targetHost)
      if (fixed && fixed !== s.targetHost && HOST_RE.test(fixed)) {
        s.targetHost = fixed
        dirty = true
      }
      if (typeof s.hostname !== 'string') {
        s.hostname = ''
        dirty = true
      }
      if (typeof s.tokenFile !== 'string') {
        s.tokenFile = ''
        dirty = true
      }
    }
    if (dirty) this.save()
  }

  list(): ServiceConfig[] {
    return this.cache
  }

  get(id: string): ServiceConfig | undefined {
    return this.cache.find((s) => s.id === id)
  }

  add(name: string, targetHostRaw: string, targetPort: number, pin?: string): ServiceConfig {
    const targetHost = normalizeHost(targetHostRaw)
    if (!targetHost || !HOST_RE.test(targetHost)) {
      throw new Error('目标地址格式不对：填主机名或 IP（如 127.0.0.1），不要带 http:// 和路径')
    }
    const svc: ServiceConfig = {
      id: randomUUID().slice(0, 8),
      name,
      targetHost,
      targetPort,
      pin: pin || genPin(),
      hostname: '',
      tokenFile: '',
      autoStart: true, // 默认：随 TunnelDock 启动自动恢复
      createdAt: Date.now()
    }
    this.cache.push(svc)
    this.save()
    return svc
  }

  update(id: string, patch: Partial<ServiceConfig>): ServiceConfig | undefined {
    const svc = this.get(id)
    if (!svc) return undefined
    Object.assign(svc, patch)
    this.save()
    return svc
  }

  remove(id: string): boolean {
    const before = this.cache.length
    this.cache = this.cache.filter((s) => s.id !== id)
    if (this.cache.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

export const registry = new Registry()
