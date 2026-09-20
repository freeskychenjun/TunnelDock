<#
  TunnelDock M1 E2E 验证（在 DSH 会话里跑会自动清 NODE_OPTIONS）
  链路：demo 服务(4590) → TunnelDock 发布 → 公网地址 → 模拟手机（登录→页面→WS 101）→ 反向验证（错误 PIN 限速）
  用法：powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
#>
$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = ''
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

# 数据隔离：开发实例走独立 userData（src/main/index.ts 识别此环境变量）。
# Windows 大小写不敏感，%APPDATA%\TunnelDock 与 \tunneldock 是同一目录——
# 不隔离的话 e2e 会和安装版共用 services.json，曾把安装版唯一一份配置删掉。
$env:TUNNELDOCK_USER_DATA = Join-Path $env:TEMP 'td-e2e-userdata'

# 只杀父进程已死的 cloudflared（上次 e2e 异常退出的残留）。
# 正在被其他实例持有的（父进程活着）绝不能动——无差别 Get-Process cloudflared 曾误杀安装版的线上隧道。
function Invoke-KillOrphanCloudflared {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# 任何失败路径都要清干净（否则残留 electron/cloudflared 会卡住后续运行）
function Invoke-Cleanup {
  Invoke-KillOrphanCloudflared
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*tunneldock*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -State Listen -LocalPort 4590 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}
trap { Invoke-Cleanup; "❌ E2E 失败：$($_.Exception.Message)"; exit 1 }

"=== 0) 清残留（上次运行的进程 / 数据） ==="
Invoke-KillOrphanCloudflared
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*tunneldock*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path $env:TUNNELDOCK_USER_DATA) { Remove-Item $env:TUNNELDOCK_USER_DATA -Recurse -Force }
"已清理（只动 e2e 自己的临时数据与孤儿进程，不碰安装版）"

"=== 1) 构建 ==="
# PS5.1 坑：EAP=Stop 时对原生命令用 2>&1 会把 stderr 警告升级成终止错误，这里只看退出码
$ErrorActionPreference = 'Continue'
npm run build *> $null
$buildCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($buildCode -ne 0) { throw "构建失败（exit $buildCode）" }
"构建 OK"

"=== 2) 起 demo 服务 ==="
$demo = Start-Process node -ArgumentList 'scripts\demo-server.cjs' -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\td-demo.log" -RedirectStandardError "$env:TEMP\td-demo.err.log"
Start-Sleep -Seconds 2
if ($demo.HasExited) { throw "demo 服务启动失败：$(Get-Content "$env:TEMP\td-demo.err.log" -Raw)" }

"=== 3) 起 TunnelDock 并自动发布 ==="
$appLog = "$env:TEMP\td-e2e.log"
Remove-Item $appLog -ErrorAction SilentlyContinue
$app = Start-Process (Join-Path $proj 'node_modules\electron\dist\electron.exe') -ArgumentList 'out\main\index.js', '--publish-demo', '4590', '--demo-pin', 'e2etest' -PassThru -WindowStyle Hidden -RedirectStandardOutput $appLog -RedirectStandardError "$env:TEMP\td-e2e.err.log"

$url = $null; $pin = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $appLog) {
    $t = Get-Content $appLog -Raw -ErrorAction SilentlyContinue
    # E2E_URL2 同样接受：首个随机域名可能因运营商 DNS 抽风探活失败，应用会自动
    # 降级 http2 换域名重试——成功的地址打的是第二个标记（断线重连也用它，靠 URL 不同区分）
    $u = [regex]::Match($t, 'E2E_URL(?:2)?=(https://[a-z0-9]+(-[a-z0-9]+){2,}\.trycloudflare\.com)').Groups[1].Value
    $p = [regex]::Match($t, 'E2E_PIN=(\S+)').Groups[1].Value
    if ($u) { $url = $u; $pin = $p; break }
    if ($t -match 'E2E_FAIL=') { throw "发布失败：$t" }
  }
  if ($app.HasExited) { throw "应用提前退出：$(Get-Content "$env:TEMP\td-e2e.err.log" -Raw)" }
}
if (-not $url) { throw '90 秒内未拿到公网地址' }
"公网地址: $url  口令: $pin"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$cc = New-Object System.Net.CookieContainer
function Send($method, $uri, $body) {
  # 运营商 DNS 对 trycloudflare 随机子域抽风：偶发超时（WebException.Response 为 null）。
  # 重试 3 次仍无响应则返回 Code=0，由末尾断言统一判失败，而不是在这里对 null 调方法崩掉
  $resp = $null
  for ($try = 1; $try -le 3; $try++) {
    $r = [System.Net.HttpWebRequest]::Create($uri); $r.Method = $method; $r.AllowAutoRedirect = $false; $r.CookieContainer = $cc; $r.Timeout = 25000
    if ($body) { $r.ContentType = 'application/x-www-form-urlencoded'; $b = [Text.Encoding]::UTF8.GetBytes($body); $r.ContentLength = $b.Length; $s = $r.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close() }
    try { $resp = $r.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response }
    if ($resp) { break }
    if ($try -lt 3) { Start-Sleep -Seconds 5 }
  }
  if (-not $resp) { return @{ Code = 0; Body = '' } }
  $code = [int]$resp.StatusCode
  $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $bd = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
  @{ Code = $code; Body = $bd }
}

