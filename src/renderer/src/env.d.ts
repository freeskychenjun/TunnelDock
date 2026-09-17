declare interface Window {
  tunneldock: {
    platform: string
    versions: { app: string; electron: string; node: string }
    list: () => Promise<ServiceConfig[]>
    states: () => Promise<ServiceState[]>
    create: (p: { name: string; targetHost: string; targetPort: number }) => Promise<ServiceConfig>
    start: (id: string) => Promise<ServiceState>
    stop: (id: string) => Promise<ServiceState>
    remove: (id: string) => Promise<boolean>
    resetPin: (id: string) => Promise<ServiceConfig>
    onEvent: (cb: (states: ServiceState[]) => void) => void
  }
}

declare interface ServiceConfig {
  id: string
  name: string
  targetHost: string
  targetPort: number
  pin: string
  createdAt: number
}

declare interface ServiceState {
  id: string
  status: 'idle' | 'starting' | 'ready' | 'error' | 'stopping'
  url: string | null
  error: string | null
}
