# TunnelDock 隧道坞

把内网的 Web 服务（HTTP/WebSocket）一键、安全、免费地发布到公网访问。
Windows 桌面应用（Electron + TypeScript + Vue 3），闭源。

方案文档：[docs/开发方案.md](docs/开发方案.md)

## 排障

**手机提示「找不到服务器」（DNS 层失败，非 502/525）**

国内运营商 DNS 对 `*.trycloudflare.com` 的随机子域名**抽风式不可解析**（同名域名 1.1.1.1 正常、
运营商 DNS 失败，实测复现）。解法按推荐顺序：

1. 手机浏览器开 DoH：Firefox「设置 → 隐私与安全 → DNS over HTTPS」开启即可（走 Cloudflare）；
   或 Android 系统级「私人 DNS」填 `1dot1dot1dot1.cloudflare-dns.com`；
2. 在 TunnelDock 里「停止→启动」换一个随机域名碰运气（是否可解析按域名抽签）；
3. 根治：命名隧道 + 自有域名（M3，国内 DNS 对自有域名通常正常）。

**502 Bad Gateway**：多为目标服务地址填错（带 `http://` 已能自动清洗）或目标服务没启动；
在电脑浏览器直接访问 `http://目标地址:端口` 排查服务本身。

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
