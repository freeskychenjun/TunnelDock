<script setup lang="ts">
const td = (window as unknown as { tunneldock: { platform: string; versions: Record<string, string> } }).tunneldock
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <span class="logo">⚓</span>
      <span class="title">TunnelDock <small>隧道坞</small></span>
      <span class="ver">v{{ td.versions.app }} · M0 骨架</span>
    </header>
    <main class="body">
      <div class="placeholder">
        <p class="big">工程骨架已就绪</p>
        <p>下一步（M1）：服务发布全链路 —— 选端口 → PIN 反代 → cloudflared 隧道 → 二维码</p>
        <p class="env">
          Electron {{ td.versions.electron }} · Node {{ td.versions.node }} · Chromium {{ td.versions.chrome }} ·
          {{ td.platform }}
        </p>
      </div>
    </main>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body {
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
}
.shell { height: 100%; display: flex; flex-direction: column; }
.topbar {
  display: flex; align-items: baseline; gap: 10px;
  padding: 14px 20px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
}
.logo { font-size: 20px; }
.title { font-size: 18px; font-weight: 600; }
.title small { color: #94a3b8; font-weight: 400; margin-left: 6px; }
.ver { margin-left: auto; color: #64748b; font-size: 12px; }
.body { flex: 1; display: flex; align-items: center; justify-content: center; }
.placeholder { text-align: center; line-height: 2; color: #94a3b8; }
.big { font-size: 20px; color: #e2e8f0; }
.env { font-size: 12px; color: #475569; margin-top: 12px; }
</style>
