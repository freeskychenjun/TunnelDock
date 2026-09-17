<#
  TunnelDock M1 E2E 验证（在 DSH 会话里跑会自动清 NODE_OPTIONS）
  链路：demo 服务(4590) → TunnelDock 发布 → 公网地址 → 模拟手机（登录→页面→WS 101）→ 反向验证（错误 PIN 限速）
  用法：powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
#>
$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = ''
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

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
$app = Start-Process (Join-Path $proj 'node_modules\electron\dist\electron.exe') -ArgumentList 'out\main\index.js', '--publish-demo', '4590' -PassThru -WindowStyle Hidden -RedirectStandardOutput $appLog -RedirectStandardError "$env:TEMP\td-e2e.err.log"

$url = $null; $pin = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $appLog) {
    $t = Get-Content $appLog -Raw -ErrorAction SilentlyContinue
    $u = [regex]::Match($t, 'E2E_URL=(https://[a-z0-9-]+\.trycloudflare\.com)').Groups[1].Value
    $p = [regex]::Match($t, 'E2E_PIN=(\d{8})').Groups[1].Value
    if ($u) { $url = $u; $pin = $p; break }
    if ($t -match 'E2E_FAIL=') { throw "发布失败：$t" }
  }
  if ($app.HasExited) { throw "应用提前退出：$(Get-Content "$env:TEMP\td-e2e.err.log" -Raw)" }
}
if (-not $url) { throw '90 秒内未拿到公网地址' }
"公网地址: $url  PIN: $pin"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$cc = New-Object System.Net.CookieContainer
function Send($method, $uri, $body) {
  $r = [System.Net.HttpWebRequest]::Create($uri); $r.Method = $method; $r.AllowAutoRedirect = $false; $r.CookieContainer = $cc; $r.Timeout = 25000
  if ($body) { $r.ContentType = 'application/x-www-form-urlencoded'; $b = [Text.Encoding]::UTF8.GetBytes($body); $r.ContentLength = $b.Length; $s = $r.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close() }
  try { $resp = $r.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response }
  $code = [int]$resp.StatusCode
  $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $bd = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
  @{ Code = $code; Body = $bd }
}

"=== 4) 模拟手机访问 ==="
$a = Send 'GET' $url $null
"[1] 未认证: HTTP $($a.Code) 登录页=" + ($a.Body -match 'TunnelDock 保护的服务')
$b = Send 'POST' "$url/_td_auth" "pin=$pin&next=%2F"
"[2] PIN 登录: HTTP $($b.Code) → $($b.Location)"
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
  $last = [int]$resp2.StatusCode; $resp2.Close()
}
"[5] 第 6 次错误 PIN: HTTP $last （429 = 限速生效）"

"=== 6) 清理 ==="
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Stop-Process -Id $demo.Id -Force -ErrorAction SilentlyContinue
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$pass = ($a.Code -eq 200) -and ($b.Code -eq 303) -and ($c.Code -eq 200) -and ($wsLine -match '101') -and ($last -eq 429)
""
if ($pass) { "✅ E2E 全部通过" } else { "❌ 有未通过项，见上" }
exit $(if ($pass) { 0 } else { 1 })
