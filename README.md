# TunnelDock 隧道坞

把内网的 Web 服务（HTTP/WebSocket）一键、安全、免费地发布到公网访问。
Windows 桌面应用（Electron + TypeScript + Vue 3），闭源。

方案文档：[docs/开发方案.md](docs/开发方案.md)

## 开发

```powershell
npm install       # 已配置 npmmirror 镜像（.npmrc）
npm run dev       # 开发模式（热更新）
npm run build     # 构建 out/
npm run smoke     # 构建后自动冒烟：起窗口 1.5s 自动退出，exit 0 = 通过
npm run e2e       # 全链路 E2E（demo→发布→模拟手机→WS→限速→断线重连）
```

## 打包（NSIS 安装包）

```powershell
npm run prep      # 把本机 cloudflared 复制进 resources/（一次性，52MB 不入 git）
npm run dist      # 产出 release\TunnelDock Setup x.x.x.exe（约 93MB，内置 cloudflared）
```

- 安装包为 per-user 单击安装，静默安装参数 `/S`，卸载走控制面板或 `Uninstall TunnelDock.exe`
- 打包细节：gateway.js 经 `asarUnpack` 解出 asar（utilityProcess 需磁盘真实文件）；
  cloudflared 走 `extraResources` 内置于安装目录 resources\；
  构建工具全部走 npmmirror 镜像（本机连不上 GitHub）
- 未做代码签名（无证书），Windows SmartScreen 可能提示"未知发布者"

**本机注意（DSH 会话内跑命令时）**：DSH 注入的 `NODE_OPTIONS=--require ~/.dsh/hide-console.cjs`
会破坏 vite 的子进程调用（execFile 签名被改），先清掉再跑：

```powershell
$env:NODE_OPTIONS = ''
```

（在自己的终端里跑不受影响。）

## 环境事实

- cloudflared：开发期用本机现成二进制 `C:\Users\Administrator\.cloudflared\cloudflared.exe`（2026.8.2）
- 许可：对 dsh-pocket（GPL-2.0）只借鉴架构，不复制代码；代理层蓝本为自研 auth-proxy.js
