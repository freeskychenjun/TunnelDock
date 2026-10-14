import { contextBridge, ipcRenderer } from 'electron'
import type { ServiceConfig, ServiceState, AppInfo, RemoveResult, RtStatus } from '../shared/types'

export interface RtZoneInfo {
  id: string
  name: string
}

// 渲染层唯一入口：类型化、白名单式暴露
contextBridge.exposeInMainWorld('tunneldock', {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('td:appInfo'),
  // 服务管理
  list: (): Promise<ServiceConfig[]> => ipcRenderer.invoke('td:list'),
  states: (): Promise<ServiceState[]> => ipcRenderer.invoke('td:states'),
  create: (p: { name: string; targetHost: string; targetPort: number; pin?: string; transport?: string }): Promise<ServiceConfig> =>
    ipcRenderer.invoke('td:create', p),
  start: (id: string): Promise<ServiceState> => ipcRenderer.invoke('td:start', id),
  stop: (id: string): Promise<ServiceState> => ipcRenderer.invoke('td:stop', id),
  remove: (id: string, purgeCloud?: boolean): Promise<RemoveResult> => ipcRenderer.invoke('td:remove', id, purgeCloud),
  resetPin: (id: string): Promise<ServiceConfig> => ipcRenderer.invoke('td:resetPin', id),
  setPin: (id: string, pin: string): Promise<ServiceConfig> => ipcRenderer.invoke('td:setPin', id, pin),
  setAutoStart: (id: string, on: boolean): Promise<ServiceConfig> => ipcRenderer.invoke('td:setAutoStart', id, on),
  setHostname: (id: string, hostname: string): Promise<ServiceConfig> => ipcRenderer.invoke('td:setHostname', id, hostname),
  setTokenFile: (id: string, file: string): Promise<ServiceConfig> => ipcRenderer.invoke('td:setTokenFile', id, file),
  setTransport: (id: string, transport: 'cloudflared' | 'wss'): Promise<ServiceConfig> =>
    ipcRenderer.invoke('td:setTransport', id, transport),
  hasOriginCert: (): Promise<boolean> => ipcRenderer.invoke('td:hasOriginCert'),
  // 反向隧道（RT）向导
  rtStatus: (): Promise<RtStatus> => ipcRenderer.invoke('rt:status'),
  rtSetup: (token: string): Promise<{ zones: RtZoneInfo[] }> => ipcRenderer.invoke('rt:setup', token),
  rtDeploy: (token: string, zoneId: string): Promise<RtStatus> => ipcRenderer.invoke('rt:deploy', token, zoneId),
  rtForget: (): Promise<RtStatus> => ipcRenderer.invoke('rt:forget'),
  // 应用级开机自启
  getAppAutostart: (): Promise<boolean> => ipcRenderer.invoke('td:appAutostart:get'),
  setAppAutostart: (on: boolean): Promise<boolean> => ipcRenderer.invoke('td:appAutostart:set', on),
  // 状态推送
  onEvent: (cb: (states: ServiceState[]) => void): void => {
    ipcRenderer.on('td:event', (_e, states) => cb(states))
  }
})
