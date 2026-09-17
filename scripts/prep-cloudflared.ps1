<#
  把本机现成的 cloudflared 复制进 resources/（打包内置用；该文件不入 git）
  来源优先级：TUNNELDOCK_CLOUDFLARED 环境变量 → C:\Users\Administrator\.cloudflared\cloudflared.exe
#>
$ErrorActionPreference = 'Stop'
$dst = Join-Path $PSScriptRoot '..\resources\cloudflared.exe'
$src = $env:TUNNELDOCK_CLOUDFLARED
if (-not $src -or -not (Test-Path $src)) { $src = 'C:\Users\Administrator\.cloudflared\cloudflared.exe' }
if (-not (Test-Path $src)) { throw "找不到 cloudflared：$src（可设 TUNNELDOCK_CLOUDFLARED 指定）" }
Copy-Item $src $dst -Force
$v = & $dst --version 2>&1 | Select-Object -First 1
"已内置: $dst  $v"
