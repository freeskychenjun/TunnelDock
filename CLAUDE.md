# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**TunnelDock** — 把内网 Web 服务安全发布到公网的 Windows 桌面应用（Electron + TS + Vue 3），基于 cloudflared。
源码公开：https://github.com/freeskychenjun/TunnelDock（分支 `main`）。

## 红线

- **仓库是 public——严禁提交密钥、日志、cloudflared.exe**（52MB，已 gitignore）；push 前过一遍 `git ls-files` 与敏感模式扫描
- **dsh-pocket 是 GPL-2.0，只许借鉴架构思想，禁止复制任何代码**；代理层蓝本为自研 auth-proxy.js
- DSH 会话内跑 npm 脚本前先 `$env:NODE_OPTIONS = ''`（注入的 hide-console.cjs 会破坏 vite 的 execFile；`npm run e2e` 脚本内部已自带此清理）
- `src/gateway/proxy.cjs` 保持零第三方依赖、纯 node:http/net；它经 asarUnpack 解包（utilityProcess 需磁盘真实文件）

## 命令

`npm run dev / build / typecheck / unit / smoke / e2e / prep / dist` —— 用途见 README「开发」「打包」两节。要点：

- **typecheck** = `tsc`（主进程/preload/shared）+ `vue-tsc`（渲染层，`tsconfig.web.json`）；没有 lint
- **unit** = Node 自带 `node:test`（零第三方依赖）：`tests/unit/` 经 `child_process.fork` 真实拉起 proxy.cjs 打请求（限速用伪造 `cf-connecting-ip` 测——e2e 结构性测不出"按 IP"行为，公网流量全来自同一个 cloudflared socket）；validate.ts 为不依赖 electron 的纯函数模块，专为可测而设
- **smoke** = build 后 `electron out/main/index.js --smoke`：窗口就绪 1.5s 自动退出，exit 0 即通过（`--smoke`/`--publish-demo` 仅开发期生效，打包后被忽略）
- **e2e** = `scripts/e2e.ps1` 全链路（起 demo:4590 → `--publish-demo` 自动发布 → 模拟手机：登录/取页/WS 101/错误 PIN 限速 429 → 杀 cloudflared 验证自动重连），靠解析 stdout 标记 `E2E_URL / E2E_PIN / E2E_URL2` 驱动——**改动 ipc.ts / main/index.ts 里的这些 console.log 标记会弄坏 e2e**；需外网，约 4-5 分钟，脚本自己清残留进程与 services.json
- **prep** 把本机 cloudflared 复制进 `resources/`（一次性）；**dist** 产出 `release\TunnelDock Setup x.x.x.exe`（NSIS，未签名）

## 架构大图（跨文件才能看懂的部分）

一次「发布」= 每个 ServiceConfig 一个 Runtime（`src/main/ipc.ts` 的 `runtimes` Map），由两个子进程组成：

```
手机 → Cloudflare 边缘 → cloudflared（反连出网）→ gateway（127.0.0.1:OS 随机端口）→ 内网目标服务
```

- **ipc.ts = 编排与状态机**：状态 `idle|starting|ready|error`；`starting` Promise 单飞防并发启动；重连退避表 `[5s,15s,60s]`，超次数转 error；`desired==='stopped'` 时进程退出不触发重连；gateway utilityProcess 崩溃与 cloudflared 退出汇入同一条 `scheduleReconnect`
- **QUIC→http2 自愈**：重连启动（attempts≥1）或本服务曾用 http2 成功（`http2Prefs`，内存 Set 不落盘）→ 给 cloudflared 加 `--protocol http2` 强制 TCP
- **tunnel.ts**：`hostname` 留空走 Quick Tunnel（免费随机域名；从日志正则抓 URL，必须匹配多词子域名——单词的 `api.trycloudflare.com` 是 CF 自家端点，会出现在日志里须排除）；非空走命名隧道——本地 `data/tunnels/<serviceId>.yml` + 凭据齐备且域名未变时 `reuseLocalTunnelId` 直接复用、**免 CF API**（重启不依赖 api.cloudflare.com 可达性；此路径下 run 提前退出会清掉 yml，下次重连自动回落完整 ensure 自愈），否则 `ensureNamedTunnel` 幂等 create + route dns（list 失败抛错，不再按"不存在"处理）。`probeReady` 要求响应含 "TunnelDock" 防误配垃圾域名；本机连不上 CF 边缘 443（kind=unreachable）时命名隧道**降级为警告不拆隧道**（国内网络间歇阻断，隧道对外部仍是好的），内容不对（mismatch）仍算失败
- **proxy.cjs（PIN 墙网关，跑在 utilityProcess）**：网页登录 `POST /_td_auth` + 会话 Cookie（12h，带 Secure）+ Basic（用户名 `tunneldock`、口令即 PIN）双通道；按**真实客户端 IP**（`cf-connecting-ip`，socket 对端永远是本机 cloudflared，直接用 socket 地址会把全站算成一个 IP）5 次失败/分钟 → 封锁 60s；登录页插值全部 HTML 转义 + CSP；WS upgrade 原样透传（未认证 401）；转发时剥 Origin/Referer/Sec-Fetch-Site、重写 Host、`agent:false` 不复用上游连接；可选令牌引导（上游根路径回 401 → 读 tokenFile 取最新 `token=xxx` 303 一次，无 token 参数才引导故天然防循环）
- **registry.ts**：`services.json` 原子写（tmp+rename）、容错 BOM；init 时 `normalizeHost` 自愈历史脏数据
- **渲染层**（`App.vue` 单文件 UI）只能经 `src/preload/index.ts` 的类型化 API（`td:*` IPC 通道）通信；跨进程类型单一来源在 `src/shared/types.ts`（registry/preload/env.d.ts 都从这取）；状态变化经 `td:event` 广播到所有窗口
- **生命周期收尾**：退出走 `will-quit` → `shutdownAll()` 统一 kill（不留孤儿 cloudflared）；启动时保守清扫命令行含 `data\tunnels` 的 cloudflared 孤儿；删除服务清本地 yml，有固定域名时 UI 弹窗可选连云端隧道一起删（DNS 记录残留，重绑时 `route dns -f` 自动覆盖）
- **改配置类 IPC（setHostname / setTokenFile / setPin 等）对运行中服务是 stop 而非热更**——重启生效是既定模式

## 构建管线

- `electron.vite.config.ts` 的 main 有**两个 rollup 入口**：`src/main/index.ts → out/main/index.js` 和 `src/gateway/proxy.cjs → out/main/gateway.js`；gateway.ts fork 的是这个打包产物路径（开发期 `out/main/gateway.js`，打包后 `resourcesPath/app.asar.unpacked/out/main/gateway.js`）
- cloudflared 定位顺序：`TUNNELDOCK_CLOUDFLARED` → 安装包内置 → `~/.cloudflared/` → PATH

## 数据与环境事实

- 数据：`%APPDATA%\TunnelDock\data\services.json` + `tunnels\`；`~/.cloudflared/` 存账号凭据（cert.pem 勿外传）
- 本机 GitHub：git push / gh api 可通，Releases 大文件下载常超时 → 构建工具走 npmmirror（.npmrc 已配）

## 深入文档

| 主题 | 位置 |
|---|---|
| 架构 / 决策记录 / 里程碑 | docs/开发方案.md |
| 用户手册（HTML，随分享包发） | docs/使用说明.html |
| 工作原理科普（反连隧道 / PIN 网关内幕） | docs/工作原理.html |
| 安装 / 排障 / 发版清单 | README.md |
