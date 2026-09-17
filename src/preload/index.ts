import { contextBridge, ipcRenderer } from 'electron'

// 渲染层唯一入口：类型化、白名单式暴露
contextBridge.exposeInMainWorld('tunneldock', {
  platform: process.platform,
  versions: { app: '0.2.0', electron: process.versions.electron, node: process.versions.node },
  // 服务管理
  list: (): Promise<ServiceConfig[]> => ipcRenderer.invoke('td:list'),
  states: (): Promise<ServiceState[]> => ipcRenderer.invoke('td:states'),
  create: (p: { name: string; targetHost: string; targetPort: number; pin?: string }): Promise<ServiceConfig> =>
    ipcRenderer.invoke('td:create', p),
  start: (id: string): Promise<ServiceState> => ipcRenderer.invoke('td:start', id),
  stop: (id: string): Promise<ServiceState> => ipcRenderer.invoke('td:stop', id),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('td:remove', id),
  resetPin: (id: string): Promise<ServiceConfig> => ipcRenderer.invoke('td:resetPin', id),
  setPin: (id: string, pin: string): Promise<ServiceConfig> => ipcRenderer.invoke('td:setPin', id, pin),
  setAutoStart: (id: string, on: boolean): Promise<ServiceConfig> => ipcRenderer.invoke('td:setAutoStart', id, on),
  // 应用级开机自启
  getAppAutostart: (): Promise<boolean> => ipcRenderer.invoke('td:appAutostart:get'),
  setAppAutostart: (on: boolean): Promise<boolean> => ipcRenderer.invoke('td:appAutostart:set', on),
  // 状态推送
  onEvent: (cb: (states: ServiceState[]) => void): void => {
    ipcRenderer.on('td:event', (_e, states) => cb(states))
  }
})

interface ServiceConfig {
  id: string
  name: string
  targetHost: string
  targetPort: number
  pin: string
  autoStart: boolean
  createdAt: number
}

interface ServiceState {
  id: string
  status: 'idle' | 'starting' | 'ready' | 'error' | 'stopping'
  url: string | null
  error: string | null
  attempt: number
}

export type { ServiceConfig, ServiceState }
