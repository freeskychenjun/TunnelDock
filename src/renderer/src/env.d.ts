declare interface Window {
  tunneldock: {
    platform: string
    versions: { app: string; electron: string; node: string }
    list: () => Promise<ServiceConfig[]>
    states: () => Promise<ServiceState[]>
    create: (p: { name: string; targetHost: string; targetPort: number; pin?: string }) => Promise<ServiceConfig>
    start: (id: string) => Promise<ServiceState>
    stop: (id: string) => Promise<ServiceState>
    remove: (id: string) => Promise<boolean>
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

declare interface ServiceConfig {
  id: string
  name: string
  targetHost: string
  targetPort: number
  pin: string
  hostname: string
  tokenFile: string
  autoStart: boolean
  createdAt: number
}

declare interface ServiceState {
  id: string
  status: 'idle' | 'starting' | 'ready' | 'error' | 'stopping'
  url: string | null
  error: string | null
  attempt: number
}
