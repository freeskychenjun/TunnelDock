/**
 * TunnelDock RT（反向隧道）Worker + Durable Object
 *
 * 架构: 手机(任意网络) → CF 边缘 443 → 本 Worker(路由+PIN 鉴权) → DO(每服务一个实例)
 *       ←— hibernation WebSocket ←— 桌面端 agent(wss://域名/__agent?secret=..., 443)
 *
 * 由自研 cf-worker-tunnel/index.js 泛化而来（无第三方版权问题）：
 *  - PINS_JSON 环境变量: { "<hostname>": { "sid": "<serviceId>", "pin": "<PIN>" } }
 *    由桌面应用部署时自动生成，改 PIN 只需重新部署 vars（或 storage 覆盖，二期）
 *  - DO 实例按 serviceId 隔离（idFromName(sid)），重命名服务不换子域名
 *  - 登录页 cookie + ?k= 兜底 + IP 限速（5 次/分 → 封 60s）+ SW 会话守护
 *  - 浏览器 WS 中转（升级请求原样透传——重建 Request 会丢 Upgrade 头）
 */

const enc = new TextEncoder();

// 会话守护 Service Worker: 拦截一切请求自动携带 k 令牌（不依赖 cookie）
// 令牌从 SW 自己的脚本 URL ?k= 里读取，不写死在本文件（公开可达）
const SW_CODE = `// tunneldock-rt service worker
var K = "";
try { K = new URL(self.location).searchParams.get("k") || ""; } catch (e) {}
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (event) {
  try {
    if (!K) return;
    var req = event.request;
    if (req.method !== "GET" && req.method !== "HEAD") return;
    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.searchParams.get("k")) return;
    if (url.pathname === "/__sw.js") return;
    url.searchParams.set("k", K);
    event.respondWith(fetch(url.toString(), { method: req.method, headers: req.headers, redirect: "follow" }));
  } catch (e) {}
});
`;

function bufferToB64(buf) {
  const view = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 解析 PINS_JSON: { hostname: { sid, pin } } */
function parsePins(env) {
  try {
    const m = JSON.parse(env.PINS_JSON || "{}");
    return typeof m === "object" && m ? m : {};
  } catch (e) {
    return {};
  }
}

function hostOf(request) {
  return (request.headers.get("Host") || "").toLowerCase().split(":")[0];
}

export default {
  async fetch(request, env) {
    const host = hostOf(request);
    const pins = parsePins(env);
    const entry = pins[host];
    if (!entry || !entry.sid || !entry.pin) {
      return new Response("unknown host: " + host, { status: 404 });
    }
    const id = env.TUNNEL.idFromName(entry.sid);
    // WS 升级请求必须原样透传（重建 Request 会丢 Upgrade 头）；
    // 此时 DO 收不到 x-td-* 内部头，由 DO 自己从 Host + PINS_JSON 推导
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      return env.TUNNEL.get(id).fetch(request);
    }
    const headers = new Headers(request.headers);
    headers.set("x-td-pin", entry.pin);
    headers.set("x-td-service", entry.sid);
    return env.TUNNEL.get(id).fetch(new Request(request.url, { method: request.method, headers, body: request.body, redirect: "manual" }));
  },
};

