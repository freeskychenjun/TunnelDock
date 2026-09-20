import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { TRAY_ICON_B64 } from './icon'
import { registry } from './registry'
import { registerIpc, publishDemo, autoRestore, shutdownAll } from './ipc'
import { sweepOrphanTunnels } from './tunnel'

// M2：断线重连、自启恢复、--hidden 静默启动、渲染进程崩溃自愈
// 冒烟 --smoke：窗口就绪后自动退出；E2E --publish-demo <port> [--demo-pin xxx]：自动发布并打印 E2E_URL/E2E_PIN
// 两者仅开发期（未打包）生效——安装包内这些标志是后门，一律忽略

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
const SMOKE = !app.isPackaged && process.argv.includes('--smoke')
const HIDDEN = process.argv.includes('--hidden')
const demoArg = !app.isPackaged ? process.argv.indexOf('--publish-demo') : -1

// 开发/测试实例数据隔离：设 TUNNELDOCK_USER_DATA 后走独立 userData（e2e.ps1 会设置）。
// Windows 文件系统大小写不敏感，%APPDATA%\TunnelDock 与 %APPDATA%\tunneldock 是同一目录——
// 开发实例不隔离就会和安装版共用 services.json 互相覆盖、清扫时误杀对方隧道。
// 仅开发期生效；安装版数据位置不受环境变量影响。
if (process.env.TUNNELDOCK_USER_DATA && !app.isPackaged) {
  app.setPath('userData', process.env.TUNNELDOCK_USER_DATA)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 700,
    show: false,
    title: 'TunnelDock 隧道坞',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!HIDDEN) mainWindow?.show()
    if (SMOKE) setTimeout(() => app.exit(0), 1500)
  })

  // 渲染进程崩溃自愈：重建窗口
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[warn] 渲染进程异常退出（${details.reason}），正在重载`)
    mainWindow?.reload()
  })

  mainWindow.on('close', (e) => {
    if (!SMOKE && !isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray(): void {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(image)
  tray.setToolTip('TunnelDock 隧道坞')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => (mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow()) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', () => (mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow()))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    registry.init()
    registerIpc()
    sweepOrphanTunnels() // 上次异常退出留下的 cloudflared 孤儿（带我们 ingress 配置的）
    createWindow()
    createTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    if (demoArg !== -1) {
      const port = Number(process.argv[demoArg + 1] || 4590)
      const pinIdx = process.argv.indexOf('--demo-pin')
      const customPin = pinIdx !== -1 ? process.argv[pinIdx + 1] : undefined
      void publishDemo(port, customPin)
    } else {
      autoRestore() // 正常启动：恢复所有 autoStart 的发布（E2E 模式跳过，走 publishDemo）
    }
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

// 退出统一回收子进程：不主动 kill 的话 cloudflared 在 Windows 上会变成孤儿继续挂着隧道
app.on('will-quit', () => {
  shutdownAll()
})

app.on('window-all-closed', () => {
  if (SMOKE || demoArg !== -1) app.quit()
})
