import { contextBridge } from 'electron'

// 渲染层唯一入口：类型化、白名单式暴露，禁 nodeIntegration
contextBridge.exposeInMainWorld('tunneldock', {
  platform: process.platform,
  versions: {
    app: '0.1.0',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
})
