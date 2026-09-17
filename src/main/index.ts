import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { TRAY_ICON_B64 } from './icon'
import { registry } from './registry'
import { registerIpc, publishDemo } from './ipc'

// M1：服务发布全链路（网关代理 + cloudflared 隧道）
// 冒烟 --smoke：窗口就绪后自动退出；E2E --publish-demo <port>：自动发布 demo 服务并打印 E2E_URL/E2E_PIN

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
const SMOKE = process.argv.includes('--smoke')
const demoArg = process.argv.indexOf('--publish-demo')

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
    mainWindow?.show()
    if (SMOKE) setTimeout(() => app.exit(0), 1500)
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
    createWindow()
    createTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    if (demoArg !== -1) {
      const port = Number(process.argv[demoArg + 1] || 4590)
      void publishDemo(port)
    }
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (SMOKE || demoArg !== -1) app.quit()
})