export class Tunnel {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map();
    this.wsConns = new Map(); // 浏览器 WS 中转: connId -> 浏览器侧 socket
  }

  async expectedToken(pin) {
    const data = enc.encode("td-rt:" + this.env.AGENT_SECRET + ":" + pin);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    // pin/service 优先取内部头；WS 透传请求没有内部头，从 Host + PINS_JSON 兜底推导
    let pin = request.headers.get("x-td-pin") || "";
    let serviceName = request.headers.get("x-td-service") || "";
    if (!pin || !serviceName) {
      const host = hostOf(request);
      const entry = parsePins(this.env)[host];
      pin = pin || (entry && entry.pin) || "";
      serviceName = serviceName || (entry && entry.sid) || "service";
    }

    // ── 1. Agent WebSocket 接入 ──
    if (path === "/__agent") {
      const secret = url.searchParams.get("secret") || "";
      if (!this.env.AGENT_SECRET || secret !== this.env.AGENT_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
      if (upgrade !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], ["agent"]);
      // 只保留最新的一条 agent 连接（同服务旧实例让位）
      for (const ws of this.state.getWebSockets("agent")) {
        if (ws !== pair[1]) {
          try { ws.close(1000, "replaced by newer agent"); } catch (e) {}
        }
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // ── 1.5. 会话守护 SW（公开，不含密钥）──
    if (path === "/__sw.js") {
      return new Response(SW_CODE, {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // ── 2. 认证（静态编译产物免认证：不含用户数据，兼容不存 cookie 的浏览器）──
    let auth = { ok: true };
    const publicPath = path.startsWith("/_next/static/") || path === "/favicon.ico" || path.startsWith("/_next/image");
    if (!publicPath) {
      auth = await this.checkAuth(request, pin);
      if (!auth.ok) return auth.response;
    }

    // ── 2.5. 浏览器 WebSocket 中转（侧边栏/终端等实时通道）──
    const isUpgrade = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
    if (isUpgrade && path !== "/__agent") {
      const agent = this.state.getWebSockets("agent").find((ws) => ws.readyState === 1);
      if (!agent) {
        return new Response(serviceName + " 隧道离线：桌面端未连接", {
          status: 502, headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      // 原始路径+查询透传（剥掉我们自己的 k 令牌，保留服务自身的 token= 等）
      const sp = new URLSearchParams(url.searchParams);
      sp.delete("k");
      const cleanPath = path + (sp.toString() ? "?" + sp.toString() : "");

      const pair = new WebSocketPair();
      const [clientSide, serverSide] = [pair[0], pair[1]];
      serverSide.accept(); // 非 hibernation: 持有 DO 实例存活
      const connId = crypto.randomUUID();
      this.wsConns.set(connId, serverSide);

      try {
        agent.send(JSON.stringify({
          type: "ws-open", id: connId, path: cleanPath,
          headers: {
            cookie: request.headers.get("Cookie") || "",
            "sec-websocket-protocol": request.headers.get("Sec-WebSocket-Protocol") || "",
          },
        }));
      } catch (e) {
        this.wsConns.delete(connId);
        try { serverSide.close(1011, "agent link error"); } catch (e2) {}
        return new Response(null, { status: 101, webSocket: clientSide });
      }

      serverSide.addEventListener("message", (ev) => {
        try {
          agent.send(JSON.stringify({
            type: "ws-data", id: connId,
            data: typeof ev.data === "string" ? ev.data : bufferToB64(ev.data),
            bin: typeof ev.data !== "string",
          }));
        } catch (e) {}
      });
      const teardown = () => {
        this.wsConns.delete(connId);
        try { agent.send(JSON.stringify({ type: "ws-close", id: connId })); } catch (e) {}
      };
      serverSide.addEventListener("close", teardown);
      serverSide.addEventListener("error", teardown);

      return new Response(null, { status: 101, webSocket: clientSide });
    }

    // ── 3. 普通 HTTP 请求 → 经 WebSocket 隧道转发 ──
    const agent = this.state.getWebSockets("agent").find((ws) => ws.readyState === 1);
    if (!agent) {
      return new Response(serviceName + " 隧道离线：桌面端未连接", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const reqId = crypto.randomUUID();
    const headers = {};
    for (const [k, v] of request.headers) {
      const lk = k.toLowerCase();
      if (["host", "connection", "upgrade", "keep-alive", "transfer-encoding",
           "cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-visitor",
           "x-forwarded-proto", "x-forwarded-for", "content-length",
           "x-td-pin", "x-td-service"].includes(lk)) continue;
      headers[k] = v;
    }
    const bodyBuf = await request.arrayBuffer();

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const startPromise = new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, writer });
      setTimeout(() => {
        if (this.pending.has(reqId) && !this.pending.get(reqId).started) {
          this.pending.delete(reqId);
          reject(new Error("agent response timeout"));
        }
      }, 20000);
    });

    agent.send(JSON.stringify({
      type: "req",
      id: reqId,
      method: request.method,
      path: path + url.search,
      headers,
      body: bufferToB64(bodyBuf),
    }));

    let start;
    try {
      start = await startPromise;
    } catch (e) {
      try { await writer.close(); } catch (e2) {}
      return new Response("隧道请求超时: " + e.message, { status: 504 });
    }

    const respHeaders = new Headers();
    for (const [k, v] of Object.entries(start.headers || {})) {
      const lk = k.toLowerCase();
      if (["transfer-encoding", "connection", "content-length", "keep-alive"].includes(lk)) continue;
      try {
        if (Array.isArray(v)) {
          for (const item of v) respHeaders.append(k, item);
        } else {
          respHeaders.set(k, v);
        }
      } catch (e) {}
    }

    let finalResp = new Response(readable, { status: start.status, headers: respHeaders });
    if (auth.setCookie) {
      try { finalResp.headers.append("Set-Cookie", auth.setCookie); } catch (e) {}
    }
    if (auth.viaK) {
      const ct = String(start.headers["Content-Type"] || start.headers["content-type"] || "");
      if (ct.includes("text/html")) {
        try {
          const token = await this.expectedToken(pin);
          finalResp = patchedResponse(finalResp, token);
        } catch (e) {}
      }
    }
    return finalResp;
  }

  // agent 发回的消息（hibernation 唤醒入口）
  async webSocketMessage(ws, message) {
    let frame;
    try {
      frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch (e) {
      return;
    }
    // ── 浏览器 WS 中转: Agent → 浏览器方向 ──
    if (frame.type === "ws-data") {
      const sock = this.wsConns.get(frame.id);
      if (sock && sock.readyState === 1) {
        try {
          sock.send(frame.bin ? b64ToBuf(frame.data) : String(frame.data));
        } catch (e) {}
      }
      return;
    }
    if (frame.type === "ws-close") {
      const sock = this.wsConns.get(frame.id);
      this.wsConns.delete(frame.id);
      if (sock) { try { sock.close(1000, "local closed"); } catch (e) {} }
      return;
    }

    const p = this.pending.get(frame.id);
    if (!p) return;
    if (frame.type === "res-start") {
      p.started = true;
      p.resolve({ status: frame.status, headers: frame.headers });
    } else if (frame.type === "chunk") {
      try { await p.writer.write(b64ToBuf(frame.data)); } catch (e) {}
    } else if (frame.type === "end") {
      try { await p.writer.close(); } catch (e) {}
      this.pending.delete(frame.id);
    } else if (frame.type === "error") {
      if (!p.started) {
        p.reject(new Error(frame.message || "agent error"));
      } else {
        try { await p.writer.close(); } catch (e) {}
      }
      this.pending.delete(frame.id);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // agent 链路断开 → 所有浏览器 WS 一并关闭（客户端会自动重连新链路）
    for (const [, sock] of this.wsConns) {
      try { sock.close(1011, "agent link closed"); } catch (e) {}
    }
    this.wsConns.clear();
    for (const [, p] of this.pending) {
      if (!p.started) p.reject(new Error("agent link closed"));
    }
    this.pending.clear();
  }
  async webSocketError(ws, error) {}

  // ── 登录失败限速（同 IP 5 次/分钟 → 封 60 秒）──
  async loginBlocked(ip) {
    const until = (await this.state.storage.get("blk:" + ip)) || 0;
    return Date.now() < until;
  }

  async recordLoginFail(ip) {
    const now = Date.now();
    const key = "fails:" + ip;
    const arr = ((await this.state.storage.get(key)) || []).filter((t) => now - t < 60000);
    arr.push(now);
    if (arr.length >= 5) {
      await this.state.storage.put("blk:" + ip, now + 60000);
      await this.state.storage.delete(key);
      return true;
    }
    await this.state.storage.put(key, arr);
    return false;
  }

  async checkAuth(request, pin) {
    const url = new URL(request.url);
    const token = await this.expectedToken(pin);
    const cookie = request.headers.get("Cookie") || "";
    const m = cookie.match(/(?:^|;\s*)td_rt_auth=([a-f0-9]+)/);
    if (m && m[1] === token) return { ok: true };

    const setCookie = `td_rt_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;

    // 兜底通道: ?k=TOKEN → 直接放行并补种 cookie（对抗个别手机浏览器不存 cookie）
    if (url.searchParams.get("k") === token) {
      return { ok: true, viaK: true, setCookie };
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await this.loginBlocked(ip)) {
      return { ok: false, response: noStore(new Response("失败次数过多，请 1 分钟后再试", { status: 429 })) };
    }

    // PIN 表单提交
    if (request.method === "POST" && url.pathname === "/__login") {
      let form;
      try { form = await request.formData(); } catch (e) { form = null; }
      if (form && String(form.get("pin")).trim() === pin) {
        return { ok: false, response: noStore(new Response(null, { status: 302, headers: { Location: "/?k=" + token, "Set-Cookie": setCookie } })) };
      }
      await this.recordLoginFail(ip);
      return { ok: false, response: noStore(loginPage("PIN 不对，再试一次")) };
    }

    return { ok: false, response: noStore(loginPage("")) };
  }
}

function noStore(resp) {
  try { resp.headers.set("Cache-Control", "no-store"); } catch (e) {}
  return resp;
}

function patchedResponse(resp, token) {
  // 经 ?k= 进入且无 cookie 时: 注入补丁，页面的所有 fetch/XHR/EventSource 自动携带 k 令牌
  const patch = `<script>(function(){var K=${JSON.stringify(token)};
function addK(u){try{
if(typeof u!=="string"||!u)return u;
if(/[?&]k=/.test(u))return u;
if(u.indexOf("http")===0||u.indexOf("//")===0){
  try{var a=document.createElement("a");a.href=u;if(a.host!==location.host)return u;}catch(e){return u;}
}
return u+(u.indexOf("?")<0?"?":"&")+"k="+K;
}catch(e){return u;}}
var f=window.fetch;
window.fetch=function(i,init){try{
if(typeof i==="string")i=addK(i);
else if(i&&i.url)i=new Request(addK(i.url),i);
}catch(e){}
return f.call(this,i,init);};
var x=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=addK(u);}catch(e){}return x.apply(this,arguments);};
if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,c){return new E(addK(u),c);};}
if("serviceWorker" in navigator){try{navigator.serviceWorker.register("/__sw.js?k="+encodeURIComponent(K),{scope:"/",updateViaCache:"none"}).catch(function(){});}catch(e){}}
})();</script>`;
  return new HTMLRewriter()
    .on("head", { element(el) { el.prepend(patch, { html: true }); } })
    .transform(resp);
}

function loginPage(error) {
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全入口</title>
<style>
  body{font-family:-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e8e8ea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d24;border:1px solid #2a2e38;border-radius:14px;padding:32px 28px;width:300px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:17px;margin:0 0 6px}
  p{color:#9aa0aa;font-size:13px;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2e38;color:#e8e8ea;padding:12px;border-radius:9px;font-size:16px;letter-spacing:2px;text-align:center}
  button{width:100%;margin-top:14px;background:#4f7cff;border:0;color:#fff;padding:12px;border-radius:9px;font-size:15px;cursor:pointer}
  .err{color:#ff6b6b;font-size:13px;margin-top:10px;text-align:center}
</style></head><body>
<form class="card" method="POST" action="/__login">
  <h1>🔒 TunnelDock 安全入口</h1><p>输入 PIN 码解锁</p>
  <input name="pin" autocomplete="off" autofocus placeholder="PIN">
  ${error ? `<div class="err">${error}</div>` : ""}
  <button type="submit">进入</button>
</form></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
