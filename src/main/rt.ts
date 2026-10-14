/**
 * RT（反向隧道）编排：Cloudflare 账号存储 + 一键部署 + PINS 同步
 *
 * 账号数据 %APPDATA%\TunnelDock\data\account.json：
 *   token 用 Electron safeStorage（DPAPI）加密后 base64 落盘；不可用时退化为明文并标注
 *   agentSecret 每安装实例一份随机（部署时生成，Worker env 与本地各一份）
 *
 * 部署一次成型：DNS（每服务子域 A 192.0.2.1 proxied）→ Worker（DO+vars）→
 * zone 级路由 {zone}/*。服务增删/改 PIN 后调 syncPins() 重部署 vars（秒级）。
 */
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import workerCode from '../worker/tunnel.js?raw'
import { registry } from './registry'
import {
  verifyToken, listAccounts, listZones, upsertSubdomain, deleteDnsRecord,
  deployWorker, ensureRoute, deleteWorker, PinsJson, CfZone, CfAccount
} from './cloudapi'
import type { RtStatus } from '../shared/types'

export const SCRIPT_NAME = 'tunneldock-rt'
/** 实测可达的 CF 边缘 IP（进程内钉 IP；顺序即优先级）。
 *  M2b/M3 实测：162.159.136.4 全双工可靠；162.159.135.233 在本网络为"半瘫边缘"
 *  （HTTP 下行正常但上行/WS 中转丢）——hello-ack 体检会自动剔除，这里也放最后。 */
export const EDGE_IPS = ['162.159.136.4', '104.16.9.34', '162.159.140.102', '162.159.135.233']

export interface RtAccount {
  tokenEnc: string // safeStorage 加密 + base64；或明文（plainToken 兜底标记）
  plainToken?: boolean
  dnsTokenEnc?: string // 可选独立 DNS Token（权限拆分场景：主 Token 无 DNS Edit 时用）
  plainDnsToken?: boolean
  accountId: string
  accountName: string
  zoneId: string
  zoneName: string
  agentSecret: string
}

let account: RtAccount | null = null
let accountFile = ''

export function initRtAccount(): void {
  accountFile = join(app.getPath('userData'), 'data', 'account.json')
  try {
    const raw = readFileSync(accountFile, 'utf8').replace(/^\uFEFF/, '')
    account = JSON.parse(raw) as RtAccount
  } catch {
    account = null
  }
}

export function getRtAccount(): RtAccount | null {
  return account
}

/** 解出 API Token（内存中短存，不落盘明文） */
export function rtToken(): string | null {
  if (!account) return null
  if (account.plainToken) return account.tokenEnc
  try {
    return safeStorage.decryptString(Buffer.from(account.tokenEnc, 'base64'))
  } catch {
    return null
  }
}

/** 解出 DNS Token（独立配置时用之；否则回退主 Token） */
export function rtDnsToken(): string | null {
  if (!account) return null
  const enc = account.dnsTokenEnc
  if (!enc) return rtToken()
  if (account.plainDnsToken) return enc
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

function encodeToken(token: string): { tokenEnc: string; plainToken?: boolean } {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { tokenEnc: safeStorage.encryptString(token).toString('base64') }
    }
  } catch {
    /* 退化明文 */
  }
  return { tokenEnc: token, plainToken: true }
}

function saveAccount(acc: RtAccount | null): void {
  account = acc
  if (acc) writeFileSync(accountFile, JSON.stringify(acc, null, 2), 'utf8')
  else if (existsSync(accountFile)) writeFileSync(accountFile, '', 'utf8')
}

/** 第一步：验证 Token，返回账号与可选 zone 列表（向导选 zone 用） */
export async function rtSetup(token: string, dnsToken?: string): Promise<{ accounts: CfAccount[]; zones: CfZone[] }> {
  const token2 = String(token || '').trim()
  if (!token2) throw new Error('请先粘贴 API Token')
  await verifyToken(token2)
  const accounts = await listAccounts(token2)
  if (accounts.length === 0) throw new Error('Token 有效但读不到账号（缺 Account 权限？）')
  const zones = await listZones(token2)
  if (zones.length === 0) throw new Error('该账号下没有活跃域名（zone），先在 Cloudflare 添加域名')
  if (dnsToken && dnsToken.trim()) {
    await verifyToken(String(dnsToken).trim()) // DNS Token 只需有效即可（权限在部署时才真正用到）
  }
  return { accounts, zones }
}