"=== 4) 模拟手机访问 ==="
$a = Send 'GET' $url $null
"[1] 未认证: HTTP $($a.Code) 登录页=" + ($a.Body -match 'TunnelDock 保护的服务')
$b = Send 'POST' "$url/_td_auth" "pin=$pin&next=%2F"
"[2] 口令登录（自定义口令）: HTTP $($b.Code)"
$c = Send 'GET' $url $null
"[3] 带会话取页面: HTTP $($c.Code) 是 demo 页=" + ($c.Body -match 'TunnelDock E2E Demo')

$cookieHeader = ($cc.GetCookies([Uri]$url) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '
$host_ = ([uri]$url).Host
$tcp = New-Object System.Net.Sockets.TcpClient($host_, 443)
$ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, ([System.Net.Security.RemoteCertificateValidationCallback] { $true }))
$ssl.AuthenticateAsClient($host_)
$rnd = New-Object byte[] 16; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rnd)
$req = "GET /ws HTTP/1.1`r`nHost: $host_`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $([Convert]::ToBase64String($rnd))`r`nSec-WebSocket-Version: 13`r`nCookie: $cookieHeader`r`n`r`n"
$bytes = [Text.Encoding]::ASCII.GetBytes($req); $ssl.Write($bytes, 0, $bytes.Length); $ssl.Flush(); Start-Sleep -Milliseconds 2000
$buf = New-Object byte[] 256; $n = 0
try { $ssl.ReadTimeout = 5000; $n = $ssl.Read($buf, 0, 256) } catch {}
$wsLine = if ($n -gt 0) { ([Text.Encoding]::ASCII.GetString($buf, 0, $n).Split("`r`n"))[0] } else { '(无响应)' }
"[4] WebSocket: $wsLine"
$ssl.Close(); $tcp.Close()

"=== 5) 错误 PIN 限速（5 次后应 429） ==="
$cc2 = New-Object System.Net.CookieContainer
$last = 0
for ($i = 1; $i -le 6; $i++) {
  $r = [System.Net.HttpWebRequest]::Create("$url/_td_auth"); $r.Method = 'POST'; $r.AllowAutoRedirect = $false; $r.CookieContainer = $cc2; $r.Timeout = 15000
  $r.ContentType = 'application/x-www-form-urlencoded'
  $bd2 = [Text.Encoding]::UTF8.GetBytes("pin=00000000&next=%2F"); $r.ContentLength = $bd2.Length
  $s2 = $r.GetRequestStream(); $s2.Write($bd2, 0, $bd2.Length); $s2.Close()
  try { $resp2 = $r.GetResponse() } catch [System.Net.WebException] { $resp2 = $_.Exception.Response }
  if ($resp2) { $last = [int]$resp2.StatusCode; $resp2.Close() } else { $last = -1 }
}
"[5] 第 6 次错误口令: HTTP $last （429 = 限速生效）"

"=== 6) 断线自动重连（只杀本实例名下的 cloudflared，不动其他实例） ==="
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.ParentProcessId -eq $app.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$url2 = $null
for ($i = 0; $i -lt 75; $i++) {
  Start-Sleep -Seconds 2
  $t2 = Get-Content $appLog -Raw -ErrorAction SilentlyContinue
  $u2 = [regex]::Match($t2, 'E2E_URL2=(https://[a-z0-9]+(-[a-z0-9]+){2,}\.trycloudflare\.com)').Groups[1].Value
  if ($u2 -and $u2 -ne $url) { $url2 = $u2; break }
}
if (-not $url2) { throw '杀掉 cloudflared 后 150 秒内未自动重连' }
"[6] 自动重连成功，新地址: $url2"
$r3 = [System.Net.HttpWebRequest]::Create($url2); $r3.AllowAutoRedirect = $false; $r3.Timeout = 20000
$p3 = $null
try { $p3 = $r3.GetResponse() } catch [System.Net.WebException] { $p3 = $_.Exception.Response }
if ($p3) { $code3 = [int]$p3.StatusCode; $p3.Close() } else { $code3 = 0 }
"[6] 新地址未认证: HTTP $code3 （200 = 登录墙在线）"
$reconnectOk = ($code3 -eq 200)

"=== 7) 清理 ==="
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Stop-Process -Id $demo.Id -Force -ErrorAction SilentlyContinue
Invoke-Cleanup
# 数据也要清：publishDemo 会把 e2e-demo 写进独立 userData（见顶部 TUNNELDOCK_USER_DATA），
# 不清的话下次 e2e 会对着 4590 端口（已无服务）白跑一轮重连
if (Test-Path $env:TUNNELDOCK_USER_DATA) { Remove-Item $env:TUNNELDOCK_USER_DATA -Recurse -Force }

$pass = ($a.Code -eq 200) -and ($b.Code -eq 303) -and ($c.Code -eq 200) -and ($wsLine -match '101') -and ($last -eq 429) -and $reconnectOk
""
if ($pass) { "✅ E2E 全部通过" } else { "❌ 有未通过项，见上" }
exit $(if ($pass) { 0 } else { 1 })
