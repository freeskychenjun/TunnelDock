// E2E 演示服务：HTTP 页面 + WebSocket 回声（端口 4590）
'use strict'
const http = require('http')
const { WebSocketServer } = require('ws')

const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>TunnelDock E2E Demo</title></head>
<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center"><h1>🎯 TunnelDock E2E Demo</h1><p>HTTP 通过：这个页面来自内网演示服务</p><p id="ws">WS 测试中…</p></div>
<script>const w=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
w.onopen=()=>w.send('ping-from-browser');
w.onmessage=e=>document.getElementById('ws').textContent='WS 通过：'+e.data;
w.onerror=()=>document.getElementById('ws').textContent='WS 失败';</script></body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

const wss = new WebSocketServer({ server: server, path: '/ws' })
wss.on('connection', (ws) => {
  ws.on('message', (m) => ws.send(`echo:${m}`))
})

server.listen(4590, '127.0.0.1', () => console.log('demo-server: http://127.0.0.1:4590 (ws: /ws)'))
