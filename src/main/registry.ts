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
  autoStart: boolean // TunnelDock 启动时是否自动恢复发布
  createdAt: number
}

export function genPin(): string {
  return String(randomInt(10000000, 100000000)) // 8 位数字
}

class Registry {
  private file = ''
  private cache: ServiceConfig[] = []

  init(): void {
    const dir = join(app.getPath('userData'), 'data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'services.json')
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(this.cache)) this.cache = []
    } catch {
      this.cache = []
    }
  }

  list(): ServiceConfig[] {
    return this.cache
  }

  get(id: string): ServiceConfig | undefined {
    return this.cache.find((s) => s.id === id)
  }

  add(name: string, targetHost: string, targetPort: number, pin?: string): ServiceConfig {
    const svc: ServiceConfig = {
      id: randomUUID().slice(0, 8),
      name,
      targetHost,
      targetPort,
      pin: pin || genPin(),
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
