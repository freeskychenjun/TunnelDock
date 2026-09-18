# TunnelDock — AI 协作规则

把内网 Web 服务安全发布到公网的 Windows 桌面应用（Electron + TS + Vue 3），基于 cloudflared。
源码公开：https://github.com/freeskychenjun/TunnelDock（分支 `main`）。

## 红线

- **仓库是 public——严禁提交密钥、日志、cloudflared.exe**（52MB，已 gitignore）；push 前过一遍 `git ls-files` 与敏感模式扫描
- **dsh-pocket 是 GPL-2.0，只许借鉴架构思想，禁止复制任何代码**；代理层蓝本为自研 auth-proxy.js
- DSH 会话内跑 npm 脚本前先 `$env:NODE_OPTIONS = ''`（注入的 hide-console.cjs 会破坏 vite 的 execFile）
- `src/gateway/proxy.cjs` 保持零第三方依赖、纯 node:http/net；它经 asarUnpack 解包（utilityProcess 需磁盘真实文件）

## 命令速查

`npm run dev / build / typecheck / smoke / e2e / prep / dist` —— 用途见 README「开发」「打包」两节。

## 结构与环境事实

- 模块：`src/main/`（tunnel=cloudflared 生命周期、gateway=utilityProcess 编排、registry=JSON 持久化）·
  `src/gateway/proxy.cjs`（PIN 墙反代）· `src/renderer/`（Vue 面板，全部经 preload 类型化 API）
- cloudflared 定位顺序：`TUNNELDOCK_CLOUDFLARED` → 安装包内置 → `~/.cloudflared/` → PATH
- 数据：`%APPDATA%\TunnelDock\data\services.json` + `tunnels\`；`~/.cloudflared/` 存账号凭据（cert.pem 勿外传）
- 本机 GitHub：git push / gh api 可通，Releases 大文件下载常超时 → 构建工具走 npmmirror（.npmrc 已配）

## 深入文档

| 主题 | 位置 |
|---|---|
| 架构 / 决策记录 / 里程碑 | docs/开发方案.md |
| 用户手册（HTML，随分享包发） | docs/使用说明.html |
| 安装 / 排障 / 发版清单 | README.md |
