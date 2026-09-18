<script setup lang="ts">
import { ref, onMounted } from 'vue'
import QRCode from 'qrcode'

const services = ref<ServiceConfig[]>([])
const states = ref<Record<string, ServiceState>>({})
const showCreate = ref(false)
const qr = ref<{ url: string; name: string; pin: string; dataUrl: string } | null>(null)
const pinEdit = ref<{ id: string; name: string; value: string } | null>(null)
const hostEdit = ref<{ id: string; name: string; value: string } | null>(null)
const form = ref({ name: '', host: '127.0.0.1', port: '', pin: '', hostname: '' })
const busy = ref(false)
const toast = ref('')
const appAutostart = ref(false)
const hasCert = ref(false)

function showToast(msg: string): void {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 2200)
}

function stateOf(id: string): ServiceState {
  return states.value[id] || { id, status: 'idle', url: null, error: null, attempt: 0 }
}

async function refresh(): Promise<void> {
  services.value = await window.tunneldock.list()
  const st = await window.tunneldock.states()
  const m: Record<string, ServiceState> = {}
  for (const s of st) m[s.id] = s
  states.value = m
}

onMounted(async () => {
  void refresh()
  appAutostart.value = await window.tunneldock.getAppAutostart()
  hasCert.value = await window.tunneldock.hasOriginCert()
  window.tunneldock.onEvent((st) => {
    const m: Record<string, ServiceState> = {}
    for (const s of st) m[s.id] = s
    states.value = m
  })
})

