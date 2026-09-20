// 渲染层全局类型：形状统一来自 src/shared/types（单一来源，防三处漂移）

declare global {
  type ServiceConfig = import('../../shared/types').ServiceConfig
  type ServiceState = import('../../shared/types').ServiceState
  type AppInfo = import('../../shared/types').AppInfo
  type RemoveResult = import('../../shared/types').RemoveResult

  interface Window {
    tunneldock: {
      appInfo: () => Promise<AppInfo>
      list: () => Promise<ServiceConfig[]>
      states: () => Promise<ServiceState[]>
      create: (p: { name: string; targetHost: string; targetPort: number; pin?: string }) => Promise<ServiceConfig>
      start: (id: string) => Promise<ServiceState>
      stop: (id: string) => Promise<ServiceState>
      remove: (id: string, purgeCloud?: boolean) => Promise<RemoveResult>
      resetPin: (id: string) => Promise<ServiceConfig>
      setPin: (id: string, pin: string) => Promise<ServiceConfig>
      setAutoStart: (id: string, on: boolean) => Promise<ServiceConfig>
      setHostname: (id: string, hostname: string) => Promise<ServiceConfig>
      setTokenFile: (id: string, file: string) => Promise<ServiceConfig>
      hasOriginCert: () => Promise<boolean>
      getAppAutostart: () => Promise<boolean>
      setAppAutostart: (on: boolean) => Promise<boolean>
      onEvent: (cb: (states: ServiceState[]) => void) => void
    }
  }
}

export {}
