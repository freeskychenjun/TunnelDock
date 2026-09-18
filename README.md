# TunnelDock 隧道坞

把内网的 Web 服务（HTTP/WebSocket）一键、安全、免费地发布到公网访问。
Windows 桌面应用（Electron + TypeScript + Vue 3），托盘常驻，闭源。

方案文档：[docs/开发方案.md](docs/开发方案.md)

## 功能特性

- **一键发布**：服务名 + 目标地址端口 → 启动 → 出公网地址 + 二维码（免费临时地址，无需账号）
- **固定域名**：有自己的 Cloudflare 域名时，卡片上「设域名」绑定子域名，地址永久不变
- **默认安全**：每个发布独立 PIN 口令墙 + 登录失败限速 + 常量时间比较；WebSocket 全透传
- **令牌引导**：服务自身要求 `?token=` 首访的（如 dsh web），「令牌引导」填其日志路径即自动通过
- **生命周期**：断线自动重连（指数退避）、网关崩溃自动重建、开机自启并恢复全部发布（`--hidden` 静默）
- **协议自愈**：QUIC（UDP）被网络掐断时自动降级 http2（TCP），成功一次后记住偏好——恶劣网络（如移动宽带）下隧道仍可用
- 上游转发自动剥离 Origin/Referer/Sec-Fetch-Site 并重写 Host——兼容带 Host/Origin 围栏的服务

## 使用速览

1. 安装后打开 TunnelDock（桌面快捷方式 / 托盘）；
2. 「新建发布」填名称 + `127.0.0.1` + 端口，口令留空自动生成 8 位 PIN；
3. 「启动」→ 10-30 秒出地址 → 手机扫码输 PIN。
4. 长期使用建议绑固定域名：见分享包《同事指南-固定域名.md》（注册 Cloudflare → 买域名 → `cloudflared tunnel login` 一次性授权 → 卡片「设域名」）。

## 数据位置

- 服务配置 / PIN：`%APPDATA%\TunnelDock\data\services.json`（JSON 原子写，容错 BOM）
- 命名隧道 ingress 配置：`%APPDATA%\TunnelDock\data\tunnels\`
- Cloudflare 授权与隧道凭据：`%USERPROFILE%\.cloudflared\`（cert.pem 等于账号里域名的管理权，勿外传）

## 排障

**手机提示「找不到服务器」（DNS 层失败，非 502/525）**

国内运营商 DNS 对 `*.trycloudflare.com` 的随机子域名**抽风式不可解析**（同名域名 1.1.1.1 正常、
运营商 DNS 失败，实测复现）。解法按推荐顺序：

1. 手机浏览器开 DoH：Firefox「设置 → 隐私与安全 → DNS over HTTPS」开启即可（走 Cloudflare）；
   或 Android 系统级「私人 DNS」填 `1dot1dot1dot1.cloudflare-dns.com`；
2. 在 TunnelDock 里「停止→启动」换一个随机域名碰运气（是否可解析按域名抽签）；
3. 根治（已支持）：绑定自有域名（卡片「设域名」），自有域名不走随机子域，无此问题。

**换网络后三个服务全挂（本机/手机都打不开，间歇性秒失败）**

先分层：电脑上 `curl -4 https://你的域名` 通 = 隧道没问题，是**客户端优先走了不通的 IPv6**。
特征：移动出口 DNS 把 Cloudflare 的 AAAA（IPv6）排在前面，而本机/手机到 CF 的 v6 路由不通，
浏览器优先试 v6 → 毫秒级失败，看起来像"全挂"（实测 `curl -6` 全败、`curl -4` 全通）。
根治：Cloudflare 控制台 → 域名 → Network → **关闭 IPv6 Compatibility**（只返回 A 记录，全端生效）。
排查口诀：`curl -4` 通 + `curl -6` 挂 + 本机无全局 IPv6 = 关 zone 的 IPv6。
注意：免费版该开关在 UI 里是灰的（Enterprise 专属），可用 API `PATCH /zones/:id/settings/ipv6 {"value":"off"}` 尝试。

**同一手机：微信扫码能进，QQ/系统浏览器不行**

微信内核（XWeb）自带腾讯 HTTPDNS，绕开了运营商 DNS；其他浏览器走运营商 DNS + IPv6 优先，
踩中上面两个坑。解法：手机「设置 → 网络 → 私人 DNS」填 `1dot1dot1dot1.cloudflare-dns.com`
（系统级一次生效，所有应用受益）；仍慢则是 IPv6 的锅 → APN 协议改 IPv4。

**隧道时通时断 / 重连循环（日志满屏 failed to dial to edge with quic）**

网络掐了 UDP（QUIC）。0.3.2 起自动降级：第二次重连走 http2（TCP）并记住偏好，无需人工干预。
手动验证方法：`cloudflared tunnel --config <yml> --protocol http2 run`，4 连接秒注册即为此因。

**页面开了但某插件 import failed（如 dsh 的 documentpreview）**

先验证链路：同 URL 直连与走网关对比（字节级一致 = 隧道无罪）。多为「大插件 × 慢网络」——
该插件内嵌 PDF.js 达 6.9MB，慢隧道上浏览器导入超时。解法：换好网络加载一次（rev 参数是缓存键，
成功后进浏览器缓存）；或禁用不需要的大插件。

**502 Bad Gateway**：多为目标服务没启动或地址不对（带 `http://` 会自动清洗）；
在电脑浏览器直接访问 `http://目标地址:端口` 排查服务本身。

**页面 401 / "authentication required"**：服务自身的门禁。带 `?token=` 类的用「令牌引导」；
带自身账号体系的（如 pi-web Basic）直接输它的账号密码。

## 开发

```powershell
npm install       # 已配置 npmmirror 镜像（.npmrc）
npm run dev       # 开发模式（热更新）
npm run build     # 构建 out/
npm run typecheck # tsc --noEmit
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
  cloudflared 走 `extraResources` 内置于安装目录 resources\（打包后优先于开发期路径）；
  构建工具全部走 npmmirror 镜像（本机连不上 GitHub）
- 未做代码签名（无证书），Windows SmartScreen 可能提示"未知发布者"
- 发版前：改 package.json 版本号 → dist → 更新分享包（`D:\DSH工作区\TunnelDock-分享\`，
  源码 zip 用 `git archive --format=zip --output=... HEAD` 导出，避免带入 .git/作者信息）

**本机注意（DSH 会话内跑命令时）**：DSH 注入的 `NODE_OPTIONS=--require ~/.dsh/hide-console.cjs`
会破坏 vite 的子进程调用（execFile 签名被改），先清掉再跑：

```powershell
$env:NODE_OPTIONS = ''
```

（在自己的终端里跑不受影响。）

## 环境事实

- cloudflared：开发期定位顺序 = `TUNNELDOCK_CLOUDFLARED` 环境变量 → 安装包内置 →
  `C:\Users\Administrator\.cloudflared\cloudflared.exe` → PATH
- 本机动态端口会分到低位（如 1459），排查监听时不要按 ">10000" 过滤
- 许可：对 dsh-pocket（GPL-2.0）只借鉴架构，不复制代码；代理层蓝本为自研 auth-proxy.js