async function createService(): Promise<void> {
  const port = Number(form.value.port)
  if (!form.value.name.trim() || !form.value.host.trim() || !(port > 0 && port < 65536)) {
    showToast('名称 / 地址 / 端口 都要填对')
    return
  }
  const pin = form.value.pin.trim()
  if (pin && !/^[0-9A-Za-z@#$%^&*-]{6,32}$/.test(pin)) {
    showToast('自定义口令需 6-32 位（字母/数字/@#$%^&*-）')
    return
  }
  const hostname = form.value.hostname.trim().toLowerCase()
  if (hostname && !hasCert.value) {
    showToast('固定域名需先完成 Cloudflare 授权（联系开发者运行 tunnel login）')
    return
  }
  busy.value = true
  try {
    await window.tunneldock.create({
      name: form.value.name.trim(),
      targetHost: form.value.host.trim(),
      targetPort: port,
      pin: pin || undefined
    })
    showCreate.value = false
    form.value = { name: '', host: '127.0.0.1', port: '', pin: '', hostname: '' }
    await refresh()
    showToast('已创建，点「启动」发布到公网')
  } catch (e) {
    showToast((e as Error).message)
  } finally {
    busy.value = false
  }
}

async function saveHostname(): Promise<void> {
  if (!hostEdit.value) return
  try {
    await window.tunneldock.setHostname(hostEdit.value.id, hostEdit.value.value.trim())
    showToast('域名已更新（运行中的发布已停止，需重新启动）')
    hostEdit.value = null
    await refresh()
  } catch (e) {
    showToast((e as Error).message)
  }
}

async function start(id: string): Promise<void> {
  try {
    await window.tunneldock.start(id)
  } catch (e) {
    showToast(`启动失败：${(e as Error).message}`)
  }
}

async function stop(id: string): Promise<void> {
  await window.tunneldock.stop(id)
  showToast('已停止，公网入口关闭')
}

async function removeSvc(id: string): Promise<void> {
  await window.tunneldock.remove(id)
  await refresh()
}

async function resetPin(id: string): Promise<void> {
  await window.tunneldock.resetPin(id)
  await refresh()
  showToast('PIN 已重置（运行中的发布已停止，需重新启动）')
}

async function savePin(): Promise<void> {
  if (!pinEdit.value) return
  try {
    await window.tunneldock.setPin(pinEdit.value.id, pinEdit.value.value.trim())
    showToast('口令已改（运行中的发布已停止，需重新启动）')
    pinEdit.value = null
    await refresh()
  } catch (e) {
    showToast((e as Error).message)
  }
}

async function toggleAutoStart(svc: ServiceConfig): Promise<void> {
  await window.tunneldock.setAutoStart(svc.id, !svc.autoStart)
  await refresh()
}

async function toggleAppAutostart(): Promise<void> {
  appAutostart.value = await window.tunneldock.setAppAutostart(!appAutostart.value)
  showToast(appAutostart.value ? 'TunnelDock 将随开机静默启动并恢复发布' : '已关闭开机自启')
}

async function showQr(svc: ServiceConfig): Promise<void> {
  const st = stateOf(svc.id)
  if (!st.url) return
  const dataUrl = await QRCode.toDataURL(st.url, { width: 240, margin: 2 })
  qr.value = { url: st.url, name: svc.name, pin: svc.pin, dataUrl }
}

async function copy(text: string, what: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  showToast(`${what}已复制`)
}

const STATUS_TEXT: Record<string, string> = {
  idle: '未启动',
  starting: '发布中…',
  ready: '公网在线',
  error: '出错',
  stopping: '停止中…'
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <span class="logo">⚓</span>
      <span class="title">TunnelDock <small>隧道坞</small></span>
      <span class="ver">v0.2.0 · M2</span>
    </header>

    <main class="body">
      <div class="toolbar">
        <label class="switcher">
          <input type="checkbox" :checked="appAutostart" @change="toggleAppAutostart" />
          开机自启并恢复发布
        </label>
        <span class="hint">每个发布独立 PIN 保护 · 断线自动重连</span>
        <button class="primary" @click="showCreate = true">＋ 新建发布</button>
      </div>

      <div v-if="services.length === 0" class="empty">
        <p class="big">还没有发布</p>
        <p>点右上角「新建发布」，填服务名和本机端口（如 127.0.0.1:5173）</p>
      </div>

      <div v-for="svc in services" :key="svc.id" class="card" :data-status="stateOf(svc.id).status">
        <div class="row1">
          <span class="name">{{ svc.name }}</span>
          <span class="target">{{ svc.targetHost }}:{{ svc.targetPort }}</span>
          <span class="badge">{{ STATUS_TEXT[stateOf(svc.id).status] }}</span>
        </div>

        <div v-if="stateOf(svc.id).url" class="row2">
          <code class="url">{{ stateOf(svc.id).url }}</code>
          <button class="mini" @click="copy(stateOf(svc.id).url!, '地址')">复制</button>
          <button class="mini" @click="showQr(svc)">二维码</button>
        </div>
        <div v-if="stateOf(svc.id).status === 'starting'" class="row2 muted">
          {{ stateOf(svc.id).attempt > 0 ? `重连中（第 ${stateOf(svc.id).attempt} 次）` : '正在建立隧道（约 10-30 秒）' }}{{ stateOf(svc.id).error ? ' · ' + stateOf(svc.id).error : '' }}…
        </div>
        <div v-if="stateOf(svc.id).status === 'error'" class="row2 err">{{ stateOf(svc.id).error }}</div>

        <div class="row3">
          <span class="pin">口令 <code>{{ svc.pin }}</code></span>
          <button class="mini ghost" @click="copy(svc.pin, '口令')">复制</button>
          <button class="mini ghost" @click="pinEdit = { id: svc.id, name: svc.name, value: '' }">改口令</button>
          <button class="mini ghost" @click="resetPin(svc.id)">重置8位PIN</button>
          <button class="mini ghost" :title="svc.hostname ? '修改固定域名' : '绑定固定域名（需 Cloudflare 授权）'" @click="hostEdit = { id: svc.id, name: svc.name, value: svc.hostname }">
            {{ svc.hostname ? '改域名' : '设域名' }}
          </button>
          <span v-if="svc.hostname" class="hosttag">🔒 {{ svc.hostname }}</span>
          <span class="spacer" />
          <label class="switcher small" title="TunnelDock 启动时自动恢复此发布">
            <input type="checkbox" :checked="svc.autoStart" @change="toggleAutoStart(svc)" /> 自启
          </label>
          <button v-if="['idle', 'error'].includes(stateOf(svc.id).status)" class="mini run" @click="start(svc.id)">启动</button>
          <button v-else-if="stateOf(svc.id).status === 'ready'" class="mini stop" @click="stop(svc.id)">停止</button>
          <button class="mini danger" @click="removeSvc(svc.id)">删除</button>
        </div>
      </div>
    </main>

    <!-- 新建 -->
    <div v-if="showCreate" class="mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>新建发布</h3>
        <label>服务名称</label>
        <input v-model="form.name" placeholder="如：Home Assistant" />
        <label>目标地址</label>
        <input v-model="form.host" placeholder="127.0.0.1" />
        <label>目标端口</label>
        <input v-model="form.port" placeholder="如 5173" inputmode="numeric" />
        <label>访问口令（留空 = 自动生成 8 位 PIN）</label>
        <input v-model="form.pin" placeholder="至少 6 位" />
        <div class="actions">
          <button class="mini" @click="showCreate = false">取消</button>
          <button class="primary" :disabled="busy" @click="createService">创建</button>
        </div>
      </div>
    </div>

    <!-- 改口令 -->
    <div v-if="pinEdit" class="mask" @click.self="pinEdit = null">
      <div class="modal">
        <h3>修改口令 · {{ pinEdit.name }}</h3>
        <label>新口令（6-32 位，字母/数字/@#$%^&*-）</label>
        <input v-model="pinEdit.value" placeholder="新口令" />
        <div class="actions">
          <button class="mini" @click="pinEdit = null">取消</button>
          <button class="primary" @click="savePin">保存</button>
        </div>
      </div>
    </div>

    <!-- 设域名（命名隧道 = 固定地址） -->
    <div v-if="hostEdit" class="mask" @click.self="hostEdit = null">
      <div class="modal">
        <h3>固定域名 · {{ hostEdit.name }}</h3>
        <label>域名（如 pi.example.com；留空 = 用免费临时地址）</label>
        <input v-model="hostEdit.value" placeholder="pi.example.com" />
        <p class="hintbox">绑定后地址永久固定，重启/断线重连都不变，手机可收藏。</p>
        <div class="actions">
          <button class="mini" @click="hostEdit = null">取消</button>
          <button class="primary" @click="saveHostname">保存</button>
        </div>
      </div>
    </div>

    <!-- 二维码 -->
    <div v-if="qr" class="mask" @click.self="qr = null">
      <div class="modal qrbox">
        <h3>{{ qr.name }}</h3>
        <img :src="qr.dataUrl" alt="二维码" />
        <p class="qrurl">{{ qr.url }}</p>
        <p class="qrpin">扫码后输入口令：<code>{{ qr.pin }}</code></p>
        <div class="actions">
          <button class="mini" @click="copy(qr.url, '地址')">复制地址</button>
          <button class="primary" @click="qr = null">完成</button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body { font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
.shell { height: 100%; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: baseline; gap: 10px; padding: 14px 20px; background: #1e293b; border-bottom: 1px solid #334155; }
.logo { font-size: 20px; } .title { font-size: 18px; font-weight: 600; }
.title small { color: #94a3b8; font-weight: 400; margin-left: 6px; }
.ver { margin-left: auto; color: #64748b; font-size: 12px; }
.body { flex: 1; overflow: auto; padding: 20px; }
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.hint { color: #64748b; font-size: 13px; margin-right: auto; }
.switcher { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #cbd5e1; cursor: pointer; }
.switcher.small { color: #94a3b8; font-size: 12px; }
.switcher input { accent-color: #3b82f6; }
button { font-family: inherit; cursor: pointer; border-radius: 8px; }
.primary { background: #3b82f6; color: #fff; border: none; padding: 9px 18px; font-size: 14px; font-weight: 600; }
.primary:hover { background: #2f6fe0; } .primary:disabled { opacity: .5; }
.empty { text-align: center; color: #94a3b8; line-height: 2; margin-top: 80px; }
.empty .big { font-size: 20px; color: #e2e8f0; }
.card { background: #1e293b; border: 1px solid #334155; border-left: 4px solid #475569; border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
.card[data-status='ready'] { border-left-color: #34d399; }
.card[data-status='starting'] { border-left-color: #fbbf24; }
.card[data-status='error'] { border-left-color: #f87171; }
.row1 { display: flex; align-items: baseline; gap: 12px; }
.name { font-size: 16px; font-weight: 600; }
.target { color: #94a3b8; font-size: 13px; }
.badge { margin-left: auto; font-size: 12px; padding: 3px 10px; border-radius: 10px; background: #334155; color: #cbd5e1; }
.card[data-status='ready'] .badge { background: #064e3b; color: #6ee7b7; }
.card[data-status='starting'] .badge { background: #78350f; color: #fcd34d; }
.card[data-status='error'] .badge { background: #7f1d1d; color: #fca5a5; }
.row2 { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
.url { font-size: 13px; color: #7dd3fc; word-break: break-all; }
.muted { color: #94a3b8; font-size: 13px; }
.err { color: #fca5a5; font-size: 13px; }
.row3 { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pin { color: #94a3b8; font-size: 13px; }
.pin code { color: #fbbf24; letter-spacing: 2px; font-size: 14px; }
.spacer { flex: 1; }
.mini { background: #334155; color: #e2e8f0; border: none; padding: 6px 12px; font-size: 12px; }
.mini:hover { background: #3f4d63; }
.mini.ghost { background: transparent; border: 1px solid #334155; color: #94a3b8; }
.mini.run { background: #059669; color: #fff; }
.mini.stop { background: #b45309; color: #fff; }
.mini.danger { background: transparent; border: 1px solid #7f1d1d; color: #fca5a5; }
.mask { position: fixed; inset: 0; background: rgba(2,6,23,.7); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 24px; width: 360px; }
.modal h3 { margin-bottom: 12px; }
.modal label { display: block; font-size: 12px; color: #94a3b8; margin: 12px 0 4px; }
.modal input { width: 100%; padding: 9px 12px; border-radius: 8px; border: 1px solid #2b3340; background: #0f1319; color: #eef1f5; font-size: 14px; }
.modal input:focus { outline: none; border-color: #3b82f6; }
.hintbox { font-size: 12px; color: #64748b; margin-top: 8px; line-height: 1.6; }
.hosttag { font-size: 12px; color: #6ee7b7; background: #064e3b; padding: 3px 10px; border-radius: 10px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.qrbox { text-align: center; }
.qrbox img { width: 240px; height: 240px; background: #fff; border-radius: 8px; padding: 6px; }
.qrurl { font-size: 12px; color: #7dd3fc; margin-top: 10px; word-break: break-all; }
.qrpin { color: #94a3b8; font-size: 13px; margin-top: 4px; }
.qrpin code { color: #fbbf24; letter-spacing: 2px; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #334155; color: #e2e8f0; padding: 10px 20px; border-radius: 10px; font-size: 13px; box-shadow:  0 6px 20px rgba(0,0,0,.4); }
</style>
