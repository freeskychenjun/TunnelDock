/**
 * Cloudflare API v4 客户端（反向隧道部署用）
 *
 * 纯 Node 18+ fetch，零第三方依赖。职责：
 *  - Token 校验 / 账号与 zone 发现
 *  - DNS 记录增删（A 192.0.2.1 proxied——流量由 Worker Route 接管，IP 只是占位）
 *  - Worker script 上传（multipart module 语法，含 DO binding + vars + routes）
 *
 * Token 权限要求（向导引导用户创建时写明）：
 *  - Zone / DNS / Edit（建子域名记录）
 *  - Zone / Workers Routes / Edit（绑定路由）
 *  - Account / Workers Scripts / Edit（上传 Worker）
 */

const API = 'https://api.cloudflare.com/client/v4'

/** api.cloudflare.com 在部分国内网络下默认解析不可达：允许注入备选直连 IP（钉住 162.159.136.4 等） */
export const API_EDGE_IPS = ['162.159.136.4', '104.16.9.34', '162.159.135.233', '162.159.140.102']

export class CloudApiError extends Error {
  constructor(message: string, readonly status: number, readonly errors?: Array<{ code: number; message: string }>) {
    super(message)
  }
}

export interface CfAccount {
  id: string
  name: string
}

export interface CfZone {
  id: string
  name: string
}

async function cfFetch(
  token: string,
  path: string,
  init: RequestInit = {},
  directIp?: string
): Promise<unknown> {
  const url = new URL(API + path)
  // 进程内“钉 IP”：host 用备选边缘 IP、SNI/Host 头保持 api.cloudflare.com
  if (directIp) {
    const disp = new URL(url)
    url.hostname = directIp
    url.port = ''
    url.protocol = 'https:'
    const headers = new Headers(init.headers)
    headers.set('Host', disp.host)
    init = { ...init, headers }
  }
  init = {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined)
    }
  }
  let resp: Response
  try {
    resp = await fetch(url.toString(), init)
  } catch (e) {
    // 默认解析不可达 → 依次试备选边缘 IP
    if (!directIp) {
      for (const ip of API_EDGE_IPS) {
        try {
          return await cfFetch(token, path, init, ip)
        } catch {
          /* 试下一个 */
        }
      }
    }
    throw new CloudApiError(`网络请求失败：${(e as Error).message}`, 0)
  }
  if (resp.status === 204) return null
  const text = await resp.text()
  let json: { success?: boolean; errors?: Array<{ code: number; message: string }>; result?: unknown } | null = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应（如 5xx 页面） */
  }
  if (!resp.ok || (json && json.success === false)) {
    const errs = json?.errors
    const msg = errs?.length ? errs.map((x) => `${x.code}: ${x.message}`).join('; ') : `HTTP ${resp.status}: ${text.slice(0, 200)}`
    throw new CloudApiError(`Cloudflare API ${path} 失败：${msg}`, resp.status, errs)
  }
  return json ? json.result : null
}

/** 校验 Token 并返回有效状态 */
export async function verifyToken(token: string): Promise<void> {
  // /user/tokens/verify 不带账号维度，用 GET /accounts 顺带拿账号 id
  await cfFetch(token, '/accounts?per_page=5')
}

export async function listAccounts(token: string): Promise<CfAccount[]> {
  const r = (await cfFetch(token, '/accounts?per_page=50')) as CfAccount[]
  return r ?? []
}

export async function listZones(token: string): Promise<CfZone[]> {
  const r = (await cfFetch(token, '/zones?per_page=50&status=active')) as CfZone[]
  return r ?? []
}

/** 幂等创建子域名 A 记录（proxied 橙云）。返回记录 id。 */
export async function upsertSubdomain(
  token: string,
  zoneId: string,
  hostname: string
): Promise<string> {
  const existing = (await cfFetch(
    token,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}&per_page=5`
  )) as Array<{ id: string; content: string; proxied: boolean }>
  const want = { type: 'A', name: hostname, content: '192.0.2.1', proxied: true, ttl: 1 }
  if (existing && existing.length > 0) {
    const rec = existing[0]
    if (rec.content === want.content && rec.proxied) return rec.id
    const upd = (await cfFetch(token, `/zones/${zoneId}/dns_records/${rec.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(want)
    })) as { id: string }
    return upd.id
  }
  const cre = (await cfFetch(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(want)
  })) as { id: string }
  return cre.id
}

export async function deleteDnsRecord(token: string, zoneId: string, hostname: string): Promise<boolean> {
  const existing = (await cfFetch(
    token,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}&per_page=5`
  )) as Array<{ id: string }> | null
  if (!existing || existing.length === 0) return false
  for (const rec of existing) {
    await cfFetch(token, `/zones/${zoneId}/dns_records/${rec.id}`, { method: 'DELETE' })
  }
  return true
}

export interface ServicePinEntry {
  sid: string
  pin: string
}

/** PINS_JSON: hostname → { sid, pin } */
export type PinsJson = Record<string, ServicePinEntry>

export interface DeployWorkerOptions {
  token: string
  accountId: string
  zoneId: string
  scriptName: string // 如 tunneldock-rt
  workerCode: string // src/worker/tunnel.js 的完整源码（ES module）
  pins: PinsJson
  agentSecret: string
  zoneName: string
}

/**
 * 上传/更新 Worker（module 语法 multipart），绑定 DO + vars + 全 zone 路由。
 * 路由用 {zoneName}/* 兜底（未匹配 PINS_JSON 的 host 由 Worker 返回 404），
 * 精确子域路由随子域增删频繁变更，统一走兜底最稳。
 */
export async function deployWorker(opts: DeployWorkerOptions): Promise<void> {
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-09-01',
    bindings: [
      { type: 'durable_object_namespace', name: 'TUNNEL', class_name: 'Tunnel' },
      { type: 'plain_text', name: 'AGENT_SECRET', text: opts.agentSecret },
      { type: 'plain_text', name: 'PINS_JSON', text: JSON.stringify(opts.pins) }
    ],
    routes: [{ pattern: `${opts.zoneName}/*`, zone_name: opts.zoneName }]
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
  form.append('worker.js', new Blob([opts.workerCode], { type: 'application/javascript+module' }), 'worker.js')
  await cfFetch(opts.token, `/accounts/${opts.accountId}/workers/scripts/${opts.scriptName}`, {
    method: 'PUT',
    body: form
  })
}

export async function deleteWorker(token: string, accountId: string, scriptName: string): Promise<void> {
  await cfFetch(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, { method: 'DELETE' })
}
