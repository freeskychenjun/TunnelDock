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
```

**本机注意（DSH 会话内跑命令时）**：DSH 注入的 `NODE_OPTIONS=--require ~/.dsh/hide-console.cjs`
会破坏 vite 的子进程调用（execFile 签名被改），先清掉再跑：

```powershell
$env:NODE_OPTIONS = ''
```

（在自己的终端里跑不受影响。）

## 环境事实

- cloudflared：开发期用本机现成二进制 `C:\Users\Administrator\.cloudflared\cloudflared.exe`（2026.8.2）
- 许可：对 dsh-pocket（GPL-2.0）只借鉴架构，不复制代码；代理层蓝本为自研 auth-proxy.js
