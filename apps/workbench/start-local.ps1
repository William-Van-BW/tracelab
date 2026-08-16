param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$userProfilePath = [Environment]::GetFolderPath("UserProfile")
$bundledRuntimeRoot = Join-Path $userProfilePath ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$bundledNodeBin = Join-Path $bundledRuntimeRoot "node\bin"
$bundledPnpm = Join-Path $bundledRuntimeRoot "bin\fallback\pnpm.cmd"

Push-Location $projectRoot
try {
  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpmCommand) {
    $pnpmExecutable = $pnpmCommand.Source
  } elseif (Test-Path $bundledPnpm) {
    if (Test-Path $bundledNodeBin) {
      $env:Path = "$bundledNodeBin;$env:Path"
    }
    $pnpmExecutable = $bundledPnpm
  } else {
    throw "pnpm was not found. Install Node.js 22 LTS and reopen PowerShell, or run this script inside the Codex desktop environment."
  }

  & $pnpmExecutable install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  # 0.0.0.0 覆盖本机、局域网和 Tailscale：同一个监听端口，三条路都能进来。
  # 防火墙没放行时局域网/Tailscale 会连不上，用 scripts\Open-FirewallPorts.ps1 放行一次即可。
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
      Select-Object -ExpandProperty IPAddress)

  Write-Host ""
  Write-Host "TraceLab 工作台监听 0.0.0.0:$Port，可用下列地址访问：" -ForegroundColor Green
  Write-Host "  http://localhost:$Port"
  foreach ($ip in $addresses) {
    $tag = if ($ip -like "100.*") { "  （Tailscale）" } else { "" }
    Write-Host "  http://${ip}:$Port$tag"
  }

  # 本机代理若不放行这些地址，按局域网 / Tailscale 地址访问会得到 502——
  # 请求被送进代理，代理够不到私网和 tailnet 地址。dev 进程自身已在
  # vite.config.ts 里把本机地址补进 NO_PROXY；客户端（Mac 浏览器、被测 Agent）
  # 那边的代理需要各自放行。
  $proxy = $env:HTTP_PROXY, $env:HTTPS_PROXY, $env:http_proxy, $env:https_proxy | Where-Object { $_ } | Select-Object -First 1
  if ($proxy) {
    $bypass = ($env:NO_PROXY, $env:no_proxy | Where-Object { $_ } | Select-Object -First 1)
    $missing = @($addresses | Where-Object { $bypass -notlike "*$_*" })
    if ($missing.Count -gt 0) {
      Write-Host ""
      Write-Host "提醒：检测到代理 $proxy，但 NO_PROXY 未包含本机地址 $($missing -join '、')。" -ForegroundColor Yellow
      Write-Host "      从其它机器或按内网地址访问时，请求会被代理吞掉并返回 502。" -ForegroundColor Yellow
      Write-Host "      请在客户端代理（Clash 等）的直连/绕过规则里加上这些网段：" -ForegroundColor Yellow
      Write-Host "        localhost, 127.0.0.1, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10"
    }
  }
  Write-Host ""

  & $pnpmExecutable dev -- --hostname 0.0.0.0 --port $Port
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