/** 第二步：选定 zone 后全量部署（幂等，可反复执行） */
export async function rtDeploy(token: string, zoneId: string, dnsToken?: string): Promise<RtStatus> {
  const token2 = String(token || '').trim()
  const dnsToken2 = String(dnsToken || '').trim() || token2
  const zones = await listZones(token2)
  const zone = zones.find((z) => z.id === zoneId)
  if (!zone) throw new Error('zone 不存在或不可用')
  const accounts = await listAccounts(token2)
  if (accounts.length === 0) throw new Error('读不到账号 id')
  const prev = account

  const acc: RtAccount = {
    ...encodeToken(token2),
    ...(dnsToken2 !== token2 ? encodeDnsToken(dnsToken2) : {}),
    accountId: accounts[0].id,
    accountName: accounts[0].name,
    zoneId: zone.id,
    zoneName: zone.name,
    agentSecret: prev?.agentSecret || randomBytes(24).toString('hex')
  }

  // 1. 给所有 wss 服务分配子域名并建 DNS（hostname 保持在 services.json，长期稳定）
  for (const svc of registry.list()) {
    if (svc.transport !== 'wss') continue
    if (!svc.hostname) {
      registry.update(svc.id, { hostname: `${svc.id}.${zone.name}` })
    }
  }
  const pins = buildPins()
  for (const hostname of Object.keys(pins)) {
    await upsertSubdomain(dnsToken2, zone.id, hostname)
  }

  // 2. Worker + zone 级路由
  await deployWorker({
    token: token2, accountId: acc.accountId, scriptName: SCRIPT_NAME,
    workerCode, pins, agentSecret: acc.agentSecret
  })
  await ensureRoute(token2, zone.id, `${zone.name}/*`, SCRIPT_NAME)

  saveAccount(acc)
  return rtStatus()
}

function encodeDnsToken(token: string): { dnsTokenEnc: string; plainDnsToken?: boolean } {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { dnsTokenEnc: safeStorage.encryptString(token).toString('base64') }
    }
  } catch {
    /* 退化明文 */
  }
  return { dnsTokenEnc: token, plainDnsToken: true }
}

/** 服务增删/改 PIN/改传输模式后同步 PINS（重部署 vars，秒级；不碰路由） */
export async function syncPins(): Promise<void> {
  const acc = getRtAccount()
  const token = rtToken()
  const dnsToken = rtDnsToken()
  if (!acc || !token) return
  const pins = buildPins()
  // 新 hostname 补 DNS
  for (const hostname of Object.keys(pins)) {
    await upsertSubdomain(dnsToken || token, acc.zoneId, hostname)
  }
  await deployWorker({
    token, accountId: acc.accountId, scriptName: SCRIPT_NAME,
    workerCode, pins, agentSecret: acc.agentSecret
  })
}

function buildPins(): PinsJson {
  const pins: PinsJson = {}
  for (const svc of registry.list()) {
    if (svc.transport !== 'wss' || !svc.hostname) continue
    pins[svc.hostname] = { sid: svc.id, pin: svc.pin }
  }
  return pins
}

export function rtStatus(): RtStatus {
  const configured = !!account
  const serviceCount = registry.list().filter((s) => s.transport === 'wss').length
  return {
    configured,
    zoneName: account?.zoneName,
    scriptName: configured ? SCRIPT_NAME : undefined,
    serviceCount
  }
}

/** 解绑：清本地账号（云端 Worker/DNS 保留——重装可无缝接管） */
export function rtForget(): RtStatus {
  saveAccount(null)
  return rtStatus()
}

/** 彻底清理云端资源（删除 wss 服务的 DNS 记录 + Worker） */
export async function rtPurgeCloud(): Promise<void> {
  const acc = getRtAccount()
  const token = rtToken()
  if (!acc || !token) throw new Error('尚未配置反向隧道')
  for (const svc of registry.list()) {
    if (svc.transport === 'wss' && svc.hostname) {
      try {
        await deleteDnsRecord(rtDnsToken() || token, acc.zoneId, svc.hostname)
      } catch {
        /* 单条失败不阻塞 */
      }
    }
  }
  await deleteWorker(token, acc.accountId, SCRIPT_NAME)
}
