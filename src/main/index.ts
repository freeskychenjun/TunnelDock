import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { TRAY_ICON_B64 } from './icon'

// M0 骨架：单实例 + 托盘常驻 + 空面板 + 冒烟自检出口
// 冒烟模式：npm run smoke → 窗口就绪后自动退出（exit 0 = 通过），供自动化验证

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
const SMOKE = process.argv.includes('--smoke')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    show: false,
    title: 'TunnelDock 隧道坞',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload 需要 require；contextIsolation 已开
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (SMOKE) {
      // 自动化冒烟：窗口真正显示后 1.5s 退出
      setTimeout(() => app.exit(0), 1500)
    }
  })

  // 关闭 = 隐藏到托盘（托盘菜单里才真正退出）
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

// 单实例：第二个实例唤醒已有窗口后退出
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
    createWindow()
    createTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // 托盘常驻：不退出（冒烟模式除外）
  if (SMOKE) app.quit()
})
